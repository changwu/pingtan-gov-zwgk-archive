'use strict';
/*
 * Pingtan (pingtan.gov.cn) zwgk archive crawler.
 * - enumerate full site doc index: POST /fjdzapp/search channelid=200210 (prepage=500)
 * - scope: same-host docs with path /zwgk/...
 * - polite, single-threaded, random delays, SQLite state, resumable
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const C = require('./crawler_common.js');

const OUT_ROOT = process.env.PT_OUT || path.join(__dirname, '..', 'output');
const DATA_ROOT = path.join(OUT_ROOT, 'pingtan');
const DB_PATH = path.join(OUT_ROOT, 'state.db');
const LOG_PATH = path.join(OUT_ROOT, 'crawl.log');
const PROG_PATH = path.join(OUT_ROOT, 'progress.json');

const args = process.argv.slice(2);
function argVal(name, def) {
  const i = args.indexOf(name);
  return (i >= 0 && args[i + 1]) ? args[i + 1] : def;
}
const ONLY_ENUM = args.includes('--enum-only');
const NO_CRAWL = args.includes('--no-crawl');
const LIMIT = parseInt(argVal('--limit', '0'), 10) || 0;
const RETRY_FAILED = args.includes('--retry-failed');
const CHANNEL_FILTER = argVal('--channels', '') ? argVal('--channels', '').split(',').filter(Boolean) : null;
const DELAY_MS = argVal('--delay-ms', '') ? parseInt(argVal('--delay-ms', ''), 10) : 0;

fs.mkdirSync(OUT_ROOT, { recursive: true });
fs.mkdirSync(DATA_ROOT, { recursive: true });

const logfd = fs.openSync(LOG_PATH, 'a');
function log(msg) {
  const line = new Date().toISOString() + ' ' + msg;
  try { fs.writeSync(logfd, line + '\n'); } catch (e) {}
  console.log(line);
}
function Q(s) { return String.fromCharCode(39) + s + String.fromCharCode(39); }
function T() { return 'datetime(' + Q('now') + ')'; }
function NL() { return String.fromCharCode(10); }

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode=WAL;');
db.exec('PRAGMA busy_timeout=60000;');
db.exec('PRAGMA synchronous=NORMAL;');
db.exec(
  'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);' +
  'CREATE TABLE IF NOT EXISTS docs (' +
  ' url TEXT PRIMARY KEY,' +
  ' channel TEXT, docid TEXT, doctitle TEXT, pubdate TEXT, docreltime TEXT,' +
  ' fileno TEXT, source TEXT, puborg TEXT, idxid TEXT, chnlid TEXT, doctype TEXT,' +
  ' is_binary INTEGER DEFAULT 0, priority INTEGER DEFAULT 5,' +
  ' status TEXT DEFAULT ' + Q('queued') + ', attempts INTEGER DEFAULT 0,' +
  ' rel_dir TEXT, err TEXT, fetched_at TEXT, updated_at TEXT);' +
  'CREATE TABLE IF NOT EXISTS lists (' +
  ' url TEXT PRIMARY KEY, channel TEXT, status TEXT DEFAULT ' + Q('queued') + ',' +
  ' rel_dir TEXT, err TEXT, fetched_at TEXT, updated_at TEXT);' +
  'CREATE TABLE IF NOT EXISTS attachments (' +
  ' url TEXT PRIMARY KEY, doc_url TEXT, channel TEXT, kind TEXT,' +
  ' status TEXT DEFAULT ' + Q('queued') + ', size INTEGER, rel_path TEXT, err TEXT, fetched_at TEXT, updated_at TEXT);' +
  'CREATE TABLE IF NOT EXISTS outbound (' +
  ' url TEXT, doc_url TEXT, kind TEXT, title TEXT,' +
  ' PRIMARY KEY (url, doc_url));' +
  'CREATE INDEX IF NOT EXISTS idx_docs_status ON docs(status);' +
  'CREATE INDEX IF NOT EXISTS idx_docs_channel ON docs(channel);' +
  'CREATE INDEX IF NOT EXISTS idx_docs_prio ON docs(priority, channel, pubdate);'
);

function metaGet(k, d) { const r = db.prepare('SELECT value FROM meta WHERE key=?').get(k); return r ? r.value : d; }
function metaSet(k, v) { db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v)); }

function prioOf(channel) {
  if (!channel) return 5;
  const c = channel.startsWith('zwgk/') ? channel.slice(5) : channel;
  if (c === 'gsgg' || c.startsWith('gsgg/')) return 1;
  if (c.startsWith('zfxxgk/dfbmptlj')) return 8;
  if (c.startsWith('zfxxgk/gwhwj') || c.startsWith('zfxxgk/zc') || c.startsWith('zxwj') || c.startsWith('zcwjk')) return 2;
  if (c.startsWith('zfxxgk') || c === 'zfgzbg') return 3;
  if (c.startsWith('ghxx') || c.startsWith('tjxx') || c.startsWith('rsxx') || c.startsWith('zdlyxxgk')) return 4;
  return 5;
}

function inScope(url) {
  let u;
  try { u = new URL(url); } catch (e) { return false; }
  const host = u.hostname;
  const sameHost = (host === 'www.pingtan.gov.cn' || host === '218.106.148.33' || host.endsWith('.pingtan.gov.cn'));
  if (!sameHost) return false;
  return u.pathname.startsWith('/zwgk/');
}

function writeProgress(extra) {
  const st = db.prepare('SELECT status, COUNT(*) c FROM docs GROUP BY status').all();
  const byStatus = {};
  st.forEach(function (x) { byStatus[x.status] = x.c; });
  const obj = Object.assign({
    updated: new Date().toISOString(),
    byStatus: byStatus,
    channelsTotal: db.prepare('SELECT COUNT(DISTINCT channel) c FROM docs').get().c,
    channelsDone: db.prepare('SELECT COUNT(DISTINCT channel) c FROM docs WHERE status=' + Q('done')).get().c,
    attachmentsDone: db.prepare('SELECT COUNT(*) c FROM attachments WHERE status=' + Q('done')).get().c,
    attachmentsTotal: db.prepare('SELECT COUNT(*) c FROM attachments').get().c,
    listsDone: db.prepare('SELECT COUNT(*) c FROM lists WHERE status=' + Q('done')).get().c
  }, extra || {});
  try { fs.writeFileSync(PROG_PATH, JSON.stringify(obj, null, 2)); } catch (e) {}
  return obj;
}

/* ============ ENUMERATION ============ */
async function enumAll() {
  const api = C.CFG.API;
  log('ENUM start');
  let page = parseInt(metaGet('enum_next_page', '1'), 10);
  const prepage = 500;
  let seenTotal = parseInt(metaGet('enum_seen_total', '0'), 10);
  let skippedExternal = parseInt(metaGet('enum_skipped_external', '0'), 10);
  const ins = db.prepare(
    'INSERT INTO docs (url, channel, docid, doctitle, pubdate, docreltime, fileno, source, puborg, idxid, chnlid, doctype, is_binary, priority, status, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,' + T() + ')' +
    ' ON CONFLICT(url) DO UPDATE SET doctitle=excluded.doctitle, pubdate=excluded.pubdate, docreltime=excluded.docreltime, fileno=excluded.fileno, source=excluded.source, puborg=excluded.puborg, idxid=excluded.idxid, updated_at=' + T()
  );
  let pageCount = Infinity;
  let loop = 0;
  while (page <= pageCount && loop < 5000) {
    loop++;
    const body = 'channelid=200210&sortfield=-pubdate&page=' + page + '&prepage=' + prepage;
    let r;
    try { r = await C.getWithRetries(api, { body: body, retries: [5000, 15000, 45000] }); }
    catch (e) { log('ENUM page ' + page + ' FAILED ' + e.message + ' -> pause 30s'); await C.sleep(30000); continue; }
    if (r.status !== 200) { log('ENUM page ' + page + ' status ' + r.status + ' -> pause 30s'); await C.sleep(30000); continue; }
    let j;
    try { j = JSON.parse(r.body.toString('utf8')); }
    catch (e) { log('ENUM page ' + page + ' bad json -> pause 30s'); await C.sleep(30000); continue; }
    pageCount = j.pageCount || pageCount;
    const rows = (j.data || []);
    db.exec('BEGIN');
    try {
      for (const d of rows) {
        const url = d.docpuburl || d.chnldocurl;
        if (!url) continue;
        if (!inScope(url)) { skippedExternal++; continue; }
        const p = C.parseDocPath(new URL(url).pathname);
        const ch = p.channel || 'zwgk';
        ins.run(url, ch, p.docid, d.doctitle || '', d.pubdate || '', d.docreltime || '', d.fileno || '', d.docsourcename || '', d.puborg || '', d.idxid || '', String(d.chnlid || ''), String(d.doctype || ''), p.isBinary ? 1 : 0, prioOf(ch), 'queued');
        seenTotal++;
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); log('ENUM tx fail ' + e.message); }
    page++;
    metaSet('enum_next_page', String(page));
    metaSet('enum_seen_total', String(seenTotal));
    metaSet('enum_skipped_external', String(skippedExternal));
    metaSet('enum_page_count', String(pageCount));
    if (page % 10 === 1 || rows.length === 0) {
      log('ENUM page ' + (page - 1) + '/' + pageCount + ' rows=' + rows.length + ' added=' + seenTotal + ' skippedExt=' + skippedExternal);
      writeProgress({ phase: 'enum', page: page - 1, pageCount: pageCount });
    }
    if (rows.length < prepage) break;
    await C.sleepRandom(C.CFG.LIST_DELAY[0], C.CFG.LIST_DELAY[1]);
  }
  metaSet('enum_done', '1');
  log('ENUM finished. docs in db: ' + db.prepare('SELECT COUNT(*) c FROM docs').get().c);
  writeProgress({ phase: 'enum-done' });
}

