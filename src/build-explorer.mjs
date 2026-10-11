// Bundle the browser explorer (explorer/ + Alizarin's WASM ORM) into the site root, dist/.

import fs from 'node:fs';
import path from 'node:path';
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

// `version` (the data build hash) is added to the page's script and stylesheet URLs, so a new
// deploy's page never runs a cached older bundle.
export async function buildExplorer(root, dist, version) {
  const out = dist;
  fs.mkdirSync(out, { recursive: true });
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
    logLevel: 'warning',
  });
  // The query engine for filters (explorer/query-engine.mjs), a bundle of its own that the
  // explorer imports only when a filter is first used, with the Rós Madair compiler's WASM and
  // duckdb-wasm's (the exception-handling build, and its worker).
  await build({
    entryPoints: [path.join(root, 'explorer/query-engine.mjs')],
    outfile: path.join(out, 'query-engine.js'),
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, logLevel: 'warning',
  });
  fs.copyFileSync(path.join(root, 'node_modules/ros-madair/ros_madair_wasm_bg.wasm'), path.join(out, 'ros_madair_wasm_bg.wasm'));
  fs.mkdirSync(path.join(out, 'duckdb'), { recursive: true });
  for (const f of ['duckdb-eh.wasm', 'duckdb-browser-eh.worker.js']) fs.copyFileSync(path.join(root, 'node_modules/@duckdb/duckdb-wasm/dist', f), path.join(out, 'duckdb', f));
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
