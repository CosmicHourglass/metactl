'use strict';

// npm 安装阶段：把启动器所在目录写入用户 PATH，并安装 mihomo 官方内核。
// 装完新开终端即可直接敲 metactl，不需要先跑 init，也不需要先 npm link。
//
// 语义：PATH 与内核下载失败都只警告、不阻断安装 —— 命令本身已可用，
// 用户稍后执行 metactl kernel install 即可补装。这样任意一台 Windows 电脑
// 装完都能先敲到 metactl，不会因网络波动导致整个安装失败。
// 两者都幂等，重复 npm install / npm ci 不会重复下载或重复追加 PATH。

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

// npm 全局安装时 shim 由 npm 生成在 prefix 下；本地安装时启动器是项目根的
// metactl.cmd；自包含安装则由 install.ps1 负责，不走这里。
function launcherDir() {
  const root = paths.detectRoot();
  if (paths.isBundle(root)) return null;
  if (String(process.env.npm_config_global || '').toLowerCase() === 'true') {
    return process.env.npm_config_prefix || null;
  }
  return root;
}

function registerLauncher() {
  const dir = launcherDir();
  if (!dir) return; // 自包含安装：PATH 由 install.ps1 管理
  try {
    const r = require('../src/userpath').ensure(dir);
    if (r.changed) say(`已把 ${dir} 加入用户 PATH，新开终端即可直接使用 metactl 命令`);
    else say(`metactl 命令目录已在用户 PATH 中`);
  } catch (e) {
    const code = (e && e.code) || 'E_UNKNOWN';
    warn(`自动配置用户 PATH 失败 [${code}]: ${(e && e.message) || e}`);
    warn(`请手动把 ${dir} 加入用户 PATH，或直接用 node 调用对应脚本`);
  }
}

// 有效内核 = 有元数据 + exe 存在且非空。不校验 sha256（避免每次安装读 58 MB）。
function kernelPresent(p) {
  const info = paths.readJson(p.kernelJson, null);
  if (!info || !info.tag || !fs.existsSync(p.mihomoExe)) return false;
  try { return fs.statSync(p.mihomoExe).size > 0; }
  catch (_) { return false; }
}

// 轻量上下文：不建立实例指纹、不生成控制器密钥，安装阶段只碰 .runtime/bin 与日志。
// npm 全局安装时包最终位于 <prefix>\node_modules\metactl，CLI 运行时会把数据目录
// 解析到用户目录；这里必须用同样的目录，否则装好的内核运行时找不到。
function makeContext() {
  const isGlobal = String(process.env.npm_config_global || '').toLowerCase() === 'true';
  const root = isGlobal ? paths.globalDataRoot() : paths.resolveRoot({});
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
    say('非 Windows 平台，跳过安装后配置（本工具仅支持 Windows）');
    return;
  }

  // PATH 属于安装阶段，即使跳过内核也要完成
  registerLauncher();

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
  say('正在安装 mihomo 官方内核（约 22 MB）...');
  try {
    const info = await kernel.install(ctx, {
      force,
      arch: process.env.METACTL_ARCH || undefined,
      compatible: envFlag('METACTL_COMPATIBLE') ? true : undefined,
      mirror: process.env.METACTL_MIRROR || undefined,
    });
    say(`内核就位 ${info.tag}${info.skipped ? '（未重复下载）' : ''}，下一步：metactl init --sub <订阅地址>`);
  } catch (err) {
    // 安装阶段的网络问题不该让 npm install 失败：命令已可用，稍后补装内核即可。
    const code = (err && err.code) || 'E_UNKNOWN';
    warn(`内核安装失败 [${code}]: ${(err && err.message) || err}`);
    warn('命令本身已可用，稍后执行：metactl kernel install');
  }
}

if (require.main === module) {
  main().catch((err) => {
    warn(`安装后配置失败 [${(err && err.code) || 'E_UNKNOWN'}]: ${(err && err.message) || err}`);
    warn('命令本身已可用，可稍后执行：metactl kernel install');
  });
}

module.exports = { main, kernelPresent, makeContext, envFlag, launcherDir, registerLauncher };
