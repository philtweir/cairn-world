// Read one composed view back through Alizarin's ORM and write { manifest, entities } as JSON.
// Run as its own process (see build.mjs): the ORM's caches are global, and one resource id
// carries different data in different views.
//
//   node src/read-view.mjs <dist/data> <view> <out.json>

import fs from 'node:fs';
import path from 'node:path';
import * as A from 'alizarin/inline-full';
import { readEntities } from './world-read.mjs';

const [data, view, out] = process.argv.slice(2);
const p = f => path.join(data, f);
const index = JSON.parse(fs.readFileSync(p(`views/${view}/index.json`), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(p(`views/${view}/manifest.json`), 'utf8'));

await A.wasmReady;
const client = new A.client.ArchesClientLocal({
  allGraphFile: () => p('graphs.json'),
  graphToGraphFile: meta => p(`graphs/${meta.graphid}.json`),
  graphIdToGraphFile: id => p(`graphs/${id}.json`),
  graphIdToResourcesFiles: id => (index[id] ?? []).map(p),
  resourceIdToFile: id => p(`views/${view}/resources/${id}.json`),
  collectionIdToFile: id => p(`collections/${id}.json`),
});
A.graphManager.archesClient = client;
A.staticStore.archesClient = client;
A.RDM.archesClient = client;
await A.graphManager.initialize();

const entities = await readEntities(A.graphManager, manifest);
fs.writeFileSync(out, JSON.stringify({ manifest, entities }));
