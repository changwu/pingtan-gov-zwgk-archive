'use strict';
/* Generate global reports: _index.tsv, _attachments.tsv, _outbound_links.tsv,
   _filtered_over_25mb.txt, _directory_tree.txt, README.md, per-channel README */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const OUT_ROOT = process.env.PT_OUT || path.join(__dirname, '..', 'output');
const DATA_ROOT = path.join(OUT_ROOT, 'pingtan');
const DB_PATH = path.join(OUT_ROOT, 'state.db');
const NL = String.fromCharCode(10);
const TAB = String.fromCharCode(9);

function tsv(s) { return s == null ? '' : String(s).replace(/[\t\r\n]/g, ' ').trim(); }

const db = new DatabaseSync(DB_PATH, { readOnly: true, timeout: 10000 });

const CH_TITLE = {
  'zwgk': '政务公开',
  'zwgk/gsgg': '公示公告',
  'zwgk/zfxxgk': '政府信息公开',
  'zwgk/zfxxgk/zfxxgkzn': '政府信息公开指南',
  'zwgk/zfxxgk/zfxxgkzd': '政府信息公开制度',
  'zwgk/zfxxgk/zfxxgknb': '政府信息公开年报',
  'zwgk/zfxxgk/zfxxgksq': '政府信息公开申请',
  'zwgk/zfxxgk/gwhwj': '管委会文件',
  'zwgk/zfxxgk/fdzdgknr': '法定主动公开内容',
  'zwgk/zfxxgk/dfbmptlj': '地方部门平台链接(部门子站)',
  'zwgk/zxwj': '最新文件',
  'zwgk/zcwjk': '政策文件库',
  'zwgk/zfgzbg': '政府工作报告',
  'zwgk/ghxx': '规划信息',
  'zwgk/tjxx': '统计信息',
  'zwgk/rsxx': '人事信息',
  'zwgk/zdlyxxgk': '重点领域信息公开',
  'zwgk/ztzl': '专题专栏',
  'zwgk/yw': '要闻',
  'zwgk/zfhy': '政府会议',
  'zwgk/ldzc': '领导之窗',
  'zwgk/zzjg': '政府机构'
};

function channelTitle(ch) {
  if (CH_TITLE[ch]) return CH_TITLE[ch];
  // try to read the archived list index.txt header
  try {
    const p = path.join(DATA_ROOT, ch, '_lists', 'index.txt');
    if (fs.existsSync(p)) {
      const first = fs.readFileSync(p, 'utf8').split(NL)[0];
      if (first.startsWith('栏目: ')) return first.slice(4);
    }
  } catch (e) {}
  return ch;
}

