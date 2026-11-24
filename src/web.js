'use strict';

// 本地网页操作端：在回环地址上开一个 HTTP 服务，用浏览器完成日常操作
// （看状态、切节点、连接、断开）。
//
// 安全约束：
//   - 只监听 127.0.0.1，不对外暴露，也不提供改成外网地址的选项
//   - 所有 /api/* 都要求带一次性令牌（启动时随机生成，随地址一起给页面）
//     浏览器里的恶意页面读不到本机地址栏里的令牌，也就调不动这些接口

const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const proc = require('./process');
const proxy = require('./proxy');
const nodes = require('./nodes');
const lifecycle = require('./lifecycle');
const { PAGE } = require('./web-page');
const { fail } = require('./errors');
const { resolveExe } = require('./system');

const HOST = '127.0.0.1';
const MAX_BODY = 64 * 1024;
const COOKIE_NAME = 'metactl_token';

// 从 Cookie 里取令牌：用户从 metactl web 打开过一次之后，
// 直接访问根路径（没带 ?token=）也能继续用，不会因为丢了地址参数就废掉。
function cookieToken(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === COOKIE_NAME) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); }
      catch (_) { return null; }
    }
  }
  return null;
}

function clampPort(value, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1024 || n > 65535) return fallback;
  return n;
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    // 必须按字节攒完再一次性解码：中文是 3 字节 UTF-8，
    // 边收边 toString 的话，一个汉字被切在两个数据块之间就会解成乱码。
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { tooLarge = true; req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) { resolve(null); return; }
      let raw = '';
      try { raw = Buffer.concat(chunks).toString('utf8'); } catch (_) { resolve(null); return; }
      try { resolve(JSON.parse(raw || '{}')); } catch (_) { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

// 注册表读不到时不能把整个页面拖垮：状态照常给，代理那一栏显示未知。
function safeProxyState(ctx) {
  try {
    const s = proxy.current();
    return { enabled: !!s.enabled, server: s.server || null, error: null };
  } catch (e) {
    return { enabled: false, server: null, error: (e && e.code) || 'E_UNKNOWN' };
  }
}

function groupRowsFull(proxies) {
  return nodes.groupRows(proxies).map((g) => {
    const d = nodes.groupDetail(proxies, g.name);
    return {
      name: g.name,
      type: g.type,
      now: g.now,
      switchable: g.switchable,
      candidates: d ? d.candidates : [],
    };
  });
}

async function statusPayload(ctx) {
  const st = proc.status(ctx);
  const px = safeProxyState(ctx);
  const out = {
    ok: true,
    running: !!st.running,
    pid: st.pid || null,
    proxy: px,
    mixedPort: ctx.cfg.ports.mixedPort,
    controller: ctx.cfg.ports.externalController,
    mode: ctx.cfg.mode,
    version: null,
    groups: [],
  };
  if (!st.running) return out;

  const v = await proc.controllerRequest(ctx, '/version', 1500);
  if (v && v.data && v.data.version) out.version = String(v.data.version);
  const c = await proc.controllerRequest(ctx, '/configs', 3000);
  if (c && c.data && c.data.mode) out.mode = String(c.data.mode);
  const px2 = await proc.controllerRequest(ctx, '/proxies', 5000);
  if (px2 && px2.data && px2.data.proxies) out.groups = groupRowsFull(px2.data.proxies);
  return out;
}

async function handleApi(ctx, pathname, req, body) {
  if (pathname === '/api/status' && req.method === 'GET') return statusPayload(ctx);

  if (pathname === '/api/groups' && req.method === 'GET') {
    const proxies = await nodes.loadProxies(ctx);
    return { ok: true, groups: groupRowsFull(proxies) };
  }

  if (pathname === '/api/select' && req.method === 'POST') {
    const group = body && body.group ? String(body.group) : '';
    const node = body && body.node ? String(body.node) : '';
    if (!group || !node) {
      fail('E_USAGE', '缺少策略组或节点名', '请求体需要 group 与 node 两个字段');
    }
    const r = await nodes.switchNode(ctx, group, node, { save: true });
    return { ok: true, selected: r };
  }

  if (pathname === '/api/connect' && req.method === 'POST') {
    return Object.assign({ ok: true }, await lifecycle.connect(ctx));
  }

  if (pathname === '/api/disconnect' && req.method === 'POST') {
    return Object.assign({ ok: true }, await lifecycle.disconnect(ctx, false));
  }

  if (pathname === '/api/start' && req.method === 'POST') {
    const r = await lifecycle.startKernel(ctx);
    return { ok: true, kernel: r };
  }

  if (pathname === '/api/stop' && req.method === 'POST') {
    const r = await proc.stop(ctx);
    return { ok: true, stopped: !!r.stopped, pid: r.pid || null };
  }

  fail('E_USAGE', `未知接口: ${req.method} ${pathname}`, '可用接口见 README');
}

function makeHandler(ctx, token) {
  return async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://' + HOST); }
    catch (_) { res.writeHead(400); res.end('bad request'); return; }
    const pathname = url.pathname;

    if (pathname === '/' || pathname === '/index.html') {
      const headers = {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      };
      // 地址里带了正确的令牌就顺手存进 Cookie，之后刷新或直接访问根路径都还能用
      const q = url.searchParams.get('token');
      if (q && q === token) {
        headers['Set-Cookie'] = COOKIE_NAME + '=' + encodeURIComponent(token)
          + '; Path=/; SameSite=Strict; Max-Age=86400';
      }
      res.writeHead(200, headers);
      res.end(PAGE);
      return;
    }

    if (pathname.indexOf('/api/') !== 0) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }

    const given = req.headers['x-metactl-token'] || url.searchParams.get('token') || cookieToken(req);
    if (!given || given !== token) {
      json(res, 403, {
        ok: false,
        error: { code: 'E_WEB_FORBIDDEN', message: '令牌无效', hint: '请用 metactl web 输出的地址打开本页面' },
      });
      return;
    }

    let body = {};
    if (req.method === 'POST') {
      const b = await readBody(req);
      if (b === null) {
        json(res, 400, { ok: false, error: { code: 'E_USAGE', message: '请求体不是合法 JSON' } });
        return;
      }
      body = b;
    }

    try {
      const out = await handleApi(ctx, pathname, req, body);
      json(res, 200, out);
    } catch (e) {
      json(res, 200, {
        ok: false,
        error: {
          code: (e && e.code) || 'E_UNKNOWN',
          message: ctx.logger.maskText((e && e.message) || String(e)),
          hint: ctx.logger.maskText((e && e.hint) || ''),
        },
      });
    }
  };
}

