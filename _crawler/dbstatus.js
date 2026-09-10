'use strict';
/* Quick DB state summary for pingtan crawl (read-only) */
const { DatabaseSync } = require('node:sqlite');
const dbPath = process.argv[2] || 'C:/Users/user/Documents/output/state.db';
const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 10000 });
const g = (s) => db.prepare(s).all();
console.log('=== docs by status ===');
for (const r of g("SELECT status, COUNT(*) c FROM docs GROUP BY status")) console.log(r.status, r.c);
console.log('=== attachments by status ===');
for (const r of g("SELECT status, COUNT(*) c FROM attachments GROUP BY status")) console.log(r.status, r.c);
console.log('=== lists by status ===');
for (const r of g("SELECT status, COUNT(*) c FROM lists GROUP BY status")) console.log(r.status, r.c);
console.log('=== outbound count ===', db.prepare('SELECT COUNT(*) c FROM outbound').get().c);
console.log('=== queued docs by priority ===');
for (const r of g("SELECT priority, COUNT(*) c FROM docs WHERE status='queued' GROUP BY priority ORDER BY priority")) console.log('prio', r.priority, r.c);
console.log('=== failed docs (all) ===');
for (const r of g("SELECT channel, docid, err FROM docs WHERE status='failed'")) console.log(r.channel, '|', r.docid, '|', r.err);
console.log('=== queued by channel top 20 ===');
for (const r of g("SELECT channel, COUNT(*) c FROM docs WHERE status='queued' GROUP BY channel ORDER BY c DESC LIMIT 20")) console.log(r.channel, r.c);
console.log('=== meta ===');
for (const r of g('SELECT key, value FROM meta')) console.log(r.key, '=', r.value);
console.log('=== done docs missing page.txt on disk ===');
// spot check: count done docs and files
const done = db.prepare("SELECT COUNT(*) c FROM docs WHERE status='done'").get().c;
console.log('done docs:', done);