/* ============ CONTENT EXTRACTION ============ */
function extractContent(htmlStr) {
  const markers = ['TRS_Editor', 'zoom', 'article', 'detail', 'content', 'xl_content', 'view', 'conTxt', 'wz_content', 'news_content', 'text', 'mainText'];
  const cands = [];
  const reDiv = /<div\b[^>]*>/gi;
  let m;
  while ((m = reDiv.exec(htmlStr)) !== null) {
    const tag = m[0];
    if (/\/\s*>$/.test(tag)) continue;
    const attr = tag.toLowerCase();
    let mark = null;
    for (const mk of markers) { if (attr.indexOf(mk.toLowerCase()) >= 0) { mark = mk; break; } }
    if (!mark) continue;
    const start = m.index;
    let depth = 1;
    const reC = /<\/div\s*>|<div\b[^>]*>/gi;
    reC.lastIndex = m.index + tag.length;
    let mm; let end = -1;
    while ((mm = reC.exec(htmlStr)) !== null) {
      if (mm[0].indexOf('</div') === 0) depth--;
      else if (!/\/\s*>$/.test(mm[0])) depth++;
      if (depth === 0) { end = mm.index + mm[0].length; break; }
    }
    if (end > start) {
      const seg = htmlStr.slice(start, end);
      const text = C.stripTags(seg);
      cands.push({ mark: mark.toLowerCase(), textLen: text.length, html: seg, text: text });
    }
  }
  if (cands.length) {
    const trs = cands.filter(function (c) { return c.mark.indexOf('trs_editor') >= 0; });
    const pool = trs.length ? trs : cands;
    pool.sort(function (a, b) { return b.textLen - a.textLen; });
    return pool[0];
  }
  const body = htmlStr.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  return { html: body, text: C.stripTags(body) };
}

