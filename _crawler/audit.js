'use strict';
/* Full read-only integrity audit of crawled output so far:
   - DB done docs vs page.txt/page.html/links.tsv on disk
   - missing rel_dir handling
   - per top-channel coverage
   - attachment magic-byte sampling (all done file attachments would be slow; sample)
   Does NOT touch network or DB writes. */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const DATA = 'C:/Users/user/Documents/output/pingtan';
const db = new DatabaseSync('C:/Users/user/Documents/output/state.db', { readOnly: true, timeout: 10000 });

const done = db.prepare("SELECT url, rel_dir, channel, docid FROM docs WHERE status='done'").all();
let noRel = 0, missTxt = 0, missHtml = 0, missLinks = 0, ok = 0;
const missingSamples = [];
for (const d of done) {
  if (!d.rel_dir) { noRel++; continue; }
  const base = path.join(DATA, d.rel_dir);
  const t = fs.existsSync(path.join(base, 'page.txt'));
  const h = fs.existsSync(path.join(base, 'page.html'));
  const l = fs.existsSync(path.join(base, 'links.tsv'));
  if (!t) { missTxt++; if (missingSamples.length < 6) missingSamples.push('txt ' + d.rel_dir); }
  if (!h) { missHtml++; if (missingSamples.length < 6) missingSamples.push('html ' + d.rel_dir); }
  if (!l) { missLinks++; if (missingSamples.length < 6) missingSamples.push('links ' + d.rel_dir); }
  if (t && h && l) ok++;
}
console.log('AUDIT done-docs=' + done.length + ' all3files-ok=' + ok + ' noRel=' + noRel +
  ' missTxt=' + missTxt + ' missHtml=' + missHtml + ' missLinks=' + missLinks);
missingSamples.forEach(s => console.log('  MISS:', s));

// per top-level channel coverage
const top = {};
for (const d of done) {
  const seg = (d.channel || 'zwgk').split('/');
  const t = seg.length > 2 ? seg[0] + '/' + seg[1] : seg[0];
  top[t] = (top[t] || 0) + 1;
}
console.log('AUDIT top-channel done counts:');
Object.entries(top).sort((a, b) => b[1] - a[1]).forEach(([c, n]) => console.log('  ' + c + '\t' + n));

// attachment: files with kind=file done, magic byte validity over sample up to 200
const atts = db.prepare("SELECT rel_path, size FROM attachments WHERE status='done' AND kind='file' AND rel_path IS NOT NULL ORDER BY updated_at DESC LIMIT 300").all();
let pdf = 0, doc = 0, zip = 0, other = 0, broken = 0, missing = 0, checked = 0;
for (const a of atts) {
  const abs = path.join(DATA, a.rel_path);
  let head = null;
  try { const fd = fs.openSync(abs, 'r'); const b = Buffer.alloc(16); fs.readSync(fd, b, 0, 16, 0); fs.closeSync(fd); head = b; } catch (e) { missing++; continue; }
  checked++;
  const latin = head.toString('latin1');
  if (latin.startsWith('%PDF')) pdf++;
  else if (latin.startsWith('PK')) zip++;
  else if (head[0] === 0xd0 && head[1] === 0xcf) doc++;
  else if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) other++; // BOM text
  else if (/^[A-Za-z0-9]/.test(latin.trim().slice(0,1))) other++;
  else { broken++; if (broken <= 3) console.log('  ATT-odd-magic:', a.rel_path.slice(0, 110), JSON.stringify(head.slice(0,8).toString('hex'))); }
}
console.log('AUDIT file-attachments sampled=' + atts.length + ' opened=' + checked + ' missing-on-disk=' + missing +
  ' pdf=' + pdf + ' zip/doc=' + zip + '/' + doc + ' textOrOther=' + other + ' oddMagic=' + broken);
