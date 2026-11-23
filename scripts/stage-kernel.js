'use strict';

// 把 mihomo 内核暂存到 assets/，供两种分发方式共用同一份内核：
//   - 自包含安装包（scripts/build-bundle.js）打包进 assets/
//   - npm 包（package.json 的 files 字段）随包发布
//
// 内核文件对外统一叫 mihomo-metactl.exe，与官方 mihomo 的产物区分开。
// assets/kernel.json 里带 exeSha256：安装时校验「落盘的 exe 就是包里的那个 exe」。
//
// 用法：
//   node scripts/stage-kernel.js [--kernel <exe>] [--meta <kernel.json>] [--out <目录>]

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const KERNEL_NAME = 'mihomo-metactl.exe';
const META_NAME = 'kernel.json';

function say(msg) { process.stdout.write('[stage-kernel] ' + msg + '\n'); }
function warn(msg) { process.stderr.write('[stage-kernel] ' + msg + '\n'); }

function parseArgs(argv) {
  const o = { optional: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--kernel') o.kernel = argv[++i];
    else if (a === '--meta') o.meta = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--optional') o.optional = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error('未知参数: ' + a);
  }
  return o;
}

// 在运行态目录里找内核。新版叫 mihomo-metactl.exe，0.2.x 留下的 mihomo.exe 也能认。
function findKernel(binDir) {
  for (const name of [KERNEL_NAME, 'mihomo.exe']) {
    const p = path.join(binDir, name);
    try { if (fs.statSync(p).size > 0) return p; } catch (_) { /* 继续找 */ }
  }
  return null;
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

// stage({ root, kernelPath, metaPath, out }) -> { exe, meta, info }
function stage(opts) {
  const o = opts || {};
  const root = o.root || ROOT;
  const out = o.out || path.join(root, 'assets');
  const binDir = path.join(root, '.runtime', 'bin');

  const kernelPath = o.kernelPath || findKernel(binDir);
  if (!kernelPath) {
    throw new Error(
      '找不到 mihomo 内核。请先执行 metactl kernel install，'
      + '或用 --kernel <mihomo.exe 路径> 指定。');
  }
  const metaPath = o.metaPath || path.join(binDir, META_NAME);
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (_) { /* 可缺 */ }

  const exeSha256 = sha256File(kernelPath);
  const exeBytes = fs.statSync(kernelPath).size;

  // 元信息以本地 kernel.json 为底，补上 exe 自身的指纹。
  // 版本号只从本地元数据取，源码里不写死任何 tag。
  const info = Object.assign({}, meta || {}, {
    exeSha256,
    exeBytes,
    exeName: KERNEL_NAME,
    stagedAt: new Date().toISOString(),
  });
  if (!info.tag) {
    throw new Error('内核元信息里没有版本号（' + metaPath + '），请先执行 metactl kernel install');
  }

  fs.mkdirSync(out, { recursive: true });
  const exeTarget = path.join(out, KERNEL_NAME);
  fs.copyFileSync(kernelPath, exeTarget);
  const metaTarget = path.join(out, META_NAME);
  fs.writeFileSync(metaTarget, JSON.stringify(info, null, 2) + '\n', 'utf8');

  return { exe: exeTarget, meta: metaTarget, info };
}

function main(opts) {
  const o = opts || parseArgs(process.argv.slice(2));
  if (o.help) {
    say('用法: node scripts/stage-kernel.js [--kernel <exe>] [--meta <kernel.json>] [--out <目录>] [--optional]');
    return 0;
  }
  const r = stage({
    kernelPath: o.kernel ? path.resolve(o.kernel) : undefined,
    metaPath: o.meta ? path.resolve(o.meta) : undefined,
    out: o.out ? path.resolve(o.out) : undefined,
  });
  say(`内核已暂存: ${r.exe}（${r.info.tag}, ${(r.info.exeBytes / 1024 / 1024).toFixed(1)} MB）`);
  say(`元信息: ${r.meta}`);
  return 0;
}

if (require.main === module) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      say('用法: node scripts/stage-kernel.js [--kernel <exe>] [--meta <kernel.json>] [--out <目录>] [--optional]');
      process.exitCode = 0;
    } else {
      process.exitCode = main(opts);
    }
  } catch (e) {
    const msg = (e && e.message) || String(e);
    // --optional：找不到内核不算失败。发布出去的包没有随包内核时，
    // postinstall 会回落到联网下载官方内核，功能不受影响。
    if (process.argv.includes('--optional')) {
      warn('未暂存内核：' + msg);
      warn('发布的包将不带随包内核，安装时会改为联网下载官方内核。');
      process.exitCode = 0;
    } else {
      process.stderr.write('[stage-kernel] 失败: ' + msg + '\n');
      process.exitCode = 1;
    }
  }
}

module.exports = { KERNEL_NAME, META_NAME, ROOT, stage, findKernel, sha256File, parseArgs };
