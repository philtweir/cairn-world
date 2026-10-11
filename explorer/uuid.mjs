// An entry's id from its model and slug, as Alizarin's CSV loader makes it (alizarin-core
// csv_business_data_loader: generate_uuid_v5(("resource", graph id), key), a UUID v5 of the key in
// a v5 namespace made from "resource/<graph id>" in Alizarin's own). So a link by slug needs no
// lookup. SHA-1 is done here, synchronously, because links are drawn synchronously.

const ALIZARIN_NAMESPACE = '1a79f1c8-9505-4bea-a18e-28a053f725ca';

function sha1(bytes) {
  const words = new Uint32Array(80), out = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const len = bytes.length, padded = new Uint8Array((((len + 8) >> 6) + 1) * 64);
  padded.set(bytes); padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, len * 8); view.setUint32(padded.length - 8, Math.floor(len / 0x20000000));
  for (let o = 0; o < padded.length; o += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(o + i * 4);
    for (let i = 16; i < 80; i++) { const x = words[i - 3] ^ words[i - 8] ^ words[i - 14] ^ words[i - 16]; words[i] = (x << 1) | (x >>> 31); }
    let [a, b, c, d, e] = out;
    for (let i = 0; i < 80; i++) {
      const [f, k] = i < 20 ? [(b & c) | (~b & d), 0x5a827999] : i < 40 ? [b ^ c ^ d, 0x6ed9eba1] : i < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc] : [b ^ c ^ d, 0xca62c1d6];
      const t = (((a << 5) | (a >>> 27)) + f + e + k + words[i]) >>> 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    out[0] = (out[0] + a) >>> 0; out[1] = (out[1] + b) >>> 0; out[2] = (out[2] + c) >>> 0; out[3] = (out[3] + d) >>> 0; out[4] = (out[4] + e) >>> 0;
  }
  const r = new Uint8Array(20);
  out.forEach((w, i) => new DataView(r.buffer).setUint32(i * 4, w));
  return r;
}

const parse = u => Uint8Array.from(u.replace(/-/g, '').match(/../g).map(x => parseInt(x, 16)));
const format = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');

export function uuid5(namespace, name) {
  const ns = parse(namespace), text = new TextEncoder().encode(name);
  const bytes = new Uint8Array(ns.length + text.length); bytes.set(ns); bytes.set(text, ns.length);
  const h = sha1(bytes).slice(0, 16);
  h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80;
  return format(h);
}

const spaces = new Map();
export const resourceId = (graphId, key) => uuid5(spaces.get(graphId) ?? spaces.set(graphId, uuid5(ALIZARIN_NAMESPACE, `resource/${graphId}`)).get(graphId), key);
