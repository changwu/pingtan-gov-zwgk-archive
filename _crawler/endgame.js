'use strict';
/*
 * Endgame runner for pingtan crawl (run AFTER main crawl queue empties):
 * 1) requeue failed docs + failed/queued attachments (safe retry set)
 * 2) crawl them (crawler.js picks queued only)
 * 3) archive channel lists (--lists-only)
 * 4) regenerate reports (report.js)
 * Prints step markers; git sync+push done separately by caller.
 */
const { spawnSync } = require('child_process');
const path = require('path');
const TOOLS = 'C:/Users/user/Documents/pt_tools';
function run(nodeArgs, opts) {
  opts = opts || {};
  console.log('\n=== RUN node ' + nodeArgs.join(' ') + ' ===');
  const r = spawnSync('node', nodeArgs, { cwd: TOOLS, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: opts.timeout || 3600000, stdio: opts.inherit ? 'inherit' : 'pipe' });
  if (r.error) console.log('spawn error: ' + r.error.message);
  if (r.status !== 0) console.log('EXIT ' + r.status);
  if (r.stdout) console.log(String(r.stdout).split('\n').slice(-8).join('\n'));
  if (r.stderr) console.log('stderr tail: ' + String(r.stderr).split('\n').slice(-4).join('\n'));
  return r.status;
}

const step = process.argv[2] || 'all';
if (step === 'retry' || step === 'all') {
  // requeue failed docs (safe: only status=failed) + owners of failed/queued attachments
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync('C:/Users/user/Documents/output/state.db');
  const r1 = db.prepare("UPDATE docs SET status='queued', err=NULL WHERE status='failed'").run();
  const r2 = db.prepare("UPDATE attachments SET status='queued', err=NULL WHERE status='failed' OR status='queued'").run();
  // docs that own attachments which are not done must be requeued so crawler re-runs downloadAttachments
  const owners = db.prepare("SELECT DISTINCT doc_url FROM attachments WHERE status!='done' AND doc_url IS NOT NULL").all();
  let r3 = 0;
  for (const o of owners) {
    const u = db.prepare("UPDATE docs SET status='queued', err=NULL WHERE url=? AND status='done'").run(o.doc_url);
    r3 += u.changes;
  }
  console.log('requeued failed docs=' + r1.changes + ' attachments=' + r2.changes + ' owner-docs=' + r3);
  db.close();
  run(['crawler.js'], { inherit: true, timeout: 8 * 3600000 });
}
if (step === 'lists' || step === 'all') {
  run(['crawler.js', '--lists-only'], { inherit: true, timeout: 3 * 3600000 });
}
if (step === 'report' || step === 'all') {
  run(['report.js'], { inherit: true, timeout: 3 * 3600000 });
}
console.log('\n=== endgame step done (' + step + ') ===');