function extractMeta(htmlStr) {
  const meta = {};
  const re = /<meta\b[^>]*>/gi;
  let m;
  while ((m = re.exec(htmlStr)) !== null) {
    const t = m[0];
    const nm = (t.match(/name=["']([^"']+)["']/i) || [])[1];
    const ct = (t.match(/content=["']([^"']*)["']/i) || [])[1];
    if (nm && ct) meta[nm.toLowerCase()] = C.cleanWs(ct);
  }
  const ti = (htmlStr.match(/<title>([\s\S]*?)<\/title>/i) || [])[1];
  if (ti) meta.title = C.cleanWs(ti);
  return meta;
}

function extractLinks(htmlStr, baseUrl) {
  const links = [];
  const seen = new Set();
  const reA = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = reA.exec(htmlStr)) !== null) {
    const href = m[1].trim();
    const text = C.stripTags(m[2]).replace(/\s+/g, ' ').trim().slice(0, 150);
    if (!href || href.indexOf('javascript:') === 0 || href.charAt(0) === '#' || href.indexOf('mailto:') === 0) continue;
    let abs;
    try { abs = new URL(href, baseUrl).toString(); } catch (e) { continue; }
    const key = abs + '|' + text;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ type: 'a', href: abs, text: text });
  }
  const reI = /<img\b[^>]*src=["']([^"']+)["'][^>]*>/gi;
  while ((m = reI.exec(htmlStr)) !== null) {
    const src = m[1].trim();
    if (!src || src.indexOf('data:') === 0) continue;
    let abs;
    try { abs = new URL(src, baseUrl).toString(); } catch (e) { continue; }
    const key = abs + '||img';
    if (seen.has(key)) continue;
    seen.add(key);
    const alt = (m[0].match(/alt=["']([^"']*)["']/i) || [])[1] || '';
    links.push({ type: 'img', href: abs, text: C.cleanWs(alt) });
  }
  return links;
}

