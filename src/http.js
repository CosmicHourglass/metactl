'use strict';

// 自封 HTTPS：Node 16 没有全局 fetch，且 GitHub 下载会 302 到另一个 host，
// 需要剥离凭据、自定义 UA、流式算 sha256、区分「可重试网络错误」与「业务 HTTP 错误」。
// 另外支持标准 HTTP(S)_PROXY 环境变量（CONNECT 隧道），便于受限网络下下载内核。
const httpMod = require('http');
const httpsMod = require('https');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HTTP } = require('./constants');
const { AppError, wrap } = require('./errors');

const NET_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN',
  'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNABORTED', 'ESOCKETTIMEDOUT',
]);

function isRetryable(err) {
  if (!err) return false;
  if (err instanceof AppError) return false;
  if (err.code && NET_CODES.has(err.code)) return true;
  return /socket hang up|connect timeout|read timeout|timed out/i.test(String(err.message || ''));
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function failure(opts, cause) {
  return wrap(
    opts.errorCode || 'E_SUB_FETCH_FAILED',
    opts.errorMessage || '网络请求失败',
    opts.errorHint || '请检查网络连接后重试',
    cause
  );
}

// 读取标准代理环境变量；NO_PROXY 命中的目标不走代理。
function proxyFor(targetUrl) {
  let raw = process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy || '';
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = 'http://' + raw;
  try {
    const p = new URL(raw);
    if (targetUrl) {
      const host = new URL(targetUrl).hostname;
      const no = (process.env.NO_PROXY || process.env.no_proxy || '')
        .split(',').map((s) => s.trim()).filter(Boolean);
      for (const n of no) {
        if (n === '*') return null;
        const bare = n.replace(/^\./, '');
        if (host === bare || host.endsWith('.' + bare)) return null;
      }
    }
    return p.toString();
  } catch (_) { return null; }
}

// 通过 HTTP 代理建立到目标的 TLS 隧道，返回已握手的 tls.TLSSocket。
function connectViaProxy(proxyRaw, target, opts) {
  return new Promise((resolve, reject) => {
    const p = new URL(proxyRaw);
    const port = Number(target.port) || 443;
    const headers = { Host: `${target.hostname}:${port}` };
    if (p.username) {
      const cred = decodeURIComponent(p.username) + ':' + decodeURIComponent(p.password || '');
      headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(cred, 'utf8').toString('base64');
    }
    const req = httpMod.request({
      host: p.hostname,
      port: Number(p.port) || 80,
      method: 'CONNECT',
      path: `${target.hostname}:${port}`,
      headers,
      timeout: (opts && opts.connectTimeoutMs) || HTTP.connectTimeoutMs,
    });
    req.on('connect', (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error('代理 CONNECT 返回 ' + res.statusCode));
        return;
      }
      const secure = tls.connect({ socket, servername: target.hostname });
      secure.once('secureConnect', () => resolve(secure));
      secure.once('error', reject);
      if (head && head.length) secure.unshift(head);
    });
    req.on('timeout', () => req.destroy(new Error('proxy connect timeout')));
    req.on('error', reject);
    req.end();
  });
}