// 启动服务。返回 { server, token, port, url }。
async function startServer(ctx, options) {
  const o = options || {};
  const port = clampPort(o.port, ctx.cfg.webPort || 17893);

  // 先自己 listen 一下，端口被占用时给可读诊断，而不是抛一个裸的 EADDRINUSE
  const probe = await proc.probePort(port);
  if (!probe.ok && probe.code === 'EADDRINUSE') {
    fail('E_WEB_PORT_IN_USE', `网页端口 ${port} 已被占用`,
      '请用 metactl web --port <其他端口> 换一个端口');
  }

  const token = crypto.randomBytes(16).toString('hex');
  const server = http.createServer(makeHandler(ctx, token));

  await new Promise((resolve, reject) => {
    const onError = (e) => {
      // fail() 是抛异常的，事件回调里抛会变成未捕获异常，必须转成 reject
      try {
        if (e && e.code === 'EADDRINUSE') {
          fail('E_WEB_PORT_IN_USE', `网页端口 ${port} 已被占用`,
            '请用 metactl web --port <其他端口> 换一个端口');
        }
        reject(e);
      } catch (err) {
        reject(err);
      }
    };
    server.once('error', onError);
    server.listen(port, HOST, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  return {
    server,
    token,
    port,
    host: HOST,
    url: 'http://' + HOST + ':' + port + '/?token=' + token,
  };
}

// 用系统默认浏览器打开地址。失败也不影响服务本身。
function openBrowser(url) {
  try {
    const child = spawn(resolveExe('cmd.exe'), ['/c', 'start', '', url], {
      detached: true, windowsHide: true, stdio: 'ignore',
    });
    child.on('error', () => { /* 打不开就算了，地址已打印 */ });
    child.unref();
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  HOST, startServer, openBrowser, makeHandler, statusPayload, groupRowsFull,
  safeProxyState, clampPort, json, readBody,
};
