// Put a password gate on a universe or campaign in the explorer, or take it off.
//
//   npm run set-password -- <layer key>            prompts for the password
//   CAIRN_PASSWORD=... npm run set-password -- <layer key>
//   npm run set-password -- <layer key> --remove
//
// Only a random salt and the salted SHA-256 are stored, in layers/<key>/layer.json. This keeps
// casual visitors out of a view; it is not access control. The layer's CSVs are in the
// repository and its data is published on the site like any other view's.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [key] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const dir = key && path.join(ROOT, 'layers', key);
if (!key || !fs.existsSync(path.join(dir, 'data'))) {
  console.error('Usage: npm run set-password -- <layer key> [--remove]   (a folder under layers/)');
  process.exit(1);
}
const file = path.join(dir, 'layer.json');
const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};

if (process.argv.includes('--remove')) {
  delete settings.gate;
} else {
  let pw = process.env.CAIRN_PASSWORD;
  if (!pw) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    pw = await rl.question(`Password for ${key}: `);
    rl.close();
  }
  if (!pw) { console.error('No password given.'); process.exit(1); }
  const salt = crypto.randomBytes(12).toString('hex');
  // A new password keeps what the gate stands for (its principal, in a closed view: src/access.mjs).
  settings.gate = { salt, sha256: crypto.createHash('sha256').update(`${salt}:${pw}`).digest('hex'), ...(settings.gate?.principal ? { principal: settings.gate.principal } : {}) };
}
if (Object.keys(settings).length) fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
else fs.rmSync(file, { force: true });
console.log(settings.gate ? `layers/${key}/layer.json: gate set. Rebuild and deploy to apply.` : `layers/${key}: gate removed.`);
