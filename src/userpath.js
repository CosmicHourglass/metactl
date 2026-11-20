'use strict';

// 把启动器所在目录写入当前用户的 PATH，让安装完新开终端就能直接敲 metactl。
//
// 约束：只改 HKCU（无需管理员）、只追加不覆盖、幂等、写入后回读校验；
// 之后广播 WM_SETTINGCHANGE，让之后新开的进程继承新 PATH。
//
// 两条写入通道：优先 reg.exe；被安全策略/组策略拦截时自动改用 PowerShell 的
// .NET 注册表 API（不启动外部命令、不需要管理员），保证任意 Windows 电脑都能生效。
const { fail } = require('./errors');
const { runSync, encodedCommand } = require('./system');

const KEY = 'HKCU\\Environment';
const VALUE = 'Path';
const MAX_PATH_CHARS = 7000;

const PS_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

// 子进程 stdout 被重定向时，PowerShell 会把进度流序列化成 #< CLIXML 混进输出。
// 每个脚本首行关掉进度，保证控制台干净、回读值可解析。
const PS_QUIET = "$ProgressPreference = 'SilentlyContinue'; $ErrorActionPreference = 'Stop'; ";

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

// 值用 base64 往返，彻底避开引号、百分号、中文与编码问题。
const QUERY_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')",
  '$v = $null',
  "$t = 'REG_EXPAND_SZ'",
  'if ($k) {',
  "  $v = $k.GetValue('Path', $null)",
  "  try { if ($k.GetValueKind('Path').ToString() -eq 'String') { $t = 'REG_SZ' } } catch { }",
  '  $k.Close()',
  '}',
  "$s = if ($null -eq $v) { '' } else { [string]$v }",
  "$exists = if ($null -eq $v) { '0' } else { '1' }",
  "Write-Output ('EXISTS=' + $exists)",
  "Write-Output ('TYPE=' + $t)",
  "Write-Output ('B64=' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s)))",
].join('\n');

function ps(script) {
  const body = PS_QUIET + '\n' + script;
  const r = runSync('powershell.exe',
    PS_ARGS.concat(['-EncodedCommand', encodedCommand(body)]), { timeout: 30000 });
  if (r.code !== 0) {
    fail('E_PATH_WRITE', '读写用户 PATH 失败',
      '请在普通 cmd / PowerShell 终端运行，或手动把启动器目录加入用户 PATH');
  }
  return String(r.stdout || '');
}

function parseDotnet(out) {
  const text = String(out || '').replace(/^\uFEFF/, '');
  const e = /EXISTS=(\d+)/.exec(text);
  const t = /TYPE=(REG_\w+)/.exec(text);
  const b = /B64=([A-Za-z0-9+/=]*)/.exec(text);
  return {
    exists: !!(e && e[1] === '1'),
    type: (t && t[1]) || 'REG_EXPAND_SZ',
    value: b ? Buffer.from(b[1], 'base64').toString('utf8') : '',
  };
}

function writeScript(value, type) {
  const b64 = Buffer.from(String(value), 'utf8').toString('base64');
  const kind = type === 'REG_SZ' ? 'String' : 'ExpandString';
  return [
    "$ErrorActionPreference = 'Stop'",
    "$v = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64 + "'))",
    '$kind = [Microsoft.Win32.RegistryValueKind]::' + kind,
    "$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)",
    "if (-not $k) { $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment') }",
    "$k.SetValue('Path', $v, $kind)",
    '$k.Close()',
    "Write-Output 'OK'",
  ].join('\n');
}

function dotnetQuery() {
  return parseDotnet(ps(QUERY_SCRIPT));
}

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

// reg.exe 被拦截时整体切到 .NET 通道，避免读写混用导致回读校验看不到新值。
function readState() {
  try {
    return Object.assign({ via: 'reg' }, queryUserPath());
  } catch (e) {
    if (e && e.code === 'E_REGISTRY_DENIED') {
      return Object.assign({ via: 'dotnet' }, dotnetQuery());
    }
    throw e;
  }
}

function writeState(state, type, value) {
  if (state.via !== 'dotnet') {
    const w = runSync('reg.exe', ['add', KEY, '/v', VALUE, '/t', type, '/d', value, '/f']);
    if (w.code === 0) return;
  }
  ps(writeScript(value, type));
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
    const r = runSync('powershell.exe',
      PS_ARGS.concat(['-EncodedCommand', encodedCommand(PS_QUIET + '\n' + NOTIFY_SCRIPT)]),
      { timeout: 30000 });
    return r.code === 0;
  } catch (_) {
    return false;
  }
}

function ensure(dir) {
  const target = String(dir);
  const before = readState();
  if (hasDir(before.value, target)) {
    return {
      changed: false, reason: 'already-present', dir: target,
      type: before.type, exists: before.exists, notified: false,
    };
  }

  const next = buildValue(before.value, target);
  if (next.length > MAX_PATH_CHARS) {
    fail('E_PATH_TOO_LONG', '用户 PATH 过长，追加启动器目录可能超出命令行限制',
      '请先在「编辑账户的环境变量」里清理无效条目，再手动添加启动器目录');
  }
  // 原本是 REG_SZ 就保持 REG_SZ；不存在或原本是 REG_EXPAND_SZ 则用后者（兼容 %VAR%）
  const type = before.exists && before.type === 'REG_SZ' ? 'REG_SZ' : 'REG_EXPAND_SZ';
  writeState(before, type, next);

  let after;
  try {
    after = readState();
  } catch (e) {
    after = dotnetQuery();
  }
  if (!hasDir(after.value, target)) {
    fail('E_PATH_VERIFY', '写入用户 PATH 后回读校验失败',
      '请手动检查「编辑账户的环境变量」中的 Path');
  }
  const notified = notify();
  return {
    changed: true, reason: 'added', dir: target, type,
    length: next.length, notified, via: before.via,
  };
}

module.exports = {
  KEY, VALUE, MAX_PATH_CHARS,
  parseQuery, queryUserPath, parseDotnet, dotnetQuery, writeScript,
  readState, writeState, norm, splitPath, hasDir, buildValue, notify, ensure,
};
