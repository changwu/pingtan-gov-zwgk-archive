'use strict';
/* Check whether 'done' docs lacking page.html are legit direct-binary docs (have attachments/file) */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const DATA = 'C:/Users/user/Documents/output/pingtan';
const db = new DatabaseSync('C:/Users/user/Documents/output/state.db', { readOnly: true, timeout: 10000 });
const done = db.prepare("SELECT url, rel_dir, channel FROM docs WHERE status='done'").all();
let binOk = 0, suspicious = 0;
const susp = [];
for (const d of done) {
  if (!d.rel_dir) continue;
  const base = path.join(DATA, d.rel_dir);
  const hasHtml = fs.existsSync(path.join(base, 'page.html'));
  const hasFile = fs.existsSync(path.join(base, 'attachments', 'file'));
  if (!hasHtml) {
    if (hasFile) binOk++;
    else { suspicious++; if (susp.length < 10) susp.push(d.rel_dir + ' | ' + d.url); }
  }
}
console.log('done without page.html: binary-with-attachment=' + binOk + ' suspicious=' + suspicious);
susp.forEach(s => console.log('  SUSP:', s.slice(0, 150)));
