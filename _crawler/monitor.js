'use strict';
/* Richer periodic monitor: status + random QA of recently done docs + attachment magic-byte check.
   Varies every invocation (random samples) so repeated runs add verification value. */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('C:/Users/user/Documents/output/state.db', { readOnly: true, timeout: 8000 });
const by = {};
for (const r of db.prepare("SELECT status, COUNT(*) c FROM docs GROUP BY status").all()) by[r.status] = r.c;
const att = db.prepare("SELECT status, COUNT(*) c FROM attachments GROUP BY status").all();
const attBy = {}; att.forEach(x => attBy[x.status] = x.c);
const pj = JSON.parse(fs.readFileSync('C:/Users/user/Documents/output/progress.json', 'utf8'));
console.log('STATUS docs done=' + (by.done||0) + ' queued=' + (by.queued||0) + ' failed=' + (by.failed||0) +
  ' | att done=' + (attBy.done||0) + ' failed=' + (attBy.failed||0) +
  ' | phase=' + pj.phase + ' | chanDone=' + pj.channelsDone + '/' + pj.channelsTotal);

// QA: sample 4 random recently-done docs (varied offset)
const n = Math.floor(Math.random() * 200);
const sample = db.prepare("SELECT url, rel_dir FROM docs WHERE status='done' AND rel_dir IS NOT NULL ORDER BY fetched_at DESC LIMIT 400 OFFSET ?").all(n).slice(0, 4);
let badTxt = 0, badHtml = 0;
for (const d of sample) {
  const base = path.join('C:/Users/user/Documents/output/pingtan', d.rel_dir);
  const t = path.join(base, 'page.txt'); const h = path.join(base, 'page.html');
  let ts = -1, hs = -1;
  try { ts = fs.statSync(t).size; } catch (e) {}
  try { hs = fs.statSync(h).size; } catch (e) {}
  if (ts < 100) { badTxt++; console.log('QA BAD txt size=' + ts + ' ' + (d.rel_dir||'').slice(0,80)); }
  if (hs < 100) { badHtml++; console.log('QA BAD html size=' + hs + ' ' + (d.rel_dir||'').slice(0,80)); }
}
console.log('QA sample checked=' + sample.length + ' badTxt=' + badTxt + ' badHtml=' + badHtml);

// QA: check 3 random done file-attachments for valid magic bytes
const atts = db.prepare("SELECT rel_path FROM attachments WHERE status='done' AND kind='file' AND rel_path IS NOT NULL ORDER BY updated_at DESC LIMIT 800").all();
if (atts.length) {
  const pick = [];
  for (let i = 0; i < 3 && atts.length; i++) pick.push(atts.splice(Math.floor(Math.random() * atts.length), 1)[0]);
  for (const a of pick) {
    const abs = path.join('C:/Users/user/Documents/output/pingtan', a.rel_path);
    let head = null;
    try { const fd = fs.openSync(abs, 'r'); const buf = Buffer.alloc(8); fs.readSync(fd, buf, 0, 8, 0); fs.closeSync(fd); head = buf; } catch (e) {}
    const okMagic = head && (head[0] === 0x25 && head[1] === 0x50 || head.toString('latin1').startsWith('%PDF') || head.toString('latin1').startsWith('PK') || head[0] === 0x50 && head[1] === 0x4b || (head[0] === 0xd0 && head[1] === 0xcf) || (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) || head.toString('latin1').slice(0,4).match(/^[A-Za-z0-9]{4}/));
    console.log('QA ATT ' + (okMagic ? 'magic-ok' : 'magic-CHECK') + ' size=' + (head ? 'open' : 'missing') + ' ' + String(a.rel_path).slice(0, 90));
  }
}
