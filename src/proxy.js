'use strict';

// HKCU 系统代理：无需管理员。改的是注册表（事实来源），
// PowerShell 只负责刷新让已打开的程序感知，刷新失败不影响结果。
const fs = require('fs');
const { REG } = require('./constants');
const { fail } = require('./errors');
const { runSync, encodedCommand } = require('./system');
const { writeAtomic, readJson } = require('./paths');
const { proxyServer } = require('./config');

const KEYS = [REG.enable, REG.server, REG.override];

function queryValue(name) {
  const r = runSync('reg.exe', ['query', REG.key, '/v', name]);
  if (r.code !== 0) return { exists: false, value: null, type: null };
  const m = /REG_(DWORD|SZ|EXPAND_SZ|BINARY|QWORD|MULTI_SZ)\s+(.*)/i.exec(r.stdout || '');
  if (!m) return { exists: true, value: null, type: null };
  return {
    exists: true,
    type: 'REG_' + m[1].toUpperCase(),
    value: m[2].replace(/\s+$/, ''),
  };
}

function snapshot() {
  const out = {};
  for (const k of KEYS) out[k] = queryValue(k);
  return out;
}

function current() {
  const s = snapshot();
  const en = s[REG.enable];
  return {
    enabled: !!(en && en.exists && /^(0x)?1$/i.test(String(en.value).trim())),
    server: s[REG.server] && s[REG.server].exists ? s[REG.server].value : null,
    override: s[REG.override] && s[REG.override].exists ? s[REG.override].value : null,
  };
}

function setValue(name, type, value) {
  const r = runSync('reg.exe', ['add', REG.key, '/v', name, '/t', type, '/d', String(value), '/f']);
  if (r.code !== 0) {
    fail('E_REG_FAILED', `写入注册表键 ${name} 失败`,
      '请在普通 cmd / PowerShell 终端运行；若被安全软件拦截请放行 reg.exe');
  }
}

function deleteValue(name) {
  // 键本来就不存在时 reg delete 会返回非 0，属正常情况
  runSync('reg.exe', ['delete', REG.key, '/v', name, '/f']);
}

function apply(ctx) {
  const { cfg } = ctx;
  setValue(REG.enable, 'REG_DWORD', '1');
  setValue(REG.server, 'REG_SZ', proxyServer(cfg));
  setValue(REG.override, 'REG_SZ', cfg.proxy.override);
}

function refresh(ctx) {
  const script = [
    "$sig = @'",
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class MetactlWinInet {',
    '  [DllImport("wininet.dll", SetLastError = true)]',
    '  public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);',
    '}',
    "'@",
    'Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue',
    '[MetactlWinInet]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null',
    '[MetactlWinInet]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null',
  ].join('\n');
  const r = runSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', encodedCommand(script),
  ], { timeout: 30000 });
  if (r.code !== 0) {
    ctx.logger.warn('系统代理刷新失败（注册表已写入，新打开的程序通常会生效；可重新打开浏览器或注销后重试）');
    return false;
  }
  return true;
}

// 只备份「用户原本的设置」。若备份已存在且属于当前实例，绝不覆盖，
// 否则连续两次 proxy on 会把 metactl 自己设的值当成原值，off 就恢复不回去了。
function backup(ctx) {
  const { p, migration } = ctx;
  const existing = readJson(p.proxyBackup, null);
  if (existing && existing.instanceId === migration.instanceId) return existing;
  const rec = {
    instanceId: migration.instanceId,
    appliedBy: 'metactl',
    createdAt: new Date().toISOString(),
    keys: snapshot(),
  };
  writeAtomic(p.proxyBackup, JSON.stringify(rec, null, 2) + '\n');
  return rec;
}

function restore(ctx, rec) {
  const keys = (rec && rec.keys) || {};
  for (const name of KEYS) {
    const item = keys[name];
    if (item && item.exists && item.value != null) {
      setValue(name, item.type || 'REG_SZ', item.value);
    } else {
      deleteValue(name);
    }
  }
}

function disableOnly() {
  setValue(REG.enable, 'REG_DWORD', '0');
}

function on(ctx) {
  const { p, cfg, logger } = ctx;
  const proc = require('./process').status(ctx);
  if (!proc.running) {
    fail('E_PROXY_NOT_RUNNING', '内核未运行，拒绝开启系统代理（否则会导致断网）',
      '请先执行 metactl start，再执行 metactl proxy on');
  }
  const rec = backup(ctx);
  try {
    apply(ctx);
    const check = current();
    if (!check.enabled || check.server !== proxyServer(cfg)) {
      fail('E_PROXY_SET_FAILED', '系统代理写入后回读校验不一致',
        '请检查注册表权限，或使用 --force 重试');
    }
  } catch (e) {
    // 写入中途失败：尽力还原到用户原本的状态
    try { restore(ctx, rec); } catch (_) { /* ignore */ }
    throw e;
  }
  const refreshed = refresh(ctx);
  logger.ok(`系统代理已开启 -> ${proxyServer(cfg)}`);
  logger.info('提醒: 关机或重启前执行 metactl proxy off；若忘记，开机后无法上网时执行 metactl fix 一键恢复');
  logger.info('提示: Node / curl / git 默认不读系统代理；验证请用浏览器，或 curl.exe -x http://' + proxyServer(cfg));
  return { server: proxyServer(cfg), refreshed, backupCreatedAt: rec.createdAt };
}

