'use strict';

const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { fail, wrap } = require('./errors');

// 取系统根目录：不同终端里 SystemRoot / WINDIR 大小写与可用性不一致，逐个兜底。
function systemRoot() {
  return process.env.SystemRoot || process.env.WINDIR || process.env.windir || process.env.Systemroot || '';
}

function resolveExe(name) {
  // 优先让 PATH 解析；失败再拼 System32 绝对路径（含 32 位 Node 的 Sysnative 视图）。
  const candidates = [name];
  const root = systemRoot();
  if (root) {
    candidates.push(path.join(root, 'System32', name));
    if (process.arch === 'ia32') candidates.push(path.join(root, 'Sysnative', name));
  }
  for (const c of candidates) {
    if (c === name) return c; // 交给 PATH
    try { if (fs.existsSync(c)) return c; } catch (_) { /* ignore */ }
  }
  return name;
}

function friendlyName(name) {
  const map = {
    'reg.exe': 'Windows 注册表工具（设置/恢复系统代理）',
    'tasklist.exe': 'Windows 进程列表（校验进程）',
    'taskkill.exe': 'Windows 进程终止（停止内核）',
    'powershell.exe': 'Windows PowerShell（刷新系统代理设置）',
    'netstat.exe': 'Windows 端口查询（诊断端口占用）',
  };
  return map[name] || `系统命令 ${name}`;
}

function runSync(name, args, opts) {
  const exe = resolveExe(name);
  const o = { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024, ...(opts || {}) };
  try {
    const stdout = execFileSync(exe, args, o);
    return { code: 0, stdout: String(stdout || ''), stderr: '' };
  } catch (e) {
    const code = e.status;
    // 正常返回非零（如 tasklist 无结果、reg query 键不存在），不算异常
    if (typeof code === 'number') {
      return { code, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') };
    }
    if (e.code === 'ENOENT' || e.code === 'EPERM' || e.code === 'EACCES') {
      fail('E_REGISTRY_DENIED', `无法调用系统命令 ${name}（${friendlyName(name)}）`,
        '请在普通 cmd / PowerShell 终端运行；若被安全策略/组策略拦截，请放行该命令');
    }
    throw wrap('E_IO', `调用 ${name} 失败`, '请查看 metactl.log', e);
  }
}

function run(name, args, opts) {
  return new Promise((resolve) => {
    const exe = resolveExe(name);
    const o = { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024, ...(opts || {}) };
    execFile(exe, args, o, (err, stdout, stderr) => {
      if (err && err.code && ['ENOENT', 'EPERM', 'EACCES'].includes(err.code)) {
        resolve({ code: -1, stdout: '', stderr: err.code, denied: true });
        return;
      }
      resolve({
        code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
  });
}

// PowerShell -EncodedCommand：UTF-16LE base64，规避引号/中文/特殊字符。
function encodedCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function hasCommand(name) {
  const root = systemRoot();
  if (root && fs.existsSync(path.join(root, 'System32', name))) return true;
  // 用 where.exe 兜底
  try {
    const r = runSync('where.exe', [name]);
    return r.code === 0;
  } catch (_) { return false; }
}

module.exports = { systemRoot, resolveExe, run, runSync, encodedCommand, hasCommand, friendlyName };