function linkKind(href) {
  const p = new URL(href).pathname.toLowerCase();
  if (/\.(docx?|pdf|xlsx?|pptx?|zip|rar|7z|wps|ofd|txt|csv)([?#]|$)/.test(p)) return 'file';
  if (/\.(jpg|jpeg|png|gif|bmp|webp|svg|ico)([?#]|$)/.test(p)) return 'image';
  return 'link';
}
function isSameHost(url) {
  const h = new URL(url).hostname;
  return (h === 'www.pingtan.gov.cn' || h === '218.106.148.33' || h.endsWith('.pingtan.gov.cn'));
}
function decodeEntities(str) {
  return String(str)
    .replace(/&nbsp;/g, ' ')
    .replace(/&ensp;/g, ' ')
    .replace(/&emsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, '\u2014')
    .replace(/&ldquo;/g, '\u201c')
    .replace(/&rdquo;/g, '\u201d')
    .replace(/&hellip;/g, '\u2026')
    .replace(/&#x([0-9a-fA-F]+);/g, function (m, hx) { try { return String.fromCodePoint(parseInt(hx, 16)); } catch (e) { return m; } })
    .replace(/&#(\d+);/g, function (m, dec) { try { return String.fromCodePoint(parseInt(dec, 10)); } catch (e) { return m; } });
}

function cleanBodyText(t) {
  let x = decodeEntities(t);
  x = x.replace(/[ \t\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const mk = ['扫一扫在手机上查看当前页面', '版权所有：平潭综合实验区管委会', '主办单位：平潭综合实验区管委会'];
  for (const mm of mk) {
    const i = x.indexOf(mm);
    if (i > Math.floor(x.length * 0.4)) x = x.slice(0, i).trim();
  }
  return x;
}

function isChromeAsset(href) {
  const p = new URL(href).pathname;
  return /^\/(static|images|css|js)\//.test(p) || p.indexOf('/sysimage/') >= 0 || p.indexOf('/ewebeditor/sysimage/') >= 0;
}

/* ============ DOC PROCESSING ============ */
async function processDoc(row) {
  const url = row.url;
  const channel = row.channel || 'zwgk';
  const parsed = C.parseDocPath(new URL(url).pathname);
  const dateSeg = parsed.dateSeg || '000000';
  const docid = row.docid || parsed.docid || 'doc';
  const slug = C.sanitizeName(docid + '_' + (row.doctitle || '').slice(0, 40));
  const relDir = path.posix.join(channel, dateSeg, slug);
  const absDir = path.join(DATA_ROOT, relDir);
  fs.mkdirSync(absDir, { recursive: true });

  const fail = function (msg) {
    db.prepare('UPDATE docs SET status=' + Q('failed') + ', attempts=attempts+1, err=?, rel_dir=?, updated_at=' + T() + ' WHERE url=?').run(String(msg).slice(0, 200), relDir, url);
    return 'failed';
  };

  // direct binary document entries (docpuburl ends with file extension)
  if (/\.(docx?|pdf|xlsx?|pptx?|zip|rar|7z|wps|ofd)([?#]|$)/i.test(url)) {
    try {
      const rb = await C.getWithRetries(url, { binary: true, timeout: 180000, retries: [5000, 15000, 45000] });
      if (rb.status === 200 || rb.status === 206) {
        const fname = C.sanitizeName(decodeURIComponent(path.basename(new URL(url).pathname))) || 'file.bin';
        const attDir = path.join(absDir, 'attachments', 'file');
        fs.mkdirSync(attDir, { recursive: true });
        fs.writeFileSync(path.join(attDir, fname), rb.body);
        const lb = [];
        lb.push('标题: ' + C.tsv(row.doctitle || fname));
        lb.push('发布日期: ' + C.tsv(row.pubdate || row.docreltime));
        lb.push('文号: ' + C.tsv(row.fileno));
        lb.push('栏目: ' + channel);
        lb.push('原文链接: ' + url);
        lb.push('本条目为直接附件型文档(无网页正文),文件保存在 attachments/file/ 下');
        fs.writeFileSync(path.join(absDir, 'page.txt'), lb.join(NL()), 'utf8');
        db.prepare('UPDATE docs SET status=' + Q('done') + ', attempts=attempts+1, rel_dir=?, err=NULL, fetched_at=' + T() + ', updated_at=' + T() + ' WHERE url=?').run(relDir, url);
        return 'done';
      }
      return fail('binary http ' + rb.status);
    } catch (e) { return fail('binary err ' + e.message); }
  }

  let r;
  try { r = await C.getWithRetries(url, { timeout: 90000 }); }
  catch (e) { return fail('err:' + e.message); }
  if (r.status !== 200) return fail('http ' + r.status);
  if (r.metaRefreshOnly) return fail('gone: meta-refresh to parent (content removed)');

  const htmlStr = C.decodeHtml(r.body);
  const meta = extractMeta(htmlStr);
  const content = extractContent(htmlStr);
  const links = extractLinks(htmlStr, url);
  fs.writeFileSync(path.join(absDir, 'page.html'), r.body);

  const doctitle = meta.articletitle || row.doctitle || meta.title || '';
  const pubdate = meta.pubdate || row.pubdate || '';
  const fileno = meta.fileno || row.fileno || '';
  const source = meta.contentsource || row.source || row.puborg || '';
  const column = meta.columnname || channel;
  const bodyText = cleanBodyText(content.text);

  const tp = [];
  tp.push('标题: ' + C.tsv(doctitle));
  tp.push('发布时间: ' + C.tsv(pubdate));
  tp.push('文号: ' + C.tsv(fileno));
  tp.push('发布机构: ' + C.tsv(source));
  tp.push('栏目: ' + C.tsv(column));
  tp.push('原文链接: ' + url);
  tp.push('本地目录: ' + relDir);
  tp.push('页面链接与图片详见 links.tsv(同目录)');
  tp.push('==================== 正文 ====================');
  tp.push(bodyText);
  fs.writeFileSync(path.join(absDir, 'page.txt'), tp.join(NL()), 'utf8');

  const ltsv = ['type\thref\ttext\tkind\tsamehost\tinscope'];
  for (const l of links) {
    ltsv.push([l.type, l.href, C.tsv(l.text), linkKind(l.href), isSameHost(l.href) ? 'yes' : 'no', inScope(l.href) ? 'yes' : 'no'].join('\t'));
  }
  fs.writeFileSync(path.join(absDir, 'links.tsv'), ltsv.join(NL()), 'utf8');

  const insAtt = db.prepare('INSERT INTO attachments (url, doc_url, channel, kind, status, updated_at) VALUES (?,?,?,?,' + Q('queued') + ',' + T() + ') ON CONFLICT(url) DO NOTHING');
  const contentLinks = extractLinks(content.html || htmlStr, url);
  for (const l of contentLinks) {
    if (!isSameHost(l.href)) continue;
    const kind = linkKind(l.href);
    if (kind === 'file' && !isChromeAsset(l.href)) insAtt.run(l.href, url, channel, 'file');
    else if (kind === 'image' && l.type === 'img' && !isChromeAsset(l.href)) insAtt.run(l.href, url, channel, 'img');
  }
  await downloadAttachments(url, relDir);

  const insOut = db.prepare('INSERT OR IGNORE INTO outbound (url, doc_url, kind, title) VALUES (?,?,?,?)');
  for (const l of links) {
    if (l.type !== 'a' || isSameHost(l.href)) continue;
    insOut.run(l.href, url, 'external', C.tsv(l.text));
  }

  db.prepare('UPDATE docs SET status=' + Q('done') + ', attempts=attempts+1, rel_dir=?, err=NULL, fetched_at=' + T() + ', updated_at=' + T() + ' WHERE url=?').run(relDir, url);
  return 'done';
}

async function downloadAttachments(docUrl, relDir) {
  const rows = db.prepare('SELECT * FROM attachments WHERE doc_url=? AND status=' + Q('queued') + ' ORDER BY kind').all(docUrl);
  if (!rows.length) return;
  const absDir = path.join(DATA_ROOT, relDir);
  const up = db.prepare('UPDATE attachments SET status=?, size=?, rel_path=?, err=?, fetched_at=' + T() + ', updated_at=' + T() + ' WHERE url=?');
  for (const row of rows) {
    try {
      await C.sleepRandom(C.CFG.ATT_DELAY[0], C.CFG.ATT_DELAY[1]);
      const r = await C.getWithRetries(row.url, { binary: true, timeout: 120000, retries: [5000, 15000, 45000] });
      if (r.status === 200 || r.status === 206) {
        const u = new URL(row.url);
        const base = decodeURIComponent(path.basename(u.pathname)) || 'file';
        const name = C.sanitizeName(base);
        const kindDir = row.kind === 'img' ? 'img' : 'file';
        const attDir = path.join(absDir, 'attachments', kindDir);
        fs.mkdirSync(attDir, { recursive: true });
        const abs = path.join(attDir, name);
        if (fs.existsSync(abs)) fs.unlinkSync(abs);
        fs.writeFileSync(abs, r.body);
        const rel = path.posix.join(relDir, 'attachments', kindDir, name);
        up.run('done', r.body.length, rel, null, row.url);
      } else {
        up.run('failed', null, null, 'http ' + r.status, row.url);
      }
    } catch (e) {
      up.run('failed', null, null, (e.message || '').slice(0, 200), row.url);
    }
  }
}

/* ============ LISTS ARCHIVE ============ */
async function archiveChannelLists() {
  const chans2 = db.prepare('SELECT channel, MIN(priority) p FROM docs GROUP BY channel ORDER BY p, channel').all();
  const insList = db.prepare('INSERT INTO lists (url, channel, status, rel_dir, err, fetched_at, updated_at) VALUES (?,?,?,?,?,' + T() + ',' + T() + ') ON CONFLICT(url) DO UPDATE SET status=excluded.status, rel_dir=excluded.rel_dir, err=excluded.err, fetched_at=' + T() + ', updated_at=' + T());
  for (const ch of chans2) {
    const url = C.CFG.WWW + '/' + ch.channel + '/';
    const exists = db.prepare('SELECT status FROM lists WHERE url=?').get(url);
    if (exists && exists.status === 'done') continue;
    try {
      await C.sleepRandom(C.CFG.LIST_DELAY[0], C.CFG.LIST_DELAY[1]);
      const r = await C.getWithRetries(url, { retries: [5000, 15000] });
      if (r.status === 200) {
        const relDir = path.posix.join(ch.channel, '_lists');
        const absDir = path.join(DATA_ROOT, relDir);
        fs.mkdirSync(absDir, { recursive: true });
        fs.writeFileSync(path.join(absDir, 'index.html'), r.body);
        const htmlStr = C.decodeHtml(r.body);
        const meta = extractMeta(htmlStr);
        const txt = ['栏目: ' + C.tsv(meta.columnname || ch.channel), '列表页: ' + url, '抓取时间: ' + new Date().toISOString(), '======== 页面文本 ========', C.cleanWs(C.stripTags(htmlStr))].join(NL());
        fs.writeFileSync(path.join(absDir, 'index.txt'), txt, 'utf8');
        insList.run(url, ch.channel, 'done', relDir, null);
      } else {
        insList.run(url, ch.channel, 'failed', null, 'http ' + r.status);
      }
    } catch (e) {
      insList.run(url, ch.channel, 'failed', null, (e.message || '').slice(0, 200));
    }
  }
  const doneN = db.prepare('SELECT COUNT(*) c FROM lists WHERE status=' + Q('done')).get().c;
  log('LISTS archive done: ' + doneN + '/' + chans2.length);
}

/* ============ CRAWL LOOP ============ */
async function crawlDocs() {
  if (RETRY_FAILED) {
    db.exec('UPDATE docs SET status=' + Q('queued') + ', err=NULL WHERE status=' + Q('failed'));
    log('retry-failed: requeued all failed docs');
  }
  log('CRAWL start');
  const sel = 'SELECT * FROM docs WHERE status=' + Q('queued') +
    (CHANNEL_FILTER ? ' AND channel IN (' + CHANNEL_FILTER.map(function () { return '?'; }).join(',') + ')' : '') +
    ' ORDER BY priority ASC, COALESCE(NULLIF(pubdate, ' + Q('') + '), NULLIF(docreltime, ' + Q('') + '), ' + Q('0000-00-00') + ') DESC';
  const params = CHANNEL_FILTER ? CHANNEL_FILTER.slice() : [];
  const totalQueued = db.prepare('SELECT COUNT(*) c FROM docs WHERE status=' + Q('queued')).get().c;
  log('queued docs: ' + totalQueued);
  let done = 0, failed = 0, touched = 0;
  const startT = Date.now();
  const batchSize = LIMIT > 0 ? Math.min(LIMIT, 200) : 200;
  while (true) {
    const rows = db.prepare(sel + ' LIMIT ' + batchSize).all(...params);
    if (!rows.length) break;
    for (const row of rows) {
      if (LIMIT > 0 && touched >= LIMIT) break;
      const st = db.prepare('SELECT status FROM docs WHERE url=?').get(row.url);
      if (!st || st.status !== 'queued') continue;
      touched++;
      try {
        const res = await processDoc(row);
        if (res === 'done') done++; else failed++;
      } catch (e) {
        failed++;
        db.prepare('UPDATE docs SET status=' + Q('failed') + ', attempts=attempts+1, err=?, updated_at=' + T() + ' WHERE url=?').run((e.message || '').slice(0, 200), row.url);
      }
      if (touched % 25 === 0) {
        writeProgress({ phase: 'crawl', done: done, failed: failed, touched: touched });
        const el = (Date.now() - startT) / 1000;
        log('CRAWL progress touched=' + touched + ' done=' + done + ' failed=' + failed + ' rate=' + (el > 0 ? (done / el).toFixed(3) : 0) + '/s');
      }
      if (LIMIT > 0 && touched >= LIMIT) break;
      const d = DELAY_MS > 0 ? DELAY_MS : Math.round(C.rnd(C.CFG.ARTICLE_DELAY[0], C.CFG.ARTICLE_DELAY[1]));
      await C.sleep(d);
    }
    if (LIMIT > 0 && touched >= LIMIT) break;
    const left = db.prepare('SELECT COUNT(*) c FROM docs WHERE status=' + Q('queued')).get().c;
    if (!left) break;
  }
  const el2 = (Date.now() - startT) / 1000;
  log('CRAWL loop end touched=' + touched + ' done=' + done + ' failed=' + failed + ' elapsed=' + Math.round(el2) + 's');
  writeProgress({ phase: 'crawl-done', done: done, failed: failed, touched: touched });
}

/* ============ MAIN ============ */
(async function () {
  log('=== crawler start args: ' + args.join(' ') + ' ===');
  const wantEnum = args.indexOf('--enum') >= 0 || ONLY_ENUM;
  const enumDone = metaGet('enum_done', '0') === '1';
  if (wantEnum || (!enumDone && !NO_CRAWL && !CHANNEL_FILTER && !args.includes('--lists-only'))) {
    await enumAll();
  }
  if (ONLY_ENUM) { log('=== crawler end (enum only) ==='); return; }
  if (args.indexOf('--lists-only') >= 0) { await archiveChannelLists(); log('=== crawler end (lists only) ==='); return; }
  if (!NO_CRAWL) await crawlDocs();
  if (args.indexOf('--then-lists') >= 0) await archiveChannelLists();
  log('=== crawler end ===');
  writeProgress({ phase: 'finished' });
})().catch(function (e) { log('FATAL ' + (e && e.stack ? e.stack : e)); process.exit(1); });
