'use strict';
/* Explain delta between done docs and disk page.txt: duplicate rel_dir vs NULL rel_dir */
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('C:/Users/user/Documents/output/state.db', { readOnly: true, timeout: 10000 });
const doneN = db.prepare("SELECT COUNT(*) c FROM docs WHERE status='done'").get().c;
const nullRel = db.prepare("SELECT COUNT(*) c FROM docs WHERE status='done' AND (rel_dir IS NULL OR rel_dir='')").get().c;
const distinctRel = db.prepare("SELECT COUNT(DISTINCT rel_dir) c FROM docs WHERE status='done' AND rel_dir IS NOT NULL AND rel_dir<>''").get().c;
console.log('done docs:', doneN, '| with NULL/empty rel_dir:', nullRel, '| distinct rel_dir:', distinctRel);
const dups = db.prepare("SELECT rel_dir, COUNT(*) c, GROUP_CONCAT(url, ' || ') urls FROM docs WHERE status='done' AND rel_dir IS NOT NULL AND rel_dir<>'' GROUP BY rel_dir HAVING c > 1 ORDER BY c DESC LIMIT 8").all();
console.log('shared rel_dir groups:', dups.length);
for (const d of dups) console.log('  x' + d.c, d.rel_dir, '->', String(d.urls).slice(0, 180));
