// The ontology the models are written in: CIDOC-CRM 7.1.3 (the FORTH RDFS implementation,
// vendored in ontology/), plus the terms declared in ontology/extensions.csv for anything
// outside it. A model may only use classes and properties found here, and every field must
// respect its property's domain and range, so the interface can rely on the ontology alone.

import fs from 'node:fs';
import path from 'node:path';
import { parseCsv } from './csv.mjs';
import { CRM, ancestors } from './lenses.mjs';

export { CRM, ancestors };

const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
export const LITERAL = `${RDFS}Literal`;
// "E60 Number", "E62 String" and the other primitives are rdfs:Literal in the RDFS.
const PRIMITIVES = ['E59_Primitive_Value', 'E60_Number', 'E61_Time_Primitive', 'E62_String', 'E94_Space_Primitive', 'E95_Spacetime_Primitive'].map(c => CRM + c);

const attr = (block, tag) => [...block.matchAll(new RegExp(`<${tag} rdf:resource="([^"]+)"`, 'g'))].map(m => m[1]);
const enLabel = block => (/<rdfs:label xml:lang="en">([^<]+)<\/rdfs:label>/.exec(block) ?? [])[1];
const firstSentence = block => {
  const c = (/<rdfs:comment>([\s\S]*?)<\/rdfs:comment>/.exec(block) ?? [])[1] ?? '';
  return (/^[\s\S]*?\.(?=\s|$)/.exec(c.trim()) ?? [c.trim()])[0].replace(/\s+/g, ' ');
};

// { classes: { uri: { label, parents[], comment } }, properties: { uri: { label, domain, range, parents[], inverse } } }
export function loadOntology(root, expand) {
  const xml = fs.readFileSync(path.join(root, 'ontology/cidoc_crm_v7.1.3.rdfs'), 'utf8');
  const abs = s => (/^https?:/.test(s) ? s : CRM + s);
  const classes = {}, properties = {};
  for (const [, about, block] of xml.matchAll(/<rdfs:Class rdf:about="([^"]+)">([\s\S]*?)<\/rdfs:Class>/g)) {
    classes[abs(about)] = { label: enLabel(block), parents: attr(block, 'rdfs:subClassOf').map(abs), comment: firstSentence(block), source: 'CIDOC-CRM 7.1.3' };
  }
  for (const [, about, block] of xml.matchAll(/<rdf:Property rdf:about="([^"]+)">([\s\S]*?)<\/rdf:Property>/g)) {
    properties[abs(about)] = {
      label: enLabel(block), domain: attr(block, 'rdfs:domain').map(abs)[0], range: attr(block, 'rdfs:range').map(abs)[0],
      parents: attr(block, 'rdfs:subPropertyOf').map(abs), inverse: attr(block, 'owl:inverseOf').map(abs)[0] ?? null, source: 'CIDOC-CRM 7.1.3',
    };
  }
  for (const p of PRIMITIVES) classes[p] ??= { label: p.slice(CRM.length).replace(/^E\d+_/, '').replace(/_/g, ' '), parents: [], literal: true, source: 'CIDOC-CRM 7.1.3' };
  const problems = [];
  const [header, ...rows] = parseCsv(fs.readFileSync(path.join(root, 'ontology/extensions.csv'), 'utf8'));
  rows.forEach((cells, i) => {
    const r = Object.fromEntries(header.map((h, j) => [h, cells[j] ?? '']));
    const where = `ontology/extensions.csv:${i + 2}`;
    const term = expand(r.term);
    if (r.kind === 'class') {
      // A class from another ontology must say where it sits in CRM, or no view could place it.
      if (!r.parent) problems.push(`${where} class ${r.term} needs a CRM parent class`);
      classes[term] = { label: r.label, parents: r.parent ? r.parent.split('|').map(expand) : [], comment: r.comment, source: 'extension' };
    } else if (r.kind === 'property') {
      if (!r.domain || !r.range) problems.push(`${where} property ${r.term} needs a domain and a range`);
      properties[term] = { label: r.label, domain: expand(r.domain), range: expand(r.range), parents: r.parent ? r.parent.split('|').map(expand) : [], inverse: null, comment: r.comment, source: 'extension' };
    } else problems.push(`${where} kind must be "class" or "property"`);
  });
  return { classes, properties, problems };
}

export const isA = (ontology, cls, of) => cls === of || of === CRM + 'E1_CRM_Entity' || ancestors(ontology, cls).has(of);
const isLiteral = (ontology, cls) => cls === LITERAL || ontology.classes[cls]?.literal;

// Check one field: its class exists, its property exists, and parent/field/targets respect the
// property's domain and range. Returns problem strings.
export function checkField(ontology, { parentClass, cls, property, targetClasses = [] }) {
  const out = [];
  const p = ontology.properties[property], c = ontology.classes[cls];
  if (!c) out.push(`class ${cls} is not in CIDOC-CRM 7.1.3 or ontology/extensions.csv`);
  if (!p) { out.push(`property ${property} is not in CIDOC-CRM 7.1.3 or ontology/extensions.csv`); return out; }
  if (p.domain && !isA(ontology, parentClass, p.domain)) out.push(`${short(property)} needs its subject to be ${short(p.domain)}, but ${short(parentClass)} is not`);
  if (p.range && c) {
    if (isLiteral(ontology, p.range)) { if (!c.literal) out.push(`${short(property)} takes a literal (E62 String, E60 Number...), not ${short(cls)}`); }
    else if (!c.literal && !isA(ontology, cls, p.range)) out.push(`${short(property)} needs its value to be ${short(p.range)}, but ${short(cls)} is not`);
  }
  for (const t of targetClasses) if (p.range && !isLiteral(ontology, p.range) && !isA(ontology, t, p.range)) out.push(`${short(property)} links to ${short(t)}, which is not ${short(p.range)}`);
  return out;
}
export const short = uri => (String(uri).startsWith(CRM) ? uri.slice(CRM.length) : String(uri).replace(/^.*[/#]/, ''));
