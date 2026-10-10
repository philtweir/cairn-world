// Bundle the browser explorer (explorer/ + Alizarin's WASM ORM) into the site root, dist/.

import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

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
  // Alizarin resolves its WASM relative to the bundle (new URL('alizarin_bg.wasm', import.meta.url)).
  fs.copyFileSync(path.join(root, 'node_modules/alizarin/dist/alizarin_bg.wasm'), path.join(out, 'alizarin_bg.wasm'));
  fs.writeFileSync(path.join(out, '.nojekyll'), '');
  fs.copyFileSync(path.join(root, 'explorer', 'style.css'), path.join(out, 'style.css'));
  const html = fs.readFileSync(path.join(root, 'explorer', 'index.html'), 'utf8')
    .replace('href="style.css"', `href="style.css?v=${version}"`).replace('src="app.js"', `src="app.js?v=${version}"`);
  fs.writeFileSync(path.join(out, 'index.html'), html);
}
