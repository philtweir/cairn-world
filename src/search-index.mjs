// Search and filtering that do not need the whole view loaded: for each open view, a Rós Madair
// substrate (structured filters) and a Pagefind index (text), both static files the browser reads
// only the parts of that a query needs. The explorer joins the two on resource ids.
//
//   dist/data/views/<view>/substrate/  `ros-madair-emit` over the view's graphs and resources:
//     tiles_/concepts_/ordered_/edges_<graphid>.parquet and manifest.json. The explorer compiles a
//     filter (Rós Madair's query IR) to DuckDB SQL with the `ros-madair` npm compiler and runs it
//     with duckdb-wasm, which range-reads the row groups it needs.
//   dist/data/views/<view>/pagefind/   a Pagefind index of every entry's text (its name, and every
//     text value in its tiles), one record per entry, its meta carrying the entry's id and model.
//
// A view behind a password gate gets neither. The gate only keeps casual visitors out (its data is
// published like any other), but an index would make what it holds easy to find without passing it.
//
// The emitter is Rós Madair's release binary for the same version as the `ros-madair` package (one
// compiler, two consumers: they must agree), fetched once into .cache/ros-madair/<version>/, or
// $ROS_MADAIR_EMIT.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as pagefind from 'pagefind';

function emitter(root) {
  if (process.env.ROS_MADAIR_EMIT) return process.env.ROS_MADAIR_EMIT;
  const version = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/ros-madair/package.json'), 'utf8')).version;
  const bin = path.join(root, '.cache', 'ros-madair', version, 'ros-madair-emit');
  if (!fs.existsSync(bin)) {
    if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error(`no ros-madair-emit release binary for ${process.platform}-${process.arch}: build it (cargo install ros-madair-emit --version ${version}) and set ROS_MADAIR_EMIT`);
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    console.log(`fetching ros-madair-emit ${version}`);
    execFileSync('curl', ['-sfL', '--retry', '3', '-o', `${bin}.part`, `https://github.com/flaxandteal/ros-madair/releases/download/v${version}/ros-madair-emit-linux-amd64`]);
    fs.chmodSync(`${bin}.part`, 0o755);
    fs.renameSync(`${bin}.part`, bin);
  }
  return bin;
}

// Every text value in a resource's tiles: a localised string ({en: {value}}) or a plain string that
// is not an id.
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function texts(v, out) {
  if (typeof v === 'string') { if (!ID.test(v)) out.push(v); }
  else if (Array.isArray(v)) v.forEach(x => texts(x, out));
  else if (v && typeof v === 'object') {
    if (typeof v.type === 'string' && (v.features || v.coordinates || v.geometry)) return out;   // GeoJSON
    if (typeof v.value === 'string' && 'direction' in v) out.push(v.value);
    else for (const [k, x] of Object.entries(v)) if (!/^(resourceId|resourceXresourceId|ontologyProperty|inverseOntologyProperty)$/.test(k)) texts(x, out);
  }
  return out;
}

// views: [{ key, models: [{ alias, graphid }], resources: [business-data resource] }]
export async function buildSearch(root, dist, views) {
  const bin = emitter(root);
  const done = {};
  for (const v of views) {
    const out = path.join(dist, 'data', 'views', v.key);
    // The emitter reads a data_dir: graphs/ (the view's models) and resources/.
    const work = fs.mkdtempSync(path.join(os.tmpdir(), `cairn-${v.key}-`));
    try {
      fs.mkdirSync(path.join(work, 'graphs'));
      for (const m of v.models) fs.symlinkSync(path.join(dist, 'data', 'graphs', `${m.graphid}.json`), path.join(work, 'graphs', `${m.graphid}.json`));
      fs.symlinkSync(path.join(out, 'resources'), path.join(work, 'resources'));
      const sub = path.join(out, 'substrate');
      fs.rmSync(sub, { recursive: true, force: true });
      execFileSync(bin, [work, sub], { stdio: ['ignore', 'ignore', 'inherit'] });
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }

    const { index, errors } = await pagefind.createIndex({ forceLanguage: 'en' });
    if (errors.length) throw new Error(`pagefind: ${errors.join('; ')}`);
    const aliasOf = Object.fromEntries(v.models.map(m => [m.graphid, m.alias]));
    for (const r of v.resources) {
      const ri = r.resourceinstance, model = aliasOf[ri.graph_id];
      if (!model) continue;
      const content = [...new Set([ri.name, ...r.tiles.flatMap(t => texts(t.data, []))])].join('\n');
      const res = await index.addCustomRecord({
        url: `#/${v.key}/${model}/${ri.legacyid}`, content, language: 'en',
        // No Pagefind filters: it writes their values in a different order each build, and the
        // build must give the same bytes from the same data. The explorer checks meta.model.
        meta: { title: ri.name, id: ri.resourceinstanceid, model, key: ri.legacyid },
      });
      if (res.errors.length) throw new Error(`pagefind ${ri.legacyid}: ${res.errors.join('; ')}`);
    }
    const pf = path.join(out, 'pagefind');
    fs.rmSync(pf, { recursive: true, force: true });
    const w = await index.writeFiles({ outputPath: pf });
    if (w.errors.length) throw new Error(`pagefind: ${w.errors.join('; ')}`);
    await index.deleteIndex();
    done[v.key] = { substrate: `views/${v.key}/substrate/`, pagefind: `views/${v.key}/pagefind/` };
  }
  await pagefind.close();
  return done;
}
