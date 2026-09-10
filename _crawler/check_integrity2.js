'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('output/state.db', { readOnly: true, timeout: 10000 });
const docs = db.prepare("SELECT url, rel_dir, docid, channel FROM docs WHERE status='done'").all();
let missingTxt = [], missingHtml = 0;
for (const d of docs) {
  if (!d.rel_dir) { console.log('done doc WITHOUT rel_dir:', d.url); continue; }
  const base = path.join('output', 'pingtan', d.rel_dir);
  if (!fs.existsSync(path.join(base, 'page.txt'))) missingTxt.push(d.url + ' rel=' + d.rel_dir);
  if (!fs.existsSync(path.join(base, 'page.html')) && !fs.existsSync(path.join(base, 'attachments'))) { /* binary docs have no page.html but have attachments */ }
  if (!fs.existsSync(path.join(base, 'page.html')) && !fs.existsSync(path.join(base, 'attachments', 'file'))) { missingHtml++; if (missingHtml < 4) console.log('no html & no attachment dir:', d.url); }
}
console.log('done docs checked:', docs.length, '| missing page.txt:', missingTxt.length, '| neither html nor binary-file:', missingHtml);
missingTxt.slice(0, 5).forEach(x => console.log('  MISS', x));
// find the orphan page.txt on disk not matching any done doc
const rels = new Set(docs.filter(d => d.rel_dir).map(d => d.rel_dir.replace(/\\/g, '/')));
let orphans = [];
function walk(dir, rel) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    const f = path.join(dir, e.name);
    const r2 = rel + '/' + e.name;
    if (e.isDirectory()) walk(f, r2);
    else if (e.name === 'page.txt') { const parent = rel.split('/').slice(0, -2).join('/'); if (!rels.has(parent) && !rels.has(r2.replace(/\/page\.txt$/, ''))) orphans.push(rel); }
  }
}
walk(path.join('output', 'pingtan'), '');
console.log('orphan page.txt dirs:', orphans.length);
orphans.slice(0, 5).forEach(o => console.log('  ', o));