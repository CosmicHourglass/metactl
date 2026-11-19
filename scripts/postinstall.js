'use strict';

// npm install / npm ci 时自动把 mihomo 官方内核装进 .runtime/bin/。
//
// 语义：默认「装不上就让 npm install 失败」——避免出现依赖装好了、
// init 却因为缺内核无法使用的半成品状态。离线或只想装依赖时用
// METACTL_SKIP_KERNEL=1 显式跳过，之后用 metactl kernel install 补装。
//
// 只在已存在有效内核时跳过联网检查，因此重复 npm install / npm ci 不会
// 每次都请求 GitHub，也不会重复下载。

const fs = require('fs');
const paths = require('../src/paths');
const config = require('../src/config');
const logger = require('../src/logger');

function say(msg) { process.stdout.write('[metactl] ' + msg + '\n'); }
function warn(msg) { process.stderr.write('[metactl] ' + msg + '\n'); }

function envFlag(name) {
  const v = String(process.env[name] || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

// 有效内核 = 有元数据 + exe 存在且非空。不校验 sha256（避免每次安装读 58 MB）。
function kernelPresent(p) {
  const info = paths.readJson(p.kernelJson, null);
  if (!info || !info.tag || !fs.existsSync(p.mihomoExe)) return false;
  try { return fs.statSync(p.mihomoExe).size > 0; }
  catch (_) { return false; }
}

// 轻量上下文：不建立实例指纹、不生成控制器密钥，安装阶段只碰 .runtime/bin 与日志。
function makeContext() {
  const root = paths.resolveRoot({});
  const p = paths.createPaths(root);
  paths.ensureDirs(p);
  const cfg = config.load(p);
  logger.init(p, { verbose: envFlag('METACTL_VERBOSE') });
  return {
    root, p, cfg, opts: {}, migration: { instanceId: null },
    logger, paths, config,
  };
}

async function main() {
  if (process.platform !== 'win32') {
    say('非 Windows 平台，跳过内核安装（本工具仅支持 Windows）');
    return;
  }
  if (envFlag('METACTL_SKIP_KERNEL')) {
    say('已按 METACTL_SKIP_KERNEL 跳过内核安装；使用前请执行 metactl kernel install');
    return;
  }
  for (const dep of ['commander', 'yaml', 'yauzl']) {
    try { require.resolve(dep); }
    catch (_) {
      say(`依赖 ${dep} 尚不可用，跳过内核安装；请重新执行 npm install 或 metactl kernel install`);
      return;
    }
  }

  const ctx = makeContext();
  const force = envFlag('METACTL_KERNEL_FORCE');
  if (!force && kernelPresent(ctx.p)) {
    const info = paths.readJson(ctx.p.kernelJson, null);
    say(`内核已就位 ${info.tag}，跳过下载（升级请执行 metactl kernel update）`);
    return;
  }

  // 延迟到确实需要下载时才加载网络/内核模块
  const kernel = require('../src/kernel');
  say('正在安装 mihomo 官方内核（约 22 MB，受限网络可能需要几分钟）...');
  const info = await kernel.install(ctx, {
    force,
    arch: process.env.METACTL_ARCH || undefined,
    compatible: envFlag('METACTL_COMPATIBLE') ? true : undefined,
    mirror: process.env.METACTL_MIRROR || undefined,
  });
  say(`内核就位 ${info.tag}${info.skipped ? '（未重复下载）' : ''}，下一步：metactl init --sub <订阅地址>`);
}

if (require.main === module) {
  main().catch((err) => {
    const code = (err && err.code) || 'E_UNKNOWN';
    const msg = (err && err.message) || String(err);
    const hint = (err && err.hint) || '';
    warn(`内核安装失败 [${code}]: ${msg}`);
    if (hint) warn('提示: ' + hint);
    warn('npm 依赖本身已安装完成。可稍后执行：metactl kernel install');
    warn('受限网络可设置 METACTL_MIRROR=<镜像前缀>；仅需装依赖可设 METACTL_SKIP_KERNEL=1 后重新 npm install');
    process.exitCode = 1;
  });
}

module.exports = { main, kernelPresent, makeContext, envFlag };
