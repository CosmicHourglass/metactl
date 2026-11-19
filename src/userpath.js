'use strict';

// 把项目目录写入当前用户的 PATH（HKCU\Environment\Path），让重开终端后
// 可以直接敲 metactl，而不必每次都写 node bin\cli.js 或手工配环境变量。
//
// 约束：只改 HKCU（无需管理员）、只追加不覆盖、幂等、写入后回读校验；
// 之后广播 WM_SETTINGCHANGE，让之后新开的进程继承新 PATH。
const { fail } = require('./errors');
const { runSync, encodedCommand } = require('./system');

const KEY = 'HKCU\\Environment';
const VALUE = 'Path';
const MAX_PATH_CHARS = 7000;

const NOTIFY_SCRIPT = [
  "$sig = @'",
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class MetactlEnvNotify {',
  '  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]',
  '  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);',
  '}',
  "'@",
  'Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue',
  '$res = [UIntPtr]::Zero',
  "[MetactlEnvNotify]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$res) | Out-Null",
].join('\n');

function parseQuery(stdout) {
  const m = /REG_(EXPAND_SZ|SZ)\s+(.*)/i.exec(String(stdout || ''));
  if (!m) return { exists: false, type: 'REG_EXPAND_SZ', value: '' };
  return {
    exists: true,
    type: 'REG_' + m[1].toUpperCase(),
    value: m[2].replace(/\s+$/, ''),
  };
}

function queryUserPath() {
  const r = runSync('reg.exe', ['query', KEY, '/v', VALUE]);
  if (r.code !== 0) return { exists: false, type: 'REG_EXPAND_SZ', value: '' };
  return parseQuery(r.stdout);
}

function norm(s) {
  return String(s == null ? '' : s).trim()
    .replace(/^"+|"+$/g, '')
    .replace(/[\\/]+$/, '')
    .toLowerCase();
}

function splitPath(value) {
  return String(value || '').split(';').filter((x) => String(x).trim().length);
}

function hasDir(value, dir) {
  const target = norm(dir);
  return splitPath(value).some((item) => norm(item) === target);
}

function buildValue(value, dir) {
  const base = String(value || '').replace(/;+\s*$/, '').trim();
  return base ? base + ';' + dir : dir;
}

// 广播是尽力而为：失败不影响已写入的注册表值，新开终端通常仍能继承。
function notify() {
  try {
    const r = runSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', encodedCommand(NOTIFY_SCRIPT),
    ], { timeout: 30000 });
    return r.code === 0;
  } catch (_) {
    return false;
  }
}

function ensure(dir) {
  const target = String(dir);
  const before = queryUserPath();
  if (hasDir(before.value, target)) {
    return {
      changed: false, reason: 'already-present', dir: target,
      type: before.type, exists: before.exists, notified: false,
    };
  }

  const next = buildValue(before.value, target);
  if (next.length > MAX_PATH_CHARS) {
    fail('E_PATH_TOO_LONG', '用户 PATH 过长，追加项目目录可能超出命令行限制',
      '请先在「编辑账户的环境变量」里清理无效条目，或改用 --no-path 跳过');
  }
  // 原本是 REG_SZ 就保持 REG_SZ；不存在或原本是 REG_EXPAND_SZ 则用后者（兼容 %VAR%）
  const type = before.exists && before.type === 'REG_SZ' ? 'REG_SZ' : 'REG_EXPAND_SZ';
  const w = runSync('reg.exe', ['add', KEY, '/v', VALUE, '/t', type, '/d', next, '/f']);
  if (w.code !== 0) {
    fail('E_PATH_WRITE', '写入用户 PATH 失败',
      '请在普通 cmd / PowerShell 终端运行；也可手动把项目目录加入用户 PATH');
  }
  const after = queryUserPath();
  if (!hasDir(after.value, target)) {
    fail('E_PATH_VERIFY', '写入用户 PATH 后回读校验失败',
      '请手动检查「编辑账户的环境变量」中的 Path');
  }
  const notified = notify();
  return {
    changed: true, reason: 'added', dir: target, type,
    length: next.length, notified,
  };
}

module.exports = {
  KEY, VALUE, MAX_PATH_CHARS,
  parseQuery, queryUserPath, norm, splitPath, hasDir, buildValue, notify, ensure,
};
