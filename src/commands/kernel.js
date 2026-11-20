'use strict';

// 内核生命周期单独成命令：安装由 npm install 的 postinstall 负责，
// 这里提供状态查询、失败后补装与显式升级。init 不再碰内核文件。

const fs = require('fs');
const kernel = require('../kernel');
const proc = require('../process');
const { readJson } = require('../paths');
const { fail } = require('../errors');

const ACTIONS = ['status', 'install', 'update'];

function describe(ctx) {
  const { p } = ctx;
  const info = readJson(p.kernelJson, null);
  const exists = fs.existsSync(p.mihomoExe);
  let bytes = 0;
  if (exists) {
    try { bytes = fs.statSync(p.mihomoExe).size; } catch (_) { /* ignore */ }
  }
  return {
    installed: !!(info && info.tag && exists && bytes > 0),
    tag: info ? info.tag : null,
    asset: info ? info.asset : null,
    arch: info ? info.arch : null,
    compatible: info ? !!info.compatible : null,
    sha256: info ? info.sha256 : null,
    digestVerified: info ? !!info.digestVerified : null,
    downloadedAt: info ? info.downloadedAt : null,
    exeBytes: bytes,
  };
}

async function run(ctx, args, opts) {
  const { logger } = ctx;
  const action = String((args && args[0]) || 'status').toLowerCase();
  if (!ACTIONS.includes(action)) {
    fail('E_USAGE', `未知内核操作: ${action}`, '可用操作: status | install | update');
  }

  if (action === 'status') {
    const out = describe(ctx);
    logger.json(out);
    if (out.installed) {
      logger.info(`内核 ${out.tag} (${out.arch}${out.compatible ? ' compatible' : ''})，${(out.exeBytes / 1024 / 1024).toFixed(1)} MB`);
      logger.info(`sha256 ${String(out.sha256).slice(0, 16)}...，官方 digest 校验${out.digestVerified ? '通过' : '不可用'}`);
      logger.info('升级请执行 metactl kernel update');
    } else {
      logger.warn('内核尚未安装，请重新安装，或执行 metactl kernel install 补装');
    }
    return out;
  }

  // 替换正在运行的 exe 在 Windows 上会失败，提前拦住
  const st = proc.status(ctx);
  if (st.running) {
    fail('E_KERNEL_BUSY', '内核正在运行，无法替换内核文件',
      `请先执行 metactl stop，再执行 metactl kernel ${action}`);
  }

  const force = action === 'update' || !!opts.force;
  const info = await kernel.install(ctx, {
    force,
    arch: opts.arch,
    compatible: opts.compatible === true ? true : undefined,
    mirror: opts.mirror,
    zipPath: opts.fromFile,
    sha256: opts.sha256,
  });
  const out = Object.assign({}, describe(ctx), {
    action, force, skipped: !!info.skipped,
  });
  logger.json(out);
  if (info.skipped) logger.ok(`内核已是 ${info.tag}，无需重复下载（升级请用 metactl kernel update）`);
  else logger.ok(`内核就位 ${info.tag}`);
  return out;
}

module.exports = { run, describe, ACTIONS };
