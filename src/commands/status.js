'use strict';

const fs = require('fs');
const proc = require('../process');
const proxy = require('../proxy');
const { readJson } = require('../paths');

async function run(ctx) {
  const { p, cfg, logger } = ctx;
  const st = proc.status(ctx);
  const kernelInfo = readJson(p.kernelJson, null);
  const meta = readJson(p.profileMeta, null);

  let proxyState = null;
  let proxyError = null;
  try { proxyState = proxy.current(); }
  catch (e) { proxyError = (e && e.code) || 'E_UNKNOWN'; }

  // 悬空代理：注册表还指向 metactl，内核却已停 —— 关机重启后断网的典型状态
  const staleProxy = proxyState ? proxy.isStale(proxyState, cfg, st.running) : false;

  let controller = null;
  if (st.running) {
    const r = await proc.controllerRequest(ctx, '/version', 1500);
    controller = {
      reachable: !!(r && r.status === 200),
      version: r && r.data && r.data.version ? r.data.version : null,
    };
  }

  const initialized = fs.existsSync(p.mihomoExe) && fs.existsSync(p.configYaml);
  const out = {
    initialized,
    kernel: kernelInfo ? {
      tag: kernelInfo.tag, asset: kernelInfo.asset, arch: kernelInfo.arch,
      compatible: kernelInfo.compatible, sha256: kernelInfo.sha256,
      downloadedAt: kernelInfo.downloadedAt,
    } : null,
    profile: meta ? {
      displayName: meta.displayName, fetchedAt: meta.fetchedAt,
      bytes: meta.bytes, userinfo: meta.userinfo, interval: meta.interval,
    } : null,
    process: st,
    controller,
    proxy: proxyState,
    proxyError,
    staleProxy,
    ports: cfg.ports,
    migrated: !!ctx.migration.migrated,
  };
  logger.json(out);

  logger.info('metactl 状态');
  logger.info(`  初始化    : ${initialized ? '已完成' : '未完成（请执行 metactl init）'}`);
  logger.info(`  内核      : ${kernelInfo ? `${kernelInfo.tag} (${kernelInfo.arch}${kernelInfo.compatible ? ', compatible' : ''})` : '未下载'}`);
  logger.info(`  订阅      : ${meta ? `${meta.displayName}，${meta.bytes} 字节，${meta.fetchedAt}` : '无'}`);
  if (meta && meta.userinfo && meta.userinfo.total) {
    const used = (meta.userinfo.upload || 0) + (meta.userinfo.download || 0);
    logger.info(`  流量      : ${(used / 1024 / 1024 / 1024).toFixed(2)} / ${(meta.userinfo.total / 1024 / 1024 / 1024).toFixed(2)} GB${meta.userinfo.expire ? `，到期 ${new Date(meta.userinfo.expire * 1000).toISOString().slice(0, 10)}` : ''}`);
  }
  logger.info(`  进程      : ${st.running ? `运行中 PID ${st.pid}${st.unverified ? ' (映像名未核对)' : ''}` : `未运行${st.reason ? ' (' + st.reason + ')' : ''}`}`);
  logger.info(`  控制器    : ${controller ? (controller.reachable ? `可达 ${controller.version || ''}` : '不可达') : (st.running ? '未知' : '内核未运行')}`);
  logger.info(`  系统代理  : ${proxyError ? `无法读取 (${proxyError})` : (proxyState && proxyState.enabled ? `开启 ${proxyState.server}` : '关闭')}`);
  logger.info(`  端口      : mixed ${cfg.ports.mixedPort} / socks ${cfg.ports.socksPort} / http ${cfg.ports.port} / ctl ${cfg.ports.externalController}`);
  if (staleProxy) {
    logger.warn('  警告: 系统代理仍指向 metactl 但内核未运行，可能无法上网；执行 metactl fix 一键恢复');
  }
  if (ctx.migration.migrated) {
    logger.warn('  运行态来自其他机器或路径，已隔离旧 PID 与代理快照');
  }
  return out;
}

module.exports = { run };
