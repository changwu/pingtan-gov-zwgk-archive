'use strict';
/* Print byStatus.done count from progress.json (no DB lock) */
const fs = require('fs');
const p = 'C:/Users/user/Documents/output/progress.json';
try {
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const d = (j.byStatus && j.byStatus.done) || 0;
  const q = (j.byStatus && j.byStatus.queued) || 0;
  const f = (j.byStatus && j.byStatus.failed) || 0;
  console.log(d + '\t' + q + '\t' + f + '\t' + (j.phase || ''));
} catch (e) { console.log('ERR ' + e.message); }
