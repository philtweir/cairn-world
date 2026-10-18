// Put a password gate on a universe or campaign in the explorer, or take it off.
//
//   npm run set-password -- <layer key>            prompts for the password
//   CAIRN_PASSWORD=... npm run set-password -- <layer key>
//   npm run set-password -- <layer key> --remove
//   npm run set-password -- <layer key> --principal <id> [--remove]
//
// With --principal, in a closed view, the password is that principal's: viewing as it (or as any
// member of it) asks for it, and it also opens the gated principals it is a member of
// (src/access.mjs). Each principal's goes in layer.json "gates".
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
const args = process.argv.slice(2);
const at = args.indexOf('--principal');
const principal = at >= 0 ? args[at + 1] : null;
const [key] = args.filter((a, i) => !a.startsWith('--') && !(at >= 0 && i === at + 1));
const dir = key && path.join(ROOT, 'layers', key);
if (!key || !fs.existsSync(path.join(dir, 'data'))) {
  console.error('Usage: npm run set-password -- <layer key> [--principal <id>] [--remove]   (a folder under layers/)');
  process.exit(1);
}
const file = path.join(dir, 'layer.json');
const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
if (at >= 0 && !principal) { console.error('--principal needs a principal id (layers/<key>/access/principals.csv)'); process.exit(1); }
// An old single gate for a principal joins the list.
if (settings.gate?.principal) { settings.gates = [...(settings.gates ?? []).filter(g => g.principal !== settings.gate.principal), settings.gate]; delete settings.gate; }
const others = (settings.gates ?? []).filter(g => g.principal !== principal);

if (process.argv.includes('--remove')) {
  if (principal) settings.gates = others;
  else delete settings.gate;
} else {
  let pw = process.env.CAIRN_PASSWORD;
  if (!pw) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    pw = await rl.question(`Password for ${key}${principal ? ` (${principal})` : ''}: `);
    rl.close();
  }
  if (!pw) { console.error('No password given.'); process.exit(1); }
  const salt = crypto.randomBytes(12).toString('hex');
  const sha256 = crypto.createHash('sha256').update(`${salt}:${pw}`).digest('hex');
  if (principal) settings.gates = [...others, { principal, salt, sha256 }];
  else settings.gate = { salt, sha256 };
}
if (settings.gates && !settings.gates.length) delete settings.gates;
if (Object.keys(settings).length) fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
else fs.rmSync(file, { force: true });
const set = principal ? settings.gates?.some(g => g.principal === principal) : !!settings.gate;
console.log(`layers/${key}${principal ? ` (${principal})` : ''}: ${set ? 'password set' : 'password removed'}. Rebuild and deploy to apply.`);