// 重试策略：首次直连；若存在代理且首次是网络类错误，后续尝试改走代理。
// 这样在「只有代理能出网」和「直连即可」两种环境都能工作，且不拖慢正常路径。
async function withRetry(fn, opts) {
  const retries = opts.retries == null ? HTTP.retries : opts.retries;
  const explicitProxy = !!opts.proxy;
  const proxy = opts.allowProxy === false ? null : (opts.proxy || proxyFor(opts.url));
  let last = null;
  for (let i = 0; i <= retries; i++) {
    const attempt = Object.assign({}, opts, {
      proxy: proxy && (explicitProxy || i > 0) ? proxy : null,
    });
    try {
      return await fn(attempt);
    } catch (err) {
      if (err instanceof AppError) throw err;
      last = err;
      if (!isRetryable(err) || i === retries) break;
      await delay(HTTP.retryDelayMs * (i + 1));
    }
  }
  throw failure(opts, last);
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

// 单次请求，返回 { status, headers, res(流), url }。重定向在本层跟随。
function openOnce(urlStr, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); }
    catch (e) { reject(new Error('非法 URL: ' + urlStr)); return; }

    const mod = u.protocol === 'http:' ? httpMod : httpsMod;
    const headers = Object.assign({
      'User-Agent': o.userAgent || 'metactl/0.1',
      Accept: '*/*',
      'Accept-Encoding': 'identity',
      Connection: 'close',
    }, o.headers || {});

    const onResponse = (res) => {
      const sc = res.statusCode;
      const redirects = o.redirects || 0;
      if (REDIRECT_CODES.has(sc) && res.headers.location && redirects < HTTP.maxRedirects) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, u).toString(); }
        catch (e) { reject(new Error('重定向地址非法')); return; }
        const nextUrl = new URL(next);
        const nextHeaders = Object.assign({}, o.headers || {});
        const isCrossOrigin = nextUrl.origin !== u.origin;
        if (isCrossOrigin || sc === 303) {
          // 跨 host 不得携带任何凭据；GitHub release 资产下载就是这种情况
          for (const k of Object.keys(nextHeaders)) {
            if (/^(authorization|cookie|proxy-authorization)$/i.test(k)) delete nextHeaders[k];
          }
        }
        resolve(openOnce(next, Object.assign({}, o, {
          headers: nextHeaders,
          redirects: redirects + 1,
        })));
        return;
      }
      resolve({ status: sc, headers: res.headers, res, url: u.toString() });
    };

    const doRequest = (extra) => {
      const req = mod.request(u, Object.assign({
        method: o.method || 'GET',
        headers,
        timeout: o.connectTimeoutMs || HTTP.connectTimeoutMs,
      }, extra), onResponse);
      req.on('timeout', () => req.destroy(new Error('connect timeout')));
      req.on('error', reject);
      req.end();
    };

    if (o.proxy && u.protocol === 'https:') {
      connectViaProxy(o.proxy, u, o).then((secure) => {
        doRequest({ agent: false, createConnection: () => secure, servername: u.hostname });
      }).catch(reject);
      return;
    }
    doRequest({});
  });
}

function collect(r, opts) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    const timer = setTimeout(() => r.res.destroy(new Error('read timeout')),
      opts.readTimeoutMs || HTTP.readTimeoutMs);
    const done = (fn, arg) => { clearTimeout(timer); fn(arg); };
    r.res.on('data', (chunk) => {
      bytes += chunk.length;
      if (opts.maxBytes && bytes > opts.maxBytes) {
        r.res.destroy(new Error(`响应体过大 (${bytes} bytes)`));
        return;
      }
      chunks.push(chunk);
    });
    r.res.on('error', (e) => done(reject, e));
    r.res.on('end', () => done(resolve, {
      status: r.status, headers: r.headers, body: Buffer.concat(chunks), url: r.url,
    }));
  });
}

async function get(url, opts) {
  const o = Object.assign({ url }, opts || {});
  return withRetry(async (a) => {
    const r = await openOnce(url, a);
    return collect(r, a);
  }, o);
}

async function getJson(url, opts) {
  const o = Object.assign({ url }, opts || {});
  const r = await get(url, o);
  let data;
  try { data = JSON.parse(r.body.toString('utf8')); }
  catch (e) {
    throw new AppError(o.errorCode || 'E_GITHUB_API', '接口返回的不是合法 JSON',
      o.errorHint || '请稍后重试', e);
  }
  return Object.assign({}, r, { data });
}

function pipeToFile(res, dest, opts) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const ws = fs.createWriteStream(dest);
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => res.destroy(new Error('read timeout')),
      opts.readTimeoutMs || HTTP.readTimeoutMs);
    const failOnce = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.destroy(); } catch (_) { /* ignore */ }
      reject(err);
    };
    res.on('data', (chunk) => {
      bytes += chunk.length;
      if (opts.maxBytes && bytes > opts.maxBytes) {
        res.destroy(new Error(`下载体过大 (${bytes} bytes)`));
        return;
      }
      hash.update(chunk);
      ws.write(chunk);
      if (opts.onProgress) opts.onProgress(bytes);
    });
    res.on('error', failOnce);
    ws.on('error', failOnce);
    res.on('end', () => { clearTimeout(timer); ws.end(); });
    ws.on('finish', () => {
      if (settled) return;
      settled = true;
      resolve({ bytes, sha256: hash.digest('hex') });
    });
  });
}

async function download(url, dest, opts) {
  const o = Object.assign({ url }, opts || {});
  return withRetry(async (a) => {
    const r = await openOnce(url, a);
    if (r.status !== 200) {
      r.res.resume();
      throw new AppError(a.errorCode || 'E_KERNEL_DOWNLOAD_FAILED',
        `下载返回 HTTP ${r.status}`, a.errorHint || '请检查网络后重试');
    }
    try {
      return await pipeToFile(r.res, dest, a);
    } catch (err) {
      try { fs.rmSync(dest, { force: true }); } catch (_) { /* ignore */ }
      throw err;
    }
  }, o);
}

module.exports = {
  get, getJson, download, isRetryable, openOnce, proxyFor, connectViaProxy,
};
