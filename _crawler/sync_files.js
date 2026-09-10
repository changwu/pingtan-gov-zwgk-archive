'use strict';
/* Copy crawled output (filter >25MB) into the GitHub repo working copy. Git ops are run via pwsh separately. */
const fs = require('fs');
const path = require('path');

const OUT_ROOT = process.env.PT_OUT || path.join(__dirname, '..', 'output');
const DATA_ROOT = path.join(OUT_ROOT, 'pingtan');
const REPO_DIR = path.join(__dirname, '..', 'pt_repo');
const SITE_NAME = 'pingtan';
const LIMIT = 25 * 1024 * 1024;
const NL = String.fromCharCode(10);

fs.mkdirSync(REPO_DIR, { recursive: true });
const siteRoot = path.join(REPO_DIR, SITE_NAME);
fs.mkdirSync(siteRoot, { recursive: true });
let copied = 0, skipped = 0;
const filtered = [];
const seen = new Set();
function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = path.relative(DATA_ROOT, full).replace(/\\/g, '/');
    if (e.isDirectory()) { walk(full); continue; }
    if (seen.has(rel)) continue;
    seen.add(rel);
    let size = 0;
    try { size = fs.statSync(full).size; } catch (err) { continue; }
    const dest = path.join(siteRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (size > LIMIT) { filtered.push(size + '\t' + rel); skipped++; continue; }
    let same = false;
    try { const st = fs.statSync(dest); same = (st.size === size); } catch (e) {}
    if (!same) fs.copyFileSync(full, dest);
    copied++;
  }
}
walk(DATA_ROOT);
for (const f of ['_index.tsv', '_attachments.tsv', '_outbound_links.tsv', '_directory_tree.txt', '_filtered_over_25mb.txt', 'README.md']) {
  const src = path.join(OUT_ROOT, f);
  if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(siteRoot, f)); copied++; }
}
const fl = ['# 超过 25MB 未推入 GitHub 的附件(本地完整副本保留在 output/pingtan)', '# 格式: 大小(bytes)\t相对路径'];
for (const line of filtered) fl.push(line);
fs.writeFileSync(path.join(siteRoot, '_filtered_over_25mb.txt'), fl.join(NL), 'utf8');
const rootReadme = ['# 平潭综合实验区政府网站 政务公开存档', '', '站点子目录: ' + SITE_NAME + '/', '说明见 ' + SITE_NAME + '/README.md', '更新: ' + new Date().toISOString()].join(NL);
fs.writeFileSync(path.join(REPO_DIR, 'README.md'), rootReadme, 'utf8');
console.log('synced copied=' + copied + ' filtered=' + skipped);
