'use strict';
const https = require('https');
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const CFG = {
  WWW: 'https://www.pingtan.gov.cn',
  MIRROR: 'https://218.106.148.33:8443',
  API: 'https://www.pingtan.gov.cn/fjdzapp/search',
  UA: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) PingtanGovArchiveBot/1.0 (public-data archiving; contact: changwu@yeah.net)',
  ARTICLE_DELAY: [1000, 2000],
  LIST_DELAY: [1200, 2200],
  ATT_DELAY: [1200, 2200],
  RETRIES: [5000, 15000, 45000, 120000],
  TIMEOUT: 60000,
  ATT_SIZE_GIT_LIMIT: 25 * 1024 * 1024
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rnd(a, b) { return a + Math.random() * (b - a); }

function isHtmlBlockedBody(buf) {
  // www WAF sometimes returns tiny empty html body (2 bytes) for articles
  return buf.length < 300;
}

// Removed documents redirect to their parent listing with a tiny meta-refresh stub:
//   <meta http-equiv="refresh" content="0;URL=../" />
// These are permanent (content gone), NOT a WAF block, so they must not burn retries.
function isMetaRefreshOnly(buf) {
  if (!buf || buf.length > 512) return false;
  const s = buf.toString('latin1').trim();
  if (!/^<meta\b/i.test(s)) return false;
  return /http-equiv\s*=\s*["']?refresh/i.test(s);
}

function requestRaw(url, opts) {
  return new Promise((resolve, reject) => {
    opts = opts || {};
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const headers = Object.assign({
      'User-Agent': CFG.UA,
      'Accept': opts.binary ? '*/*' : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Accept-Encoding': 'gzip, deflate'
    }, opts.headers || {});
    if (opts.body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(opts.body);
      headers['X-Requested-With'] = 'XMLHttpRequest';
      headers['Origin'] = CFG.WWW;
      headers['Referer'] = opts.referer || (CFG.WWW + '/zwgk/');
    }
    const req = mod.request(u, {
      rejectUnauthorized: false,
      method: opts.method || (opts.body ? 'POST' : 'GET'),
      headers: headers,
      timeout: opts.timeout || CFG.TIMEOUT
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        const enc = (res.headers['content-encoding'] || '').toLowerCase();
        try {
          if (enc === 'gzip') buf = zlib.gunzipSync(buf);
          else if (enc === 'deflate') buf = zlib.inflateSync(buf);
          else if (enc === 'br') buf = zlib.brotliDecompressSync(buf);
        } catch (e) {
          // keep compressed bytes on decode failure
        }
        resolve({ status: res.statusCode, headers: res.headers, body: buf, finalUrl: url });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', e => {
      // Node sometimes reports ECONNRESET etc.
      reject(e);
    });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// GET with redirect following (max 6) and one warm-up retry for blocked small bodies
async function getWithRetries(url, opts) {
  opts = opts || {};
  let lastErr = null;
  const delays = opts.retries || CFG.RETRIES;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const r = await requestRaw(url, opts);
      if (r.status >= 300 && r.status < 400 && r.headers.location && (opts.followRedirects !== false)) {
        const next = new URL(r.headers.location, url).toString();
        // log redirect via caller? keep quiet, just follow
        return getWithRetries(next, opts);
      }
      const badSmall = !opts.binary && (r.headers['content-type'] || '').includes('text/html') && isHtmlBlockedBody(r.body);
      // permanent removal stub (meta-refresh to parent): return as-is, caller records it as gone
      if (badSmall && !opts.binary && isMetaRefreshOnly(r.body)) {
        return { status: r.status, headers: r.headers, body: r.body, metaRefreshOnly: true, finalUrl: url };
      }
      if ((r.status === 200 || r.status === 206) && !badSmall) return r;
      if (r.status >= 400 && r.status < 500) {
        return { status: r.status, headers: r.headers, body: r.body, blocked: false, finalUrl: url }; // no retry on 4xx
      }
      if (badSmall && attempt === 0) {
        // WAF blip: warm up with homepage, then retry once
        try { await requestRaw(CFG.WWW + '/zwgk/', { timeout: 30000 }); } catch (e) {}
        lastErr = new Error('blocked-small-body(status ' + r.status + ') attempt 0 -> warmup');
        continue;
      }
      lastErr = new Error('bad status ' + r.status + ' attempt ' + attempt);
      if (attempt < delays.length) await sleep(delays[attempt]);
    } catch (e) {
      lastErr = e;
      if (attempt < delays.length) await sleep(delays[attempt]);
    }
  }
  throw lastErr || new Error('get failed');
}

// decode buffer to string: try utf-8, if lots of replacement chars try gb18030
function decodeHtml(buf) {
  try {
    const t1 = new TextDecoder('utf-8', { fatal: false });
    const s1 = t1.decode(buf);
    const bad = (s1.match(/\uFFFD/g) || []).length;
    const pct = bad / Math.max(1, s1.length);
    if (pct < 0.02) return s1;
    const t2 = new TextDecoder('gb18030');
    return t2.decode(buf);
  } catch (e) {
    return buf.toString('utf8');
  }
}

function stripTags(s) { return s.replace(/<[^>]*>/g, ''); }
function cleanWs(s) { return s.replace(/[\t\u00a0\u3000]+/g, ' ').replace(/[ \r\n]+/g, ' ').trim(); }

// escape TSV field
function tsv(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[\t\r\n]/g, ' ').trim();
}

function sanitizeName(name) {
  let s = String(name).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/[. ]+$/g, '');
  if (!s) s = 'unnamed';
  if (s.length > 120) s = s.slice(0, 120);
  return s;
}

// From a doc URL pathname derive: {channel, yyyymm, docid, isBinary, filename}
function parseDocPath(pathname) {
  const seg = pathname.split('/').filter(Boolean);
  const filename = seg[seg.length - 1] || '';
  const isBinary = /\.(docx?|pdf|xlsx?|pptx?|zip|rar|7z|wps|ofd|txt|csv|jpg|jpeg|png|gif|bmp|webp|svg|ico)([?#]|$)/i.test(filename);
  let dateSeg = null;
  let idir = seg.length - 1;
  // find the YYYYMM segment (just before filename usually)
  if (seg.length >= 2 && /^\d{6}$/.test(seg[seg.length - 2])) { dateSeg = seg[seg.length - 2]; idir = seg.length - 2; }
  // docid from filename t20..._NNNN or from P0 files
  let docid = null;
  const m = filename.match(/t20\d{6}_(\d{4,})/);
  if (m) docid = m[1];
  else {
    const m2 = filename.match(/(\d{6,})/);
    if (m2) docid = m2[1];
  }
  const channel = seg.slice(0, idir).join('/');
  return { seg, filename, isBinary, dateSeg, docid, channel };
}

function channelLandingUrl(channel) {
  return CFG.WWW + '/' + channel + '/';
}

function sleepRandom(a, b) { return sleep(rnd(a, b)); }

module.exports = { CFG, sleep, rnd, requestRaw, getWithRetries, decodeHtml, stripTags, cleanWs, tsv, sanitizeName, parseDocPath, channelLandingUrl, sleepRandom, isHtmlBlockedBody, isMetaRefreshOnly };