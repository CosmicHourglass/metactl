'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { PROCESS } = require('./constants');
const { fail, wrap } = require('./errors');
const { writeAtomic, readJson, cleanTmp } = require('./paths');
const { runSync } = require('./system');
const { ctlHost, ctlPort } = require('./config');

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

function configHash(p) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(p.configYaml)).digest('hex').slice(0, 16);
  } catch (_) { return null; }
}

// 端口探测：内核启动前先自己试着 listen，捕 EADDRINUSE 给出可读诊断。
function probePort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    let settled = false;
    const finish = (ok, code) => {
      if (settled) return;
      settled = true;
      try { srv.close(); } catch (_) { /* ignore */ }
      resolve({ port, ok, code: code || null });
    };
    srv.once('error', (e) => finish(false, e.code));
    srv.once('listening', () => finish(true));
    try { srv.listen(port, '127.0.0.1'); }
    catch (e) { finish(false, e.code); }
  });
}

function portOwner(port) {
  try {
    const r = runSync('netstat.exe', ['-ano', '-p', 'TCP']);
    const re = new RegExp('^\\s*TCP\\s+\\S+:' + port + '\\s+\\S+\\s+LISTENING\\s+(\\d+)', 'im');
    const m = re.exec(r.stdout || '');
    if (!m) return null;
    const pid = m[1];
    const t = runSync('tasklist.exe', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH']);
    const im = /"([^"]+\.exe)"/i.exec(t.stdout || '');
    return { pid, image: im ? im[1] : 'unknown' };
  } catch (_) { return null; }
}

async function checkPorts(ctx) {
  const { cfg } = ctx;
  const ports = [cfg.ports.mixedPort, cfg.ports.socksPort, cfg.ports.port, ctlPort(cfg)];
  const results = [];
  for (const port of ports) results.push(await probePort(port));
  const busy = results.filter((r) => !r.ok && r.code === 'EADDRINUSE');
  if (busy.length) {
    const details = busy.map((r) => {
      const owner = portOwner(r.port);
      return `${r.port}${owner ? ` (PID ${owner.pid} ${owner.image})` : ''}`;
    }).join(', ');
    fail('E_PORT_IN_USE', `端口被占用: ${details}`,
      '请修改 .runtime/config.json 的 ports 段后重新 init，或结束占用该端口的程序');
  }
  const other = results.filter((r) => !r.ok && r.code !== 'EADDRINUSE');
  if (other.length) {
    fail('E_PORT_IN_USE', `端口探测异常: ${other.map((r) => `${r.port}(${r.code})`).join(', ')}`,
      '请检查本机网络栈与防火墙设置');
  }
  return true;
}

// 返回 { ok, image }：ok=false 表示 tasklist 不可用（受限终端/被安全策略拦截），
// 此时不能因为拿不到映像名就误判 PID 复用并清掉进程记录。
function imageNameOf(pid) {
  try {
    const r = runSync('tasklist.exe', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH']);
    const m = /"([^"]+\.exe)"/i.exec(r.stdout || '');
    return { ok: true, image: m ? m[1] : null };
  } catch (_) { return { ok: false, image: null }; }
}

function clearPid(p) {
  try { fs.rmSync(p.pidJson, { force: true }); } catch (_) { /* ignore */ }
}

// PID 复用防护：进程存在 + 映像名是 mihomo.exe + 实例指纹一致，三重核对。
function status(ctx) {
  const { p, migration } = ctx;
  const rec = readJson(p.pidJson, null);
  if (!rec || !Number.isInteger(rec.pid) || rec.pid <= 0) {
    return { running: false, reason: 'no-pid' };
  }
  let alive = false;
  try { process.kill(rec.pid, 0); alive = true; }
  catch (e) { alive = e && e.code === 'EPERM'; }
  if (!alive) { clearPid(p); return { running: false, reason: 'pid-dead' }; }

  const im = imageNameOf(rec.pid);
  if (!im.ok) {
    // 命令不可用时保守处理：进程存活即认为在运行，避免误清 PID
    return {
      running: true, unverified: true,
      pid: rec.pid,
      startedAt: rec.startedAt || null,
      imageName: null,
      configSha256: rec.configSha256 || null,
      instanceId: rec.instanceId || null,
    };
  }
  // 映像名必须是本工具的内核。新版是 mihomo-metactl.exe，
  // 0.2.x 升级上来时老的 mihomo.exe 仍在跑，也要认，否则会误判成 PID 复用。
  const knownImages = [PROCESS.imageName].concat(PROCESS.legacyImageNames || [])
    .map((n) => String(n).toLowerCase());
  if (!im.image || knownImages.indexOf(String(im.image).toLowerCase()) < 0) {
    clearPid(p);
    return { running: false, reason: 'pid-reused', image: im.image };
  }
  if (rec.instanceId && migration && migration.instanceId && rec.instanceId !== migration.instanceId) {
    clearPid(p);
    return { running: false, reason: 'foreign-pid' };
  }
  return {
    running: true,
    pid: rec.pid,
    startedAt: rec.startedAt || null,
    imageName: im.image,
    configSha256: rec.configSha256 || null,
    instanceId: rec.instanceId || null,
  };
}