function off(ctx, force) {
  const { p, logger } = ctx;
  const rec = readJson(p.proxyBackup, null);

  if (!rec) {
    if (!force) {
      fail('E_PROXY_RESTORE_FAILED', '没有找到代理备份，无法精确恢复用户原有设置',
        '如只想关闭代理，可执行 metactl proxy off --force');
    }
    disableOnly();
    refresh(ctx);
    logger.warn('未提供备份，已仅将 ProxyEnable 置 0，未改动 ProxyServer / ProxyOverride');
    return { restored: false, disabled: true };
  }

  if (rec.instanceId !== ctx.migration.instanceId) {
    if (!force) {
      fail('E_PROXY_BACKUP_FOREIGN', '代理备份来自其他机器或项目路径，拒绝恢复',
        '可执行 metactl proxy off --force 仅关闭代理（不恢复），或忽略该备份');
    }
    disableOnly();
    refresh(ctx);
    logger.warn('外来备份，已仅将 ProxyEnable 置 0，未恢复其值');
    return { restored: false, disabled: true };
  }

  restore(ctx, rec);
  refresh(ctx);
  try { fs.rmSync(p.proxyBackup, { force: true }); } catch (_) { /* ignore */ }
  logger.ok('系统代理已关闭并恢复到开启前的设置');
  return { restored: true, disabled: false };
}

// 判断 ProxyServer 是否指向本工具的 mixed 端口。
// 兼容 "127.0.0.1:17890" 与 "http=127.0.0.1:17890;https=..." 这类多协议写法。
function isOurServer(value, cfg) {
  if (!value) return false;
  const s = String(value).toLowerCase();
  const ours = proxyServer(cfg).toLowerCase();
  return s === ours || s.includes(ours);
}

// 悬空代理：注册表仍指向本工具端口，内核却没在跑 —— 关机后开机断网的典型原因。
function isStale(state, cfg, running) {
  return !!(state && state.enabled && isOurServer(state.server, cfg) && !running);
}

function clearOurs(before, cfg) {
  disableOnly();
  // 只删确实由 metactl 写入的值，绝不误删用户自己的代理配置
  if (String(before.server || '').trim().toLowerCase() === proxyServer(cfg).toLowerCase()) {
    deleteValue(REG.server);
  }
  if (before.override && String(before.override).trim() === cfg.proxy.override) {
    deleteValue(REG.override);
  }
}

// 断网自救：幂等、不依赖内核运行、不依赖备份文件。
// 优先精确恢复 proxy on 前的原值；无备份则清理本工具写入的值；
// 遇到不是本工具设置的代理默认不动（--force 也只把 ProxyEnable 置 0，保留原值）。
function repair(ctx, force) {
  const { p, cfg } = ctx;
  const before = current();
  const rec = readJson(p.proxyBackup, null);
  const usable = !!(rec && rec.instanceId === ctx.migration.instanceId);
  const mine = isOurServer(before.server, cfg);

  if (!before.enabled && !mine) {
    return {
      changed: false, reason: 'already-off', mode: null,
      before, after: before, refreshed: false, refreshError: null,
    };
  }
  if (!mine && !usable && !force) {
    return {
      changed: false, reason: 'foreign-proxy', mode: null,
      before, after: before, refreshed: false, refreshError: null,
    };
  }

  let mode;
  if (usable) { restore(ctx, rec); mode = 'restored'; }
  else if (mine) { clearOurs(before, cfg); mode = 'cleared'; }
  else { disableOnly(); mode = 'disabled'; }

  let refreshed = false;
  let refreshError = null;
  try { refreshed = refresh(ctx); }
  catch (e) { refreshError = (e && e.code) || 'E_UNKNOWN'; }
  try { fs.rmSync(p.proxyBackup, { force: true }); } catch (_) { /* ignore */ }
  let after = null;
  try { after = current(); } catch (_) { after = before; }
  return { changed: true, reason: 'stale-proxy', mode, before, after, refreshed, refreshError };
}

module.exports = {
  queryValue, snapshot, current, on, off, apply, restore, refresh, backup,
  isOurServer, isStale, clearOurs, repair,
};
