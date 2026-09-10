'use strict';
/* Compact one-line status: done/queued/failed/attachments/phase + rate estimate + watcher + git */
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('C:/Users/user/Documents/output/state.db', { readOnly: true, timeout: 8000 });
const by = {};
for (const r of db.prepare("SELECT status, COUNT(*) c FROM docs GROUP BY status").all()) by[r.status] = r.c;
const att = db.prepare("SELECT status, COUNT(*) c FROM attachments GROUP BY status").all();
const attBy = {}; att.forEach(x => attBy[x.status] = x.c);
const pj = JSON.parse(fs.readFileSync('C:/Users/user/Documents/output/progress.json', 'utf8'));
const line = 'docs done=' + (by.done||0) + ' queued=' + (by.queued||0) + ' failed=' + (by.failed||0) +
  ' | att done=' + (attBy.done||0) + ' queued=' + (attBy.queued||0) + ' failed=' + (attBy.failed||0) +
  ' | phase=' + pj.phase + ' runDone=' + pj.done + ' | chanDone=' + pj.channelsDone + '/' + pj.channelsTotal;
console.log(line);
// git state
const cp = require('child_process');
try {
  const r = cp.spawnSync('git', ['-C', 'C:/Users/user/Documents/pt_repo', 'log', '-1', '--format=%h %s'], { encoding: 'utf8' });
  console.log('git: ' + (r.stdout || '').trim());
} catch (e) { console.log('git: n/a'); }
try {
  const w = fs.readFileSync('C:/Users/user/Documents/pt_tools/batch_watcher.log', 'utf8').trim().split('\n');
  console.log('watcher: ' + w[w.length - 1]);
} catch (e) { console.log('watcher: no log'); }
