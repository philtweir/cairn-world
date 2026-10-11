// Bundle the browser explorer (explorer/ + Alizarin's WASM ORM) into the site root, dist/.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

// Icons: Lucide (lucide-static, ISC), monochrome line icons that take the text colour. Lens icons
// are named in ontology/labels.csv (`icon`); the interface's own are listed here. Only those used
// go into dist/icons.svg, one <symbol id="i-<name>"> each; an unknown name fails the build.
const UI_ICONS = ['pencil', 'lock', 'circle', 'plus', 'minus', 'locate-fixed', 'filter'];
function buildIconSprite(root, dist) {
  const ontology = JSON.parse(fs.readFileSync(path.join(dist, 'data', 'ontology.json'), 'utf8'));
  const names = [...new Set([...UI_ICONS, ...Object.values(ontology.classes).map(c => c.icon).filter(Boolean)])].sort();
  const symbols = names.map(n => {
    const file = path.join(root, 'node_modules/lucide-static/icons', `${n}.svg`);
    if (!/^[a-z0-9-]+$/.test(n) || !fs.existsSync(file)) throw new Error(`icon "${n}" (ontology/labels.csv) is not a Lucide icon name; see https://lucide.dev/icons`);
    const inner = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(fs.readFileSync(file, 'utf8'))[1].trim();
    return `<symbol id="i-${n}" viewBox="0 0 24 24">${inner}</symbol>`;
  });
  fs.writeFileSync(path.join(dist, 'icons.svg'), `<svg xmlns="http://www.w3.org/2000/svg"><!-- Lucide icons, ISC licence: https://lucide.dev -->${symbols.join('')}</svg>\n`);
}

// The DuckDB inside @duckdb/duckdb-wasm (1.32.0 is DuckDB v1.4.3), whose extensions are fetched for
// it: change with the package.
const DUCKDB_EXTENSIONS = { version: 'v1.4.3' };

// `version` (the data build hash) is added to the page's script and stylesheet URLs, so a new
// deploy's page never runs a cached older bundle.
export async function buildExplorer(root, dist, version) {
  const out = dist;
  fs.mkdirSync(out, { recursive: true });
  // The query engine for filters (explorer/query-engine.mjs), a bundle of its own that the
  // explorer imports only when a filter is first used, with the Rós Madair compiler's WASM and
  // duckdb-wasm's (the exception-handling build, and its worker). Unlike the data, these are named
  // by their own versions (the bundle by a hash of itself), so a browser keeps them from one deploy
  // to the next until they change: a new world does not mean fetching 34 MB of DuckDB again.
  const pkg = name => JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version;
  const engineCode = (await build({
    entryPoints: [path.join(root, 'explorer/query-engine.mjs')],
    write: false, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, logLevel: 'warning',
  })).outputFiles[0].contents;
  const engine = {
    js: `query-engine.${crypto.createHash('sha1').update(engineCode).digest('hex').slice(0, 10)}.js`,
    duckdb: `duckdb/${pkg('@duckdb/duckdb-wasm')}/`,
    compiler: `ros-madair/${pkg('ros-madair')}/ros_madair_wasm_bg.wasm`,
  };
  fs.writeFileSync(path.join(out, engine.js), engineCode);
  fs.mkdirSync(path.join(out, engine.duckdb), { recursive: true });
  for (const f of ['duckdb-eh.wasm', 'duckdb-browser-eh.worker.js']) fs.copyFileSync(path.join(root, 'node_modules/@duckdb/duckdb-wasm/dist', f), path.join(out, engine.duckdb, f));
  fs.mkdirSync(path.dirname(path.join(out, engine.compiler)), { recursive: true });
  fs.copyFileSync(path.join(root, 'node_modules/ros-madair/ros_madair_wasm_bg.wasm'), path.join(out, engine.compiler));
  // DuckDB's Parquet reader is an extension duckdb-wasm fetches on first use, by default from
  // extensions.duckdb.org; served from the site instead (fetched once into .cache/), so the
  // explorer does not depend on that host. The engine uses it only if its DuckDB is the version
  // it was fetched for, and falls back to extensions.duckdb.org if it cannot be read.
  const ext = `${DUCKDB_EXTENSIONS.version}/wasm_eh/parquet.duckdb_extension.wasm`;
  const cached = path.join(root, '.cache', 'duckdb-extensions', ext);
  if (!fs.existsSync(cached)) {
    try {
      fs.mkdirSync(path.dirname(cached), { recursive: true });
      execFileSync('curl', ['-sfL', '--retry', '3', '-o', `${cached}.part`, `https://extensions.duckdb.org/${ext}`]);
      fs.renameSync(`${cached}.part`, cached);
    } catch {
      fs.rmSync(`${cached}.part`, { force: true });
      console.warn(`warning: could not fetch DuckDB's Parquet extension (${ext}); the explorer will fetch it from extensions.duckdb.org`);
    }
  }
  if (fs.existsSync(cached)) {
    engine.extensions = { version: DUCKDB_EXTENSIONS.version, repository: `${engine.duckdb}extensions` };
    fs.mkdirSync(path.dirname(path.join(out, engine.extensions.repository, ext)), { recursive: true });
    fs.copyFileSync(cached, path.join(out, engine.extensions.repository, ext));
  }

  await build({
    entryPoints: [path.join(root, 'explorer/app.js')],
    outfile: path.join(out, 'app.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    // Alizarin's Node-only paths are dynamic and never taken in a browser.
    external: ['fs', 'path', 'url', 'node:*'],
    define: { __ENGINE__: JSON.stringify(engine) },
    logLevel: 'warning',
  });
  // Alizarin resolves its WASM relative to the bundle (new URL('alizarin_bg.wasm', import.meta.url)).
  fs.copyFileSync(path.join(root, 'node_modules/alizarin/dist/alizarin_bg.wasm'), path.join(out, 'alizarin_bg.wasm'));
  fs.writeFileSync(path.join(out, '.nojekyll'), '');
  fs.copyFileSync(path.join(root, 'explorer', 'style.css'), path.join(out, 'style.css'));
  buildIconSprite(root, out);
  const html = fs.readFileSync(path.join(root, 'explorer', 'index.html'), 'utf8')
    .replace('href="style.css"', `href="style.css?v=${version}"`).replace('src="app.js"', `src="app.js?v=${version}"`)
    .replaceAll('icons.svg#', `icons.svg?v=${version}#`);
  fs.writeFileSync(path.join(out, 'index.html'), html);
}
