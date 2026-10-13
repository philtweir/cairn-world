// A scratch copy of this repository that builds one synthetic world alone (test/scale/README.md):
// every tracked file except the other layers (General stays: every world stands on it), with
// node_modules and .cache linked rather than copied, and test/scale/generate.mjs's world added.
//
//   node test/scale/workspace.mjs <N> <dir>
//
// Builds into <dir>/dist. Node's V8 now and then crashes in the build (exit 133, see
// .github/workflows/pages.yml); the build is then run once more.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [nArg, dirArg] = process.argv.slice(2);
if (!nArg || !dirArg) { console.error('usage: node test/scale/workspace.mjs <N> <dir>'); process.exit(1); }
const dir = path.resolve(dirArg);

fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean)
  .filter(f => !f.startsWith('layers/') || f.startsWith('layers/general/'));
for (const f of tracked) {
  fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
  fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
}
for (const l of ['node_modules', '.cache']) if (fs.existsSync(path.join(ROOT, l))) fs.symlinkSync(path.join(ROOT, l), path.join(dir, l));
execFileSync('node', [path.join(ROOT, 'test/scale/generate.mjs'), nArg, path.join(dir, 'layers')], { stdio: 'inherit' });

const t0 = Date.now();
for (let attempt = 1; ; attempt++) {
  const r = spawnSync('node', ['src/build.mjs'], { cwd: dir, env: { ...process.env, NODE_OPTIONS: '--experimental-wasm-modules' }, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status === 0) { console.log(r.stdout.trim().split('\n').at(-1)); break; }
  if (r.status === 133 && attempt === 1) { console.warn('V8 crashed (exit 133); building again'); continue; }
  console.error(r.stdout.slice(-2000), r.stderr.slice(-4000));
  process.exit(r.status ?? 1);
}
console.log(`built N=${nArg} in ${((Date.now() - t0) / 1000).toFixed(0)}s: ${dir}/dist`);
