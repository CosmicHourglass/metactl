'use strict';

const fs = require('fs');
const path = require('path');

// 全局脱敏池：登记订阅 URL / token / secret 等，任何输出前统一替换。
let secrets = [];
function registerSecret(s) {
  if (s && typeof s === 'string' && s.length >= 4 && !secrets.includes(s)) secrets.push(s);
}
function maskText(s) {
  let out = String(s == null ? '' : s);
  for (const sec of secrets) out = out.split(sec).join('***');
  return out;
}
function maskUrl(raw) {
  try {
    const u = new URL(raw);
    const segs = u.pathname.split('/').filter(Boolean);
    const masked = segs.map((s) => (s.length <= 4 ? s : s.slice(0, 4) + '***'));
    return u.origin + '/' + masked.join('/');
  } catch (_) {
    return String(raw).slice(0, 24) + '***';
  }
}

let ctx = null;
function init(p, opts) {
  ctx = { p, opts: opts || {}, secrets };
  return api;
}

function writeLog(line) {
  if (!ctx || !ctx.p) return;
  try {
    fs.mkdirSync(ctx.p.logsDir, { recursive: true });
    fs.appendFileSync(ctx.p.logCli, `[${new Date().toISOString()}] ${maskText(line)}\n`, 'utf8');
  } catch (_) { /* 日志失败不影响主流程 */ }
}

function emit(stream, prefix, msg) {
  const safe = maskText(msg);
  writeLog(prefix + ' ' + safe);
  if (ctx && ctx.opts.quiet) return;
  if (ctx && ctx.opts.json) return; // json 模式由命令自身输出结构化结果
  (stream || process.stdout).write(prefix + safe + '\n');
}

const api = {
  registerSecret, maskText, maskUrl,
  init, writeLog,
  info: (m) => emit(process.stdout, '', m),
  ok: (m) => emit(process.stdout, '  OK  ', m),
  warn: (m) => emit(process.stderr, ' WARN ', m),
  err: (m) => emit(process.stderr, ' ERR  ', m),
  debug: (m) => { if (ctx && ctx.opts.verbose) emit(process.stdout, ' DBG  ', m); },
  // 供命令输出机器可读结果（json 模式有效）
  json(obj) { if (ctx && ctx.opts.json) process.stdout.write(JSON.stringify(obj) + '\n'); },
  // 直接写 stdout，但不落日志文件。给含一次性令牌之类的地址用：
  // 令牌进了日志文件就等于把操作权限留在了磁盘上。
  raw(m) {
    const safe = maskText(m);
    if (ctx && ctx.opts.quiet) return;
    process.stdout.write(safe + '\n');
  },
  printError(err) {
    const code = (err && err.code) || 'E_UNKNOWN';
    const msg = maskText((err && err.message) || String(err));
    const hint = maskText((err && err.hint) || '');
    writeLog(`ERROR ${code} ${msg} | ${hint}`);
    if (ctx && ctx.opts.json) {
      process.stdout.write(JSON.stringify({ ok: false, error: { code, message: msg, hint } }) + '\n');
    } else {
      process.stderr.write(`错误 [${code}]: ${msg}\n`);
      if (hint) process.stderr.write(`提示: ${hint}\n`);
      if (ctx && ctx.opts.verbose && err && err.stack) process.stderr.write(maskText(err.stack) + '\n');
    }
  },
};

module.exports = api;
