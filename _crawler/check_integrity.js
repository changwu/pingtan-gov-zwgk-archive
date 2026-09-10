'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('output/state.db', { readOnly: true, timeout: 10000 });
const done = db.prepare("SELECT COUNT(*) c FROM docs WHERE status='done'").get().c;
const failed = db.prepare("SELECT COUNT(*) c FROM docs WHERE status='failed'").get().c;
// count page.txt on disk
let diskTxt = 0, diskHtml = 0, diskLinks = 0, dirs = 0;
function walk(dir) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f);
    else if (e.name === 'page.txt') diskTxt++;
    else if (e.name === 'page.html') diskHtml++;
    else if (e.name === 'links.tsv') diskLinks++;
  }
}
walk(path.join('output', 'pingtan'));
console.log('DB done:', done, 'failed:', failed);
console.log('disk page.txt:', diskTxt, 'page.html:', diskHtml, 'links.tsv:', diskLinks);
const diff = diskTxt - done;
console.log('delta (disk - db done):', diff);
// attachments disk count
let attDisk = 0;
function walk2(dir) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk2(f);
    else if (f.includes(path.sep + 'attachments' + path.sep)) attDisk++;
  }
}
walk2(path.join('output', 'pingtan'));
const attDone = db.prepare("SELECT COUNT(*) c FROM attachments WHERE status='done'").get().c;
console.log('attachments: DB done', attDone, '| disk files under attachments/', attDisk);