'use strict';
/* Distribution of remaining queue: verify all channels have priority ordering so crawl will cover them.
   Also report queued docs by host and date range. */
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('C:/Users/user/Documents/output/state.db', { readOnly: true, timeout: 8000 });
const q = db.prepare("SELECT channel, priority, COUNT(*) c FROM docs WHERE status='queued' GROUP BY channel, priority ORDER BY c DESC").all();
console.log('queued channel groups (top 25):');
for (const r of q.slice(0, 25)) console.log('  prio' + r.priority + ' ' + r.channel + '\t' + r.c);
console.log('queued by priority:');
const prio = {};
for (const r of q) prio[r.priority] = (prio[r.priority] || 0) + r.c;
Object.entries(prio).sort((a, b) => a[0] - b[0]).forEach(([p, c]) => console.log('  prio ' + p + ': ' + c));
// date spread of queued
const dates = db.prepare("SELECT MIN(COALESCE(NULLIF(pubdate,''), NULLIF(docreltime,''), '9999')) mn, MAX(COALESCE(NULLIF(pubdate,''), NULLIF(docreltime,''), '0000')) mx FROM docs WHERE status='queued'").get();
console.log('queued date range:', dates.mn, '->', dates.mx);
// docs done per priority
const doneP = db.prepare("SELECT priority, COUNT(*) c FROM docs WHERE status='done' GROUP BY priority").all();
console.log('done by priority:', doneP.map(r => r.priority + '=' + r.c).join(' '));