function controllerRequest(ctx, apiPath, timeoutMs) {
  const { cfg } = ctx;
  return new Promise((resolve) => {
    const req = http.request({
      host: ctlHost(cfg), port: ctlPort(cfg), path: apiPath, method: 'GET',
      headers: { Authorization: 'Bearer ' + (cfg.controllerSecret || ''), Accept: 'application/json' },
      timeout: timeoutMs || 1200,
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(body); } catch (_) { /* 保留原始 */ }
        resolve({ status: res.statusCode, data, body });
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function waitHealthy(ctx) {
  const deadline = Date.now() + PROCESS.healthMaxMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await controllerRequest(ctx, '/version', 1000);
    if (last && last.status === 200) return last;
    if (last && (last.status === 401 || last.status === 403)) {
      fail('E_HEALTH_UNAUTHORIZED', '内核控制器拒绝了鉴权（secret 不匹配）',
        '请执行 metactl init 重新生成配置');
    }
    await delay(PROCESS.healthIntervalMs);
  }
  const st = status(ctx);
  if (!st.running) {
    fail('E_KERNEL_EXIT', '内核启动后立即退出',
      '请查看 .runtime/logs/mihomo.err.log 与 .runtime/logs/mihomo.log');
  }
  fail('E_HEALTH_TIMEOUT', '内核已启动，但控制器在 15 秒内未就绪',
    '请查看 .runtime/logs/mihomo.err.log；可尝试 metactl restart');
}

async function start(ctx) {
  const { p, cfg, logger } = ctx;
  if (!fs.existsSync(p.mihomoExe) || !fs.existsSync(p.configYaml)) {
    fail('E_NOT_INITIALIZED', '尚未初始化（缺少内核或生成配置）',
      '请先执行 metactl init --sub <订阅地址>');
  }
  const st = status(ctx);
  if (st.running) {
    fail('E_ALREADY_RUNNING', `内核已在运行 (PID ${st.pid})`,
      '如需重启请执行 metactl restart');
  }
  await checkPorts(ctx);
  cleanTmp(p);

  let outFd;
  let errFd;
  try {
    outFd = fs.openSync(p.logOut, 'a');
    errFd = fs.openSync(p.logErr, 'a');
  } catch (e) {
    if (outFd != null) fs.closeSync(outFd);
    throw wrap('E_SPAWN_FAILED', '无法打开日志文件', '请检查 .runtime/logs 目录权限', e);
  }

  let child;
  try {
    child = spawn(p.mihomoExe, [
      '-f', path.resolve(p.configYaml),
      '-d', path.resolve(p.dataDir),
    ], {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', outFd, errFd],
      cwd: path.resolve(p.runtime),
    });
    child.unref();
  } catch (e) {
    throw wrap('E_SPAWN_FAILED', '启动内核进程失败', '请查看 .runtime/logs/metactl.log', e);
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }

  if (!child.pid) {
    throw wrap('E_SPAWN_FAILED', '内核进程未返回 PID', '请查看 .runtime/logs/mihomo.err.log');
  }

  const rec = {
    pid: child.pid,
    startedAt: new Date().toISOString(),
    imageName: PROCESS.imageName,
    configSha256: configHash(p),
    instanceId: ctx.migration.instanceId,
  };
  writeAtomic(p.pidJson, JSON.stringify(rec, null, 2) + '\n');
  logger.debug(`spawned pid=${child.pid}`);

  const health = await waitHealthy(ctx);
  return Object.assign({}, rec, {
    version: health && health.data && health.data.version ? health.data.version : null,
  });
}

async function stop(ctx) {
  const { p } = ctx;
  const st = status(ctx);
  if (!st.running) {
    clearPid(p);
    return { stopped: false, reason: st.reason };
  }
  const r = runSync('taskkill.exe', ['/PID', String(st.pid), '/T', '/F']);
  if (r.code !== 0) {
    fail('E_STOP_FAILED', `终止进程失败 (PID ${st.pid})`,
      '可手动在任务管理器结束 mihomo.exe，或查看 .runtime/logs/metactl.log');
  }
  const deadline = Date.now() + PROCESS.stopWaitMs;
  while (Date.now() < deadline) {
    let alive = false;
    try { process.kill(st.pid, 0); alive = true; }
    catch (e) { alive = e && e.code === 'EPERM'; }
    if (!alive) break;
    await delay(200);
  }
  clearPid(p);
  return { stopped: true, pid: st.pid };
}

module.exports = {
  probePort, checkPorts, portOwner, imageNameOf, clearPid, configHash,
  status, controllerRequest, waitHealthy, start, stop,
};