function main() {
  const totals = db.prepare('SELECT status, COUNT(*) c FROM docs GROUP BY status').all();
  const byStatus = {}; totals.forEach(x => byStatus[x.status] = x.c);
  const channels = db.prepare('SELECT channel, COUNT(*) total, SUM(CASE WHEN status=' + "'done'" + ' THEN 1 ELSE 0 END) done, SUM(CASE WHEN status=' + "'failed'" + ' THEN 1 ELSE 0 END) failed, MIN(priority) p FROM docs GROUP BY channel ORDER BY p, channel').all();
  const attTot = db.prepare('SELECT status, COUNT(*) c FROM attachments GROUP BY status').all();
  const attBy = {}; attTot.forEach(x => attBy[x.status] = x.c);
  const outN = db.prepare('SELECT COUNT(*) c FROM outbound').get().c;
  const listsN = db.prepare('SELECT COUNT(*) c FROM lists WHERE status=' + "'done'").get().c;

  // ---- _index.tsv (done docs only + note) ----
  const idxRows = db.prepare('SELECT channel, doctitle, pubdate, fileno, source, url, rel_dir, status FROM docs WHERE status=' + "'done'" + ' ORDER BY priority, channel, pubdate DESC').all();
  let idx = ['channel\ttitle\tpubdate\tfileno\tsource\turl\tlocal_rel\tstatus'];
  for (const r of idxRows) {
    const rel = r.rel_dir ? (r.rel_dir.replace(/\\/g, '/') + '/page.txt') : '';
    idx.push([tsv(r.channel), tsv(r.doctitle), tsv(r.pubdate), tsv(r.fileno), tsv(r.source), r.url, rel, r.status].join(TAB));
  }
  fs.writeFileSync(path.join(OUT_ROOT, '_index.tsv'), idx.join(NL), 'utf8');

  // ---- _attachments.tsv ----
  const attRows = db.prepare('SELECT url, doc_url, channel, kind, status, size, rel_path, err FROM attachments ORDER BY channel, url').all();
  const att = ['url\tkind\tsize\trel_path\tdoc_url\tstatus'];
  const big = [];
  for (const a of attRows) {
    att.push([a.url, a.kind, a.size == null ? '' : a.size, a.rel_path || '', a.doc_url, a.status].join(TAB));
    if (a.status === 'done' && a.size != null && a.size > 25 * 1024 * 1024) big.push(a);
  }
  fs.writeFileSync(path.join(OUT_ROOT, '_attachments.tsv'), att.join(NL), 'utf8');

  // ---- _filtered_over_25mb.txt ----
  const fl = ['# 超过 25MB 未推入 GitHub 的附件清单(本地 output/pingtan 保留完整副本)', '# 格式: 大小(bytes)\t相对路径'];
  for (const b of big) fl.push(String(b.size) + TAB + (b.rel_path || ''));
  fs.writeFileSync(path.join(OUT_ROOT, '_filtered_over_25mb.txt'), fl.join(NL), 'utf8');

  // ---- _outbound_links.tsv (aggregated by url to stay under repo file limits) ----
  const outRows = db.prepare('SELECT url, COUNT(*) c, MIN(doc_url) sample_doc, MAX(title) title FROM outbound GROUP BY url ORDER BY c DESC').all();
  const ob = ['url\tcount\tlast_title\tsample_from_doc'];
  for (const o of outRows) ob.push([o.url, o.c, tsv(o.title), o.sample_doc].join(TAB));
  fs.writeFileSync(path.join(OUT_ROOT, '_outbound_links.tsv'), ob.join(NL), 'utf8');

  // ---- _directory_tree.txt ----
  const tree = [];
  function walk(dir, prefix) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    entries.sort((a, b) => a.name < b.name ? -1 : 1);
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = path.relative(DATA_ROOT, full).replace(/\\/g, '/');
      if (e.isDirectory()) {
        tree.push(prefix + e.name + '/');
        walk(full, prefix + '  ');
      } else {
        let sz = 0;
        try { sz = fs.statSync(full).size; } catch (err) {}
        tree.push(prefix + e.name + '  (' + sz + ' B)');
      }
    }
  }
  tree.push('pingtan/');
  walk(DATA_ROOT, '  ');
  fs.writeFileSync(path.join(OUT_ROOT, '_directory_tree.txt'), tree.join(NL), 'utf8');

  // ---- per-channel README ----
  for (const c of channels) {
    const chDir = path.join(DATA_ROOT, c.channel);
    fs.mkdirSync(chDir, { recursive: true });
    const title = channelTitle(c.channel);
    const docs = db.prepare('SELECT doctitle, pubdate, url, rel_dir, status FROM docs WHERE channel=? ORDER BY pubdate DESC LIMIT 50').all(c.channel);
    const lines = [];
    lines.push('# ' + title);
    lines.push('');
    lines.push('栏目路径: ' + c.channel);
    lines.push('文档总数: ' + c.total + ' | 已完成: ' + (c.done || 0) + ' | 失败: ' + (c.failed || 0) + ' | 排队: ' + (c.total - (c.done || 0) - (c.failed || 0)));
    lines.push('');
    if (docs.length) {
      lines.push('| 标题 | 发布日期 | 本地 | 状态 |');
      lines.push('|---|---|---|---|');
      for (const d of docs) {
        const rel = d.rel_dir ? d.rel_dir.replace(/\\/g, '/') + '/page.txt' : '';
        lines.push('| ' + tsv(d.doctitle) + ' | ' + tsv(d.pubdate) + ' | ' + rel + ' | ' + d.status + ' |');
      }
    }
    fs.writeFileSync(path.join(chDir, 'README.md'), lines.join(NL), 'utf8');
  }

  // ---- global README.md ----
  const doneDocs = byStatus.done || 0;
  const doneBytes = (function () {
    let s = 0;
    function walk2(dir) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk2(full);
        else { try { s += fs.statSync(full).size; } catch (err) {} }
      }
    }
    walk2(DATA_ROOT);
    return s;
  })();
  const rd = [];
  rd.push('# 平潭综合实验区政府门户 — 政务公开网络存档');
  rd.push('');
  rd.push('抓取源站: https://www.pingtan.gov.cn/zwgk/ (政务公开板块)');
  rd.push('任务目标 URL: https://218.106.148.33:8443/zwgk/ (该镜像为静态快照,仅含少量页面;经探查,数据以主站列表接口 /fjdzapp/search 完整枚举,正文从主站抓取)');
  rd.push('爬虫与状态库: 本目录上一级 state.db / crawl.log / progress.json;爬虫源码见仓库根目录之外(交付物清单含代码与状态库,可断点续爬)');
  rd.push('');
  rd.push('## 统计');
  rd.push('');
  rd.push('- 枚举范围(站点文档库 channelid=200210): ' + (parseInt(db.prepare('SELECT COUNT(*) c FROM docs').get().c, 10) + parseInt(byStatus.skipped_external || 0, 10)) + ' 条中,符合范围(/zwgk/ 同域) ' + db.prepare('SELECT COUNT(*) c FROM docs').get().c + ' 条');
  rd.push('- 已完成文档(page.txt+page.html+links.tsv): ' + doneDocs);
  rd.push('- 失败: ' + (byStatus.failed || 0) + ' | 待抓取: ' + (byStatus.queued || 0));
  rd.push('- 附件: 记录 ' + (attTot.reduce((a, x) => a + x.c, 0) || 0) + ' | 已下载 ' + (attBy.done || 0) + ' | 失败 ' + (attBy.failed || 0));
  rd.push('- 站外链接记录: ' + outN + ' | 列表页存档: ' + listsN);
  rd.push('- 本地体积: ' + Math.round(doneBytes / 1024 / 1024) + ' MB');
  rd.push('');
  rd.push('## 分栏目进度');
  rd.push('');
  rd.push('| 栏目 | 栏目路径 | 标题样例 | 总数 | 完成 | 失败 |');
  rd.push('|---|---|---|---|---|---|');
  for (const c of channels) {
    rd.push('| ' + channelTitle(c.channel) + ' | ' + c.channel + ' | | ' + c.total + ' | ' + (c.done || 0) + ' | ' + (c.failed || 0) + ' |');
  }
  rd.push('');
  rd.push('## 目录结构');
  rd.push('');
  rd.push('每个文档目录含 page.txt(标题/发布时间/文号/机构/正文)、page.html(原始网页)、links.tsv(页面链接) 与 attachments/(附件与正文图片);栏目列表页在 <栏目>/_lists/。');
  rd.push('全局清单: _index.tsv / _attachments.tsv / _outbound_links.tsv / _directory_tree.txt / _filtered_over_25mb.txt');
  rd.push('');
  rd.push('## 续爬说明');
  rd.push('');
  rd.push('cd 到爬虫目录执行 node pt_tools/crawler.js (自动枚举已完成,续爬排队文档);node pt_tools/crawler.js --retry-failed 重试失败项;node pt_tools/crawler.js --lists-only 补抓栏目列表页;node pt_tools/report.js 重新生成本报告。');
  fs.writeFileSync(path.join(OUT_ROOT, 'README.md'), rd.join(NL), 'utf8');

  console.log('report done: docs=' + doneDocs + ' att_done=' + (attBy.done || 0) + ' channels=' + channels.length + ' outbound=' + outN);
}
main();
