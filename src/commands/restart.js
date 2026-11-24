'use strict';

const lifecycle = require('../lifecycle');

async function run(ctx) {
  const { cfg, logger } = ctx;
  const before = await require('../process').stop(ctx);
  const rec = await lifecycle.startKernel(ctx);
  const out = {
    running: true,
    previousPid: before.pid || null,
    pid: rec.pid,
    version: rec.version,
    controller: cfg.ports.externalController,
  };
  logger.json(out);
  logger.ok(`内核已重启 PID ${rec.pid}${before.pid ? ` (原 ${before.pid})` : ''}`);
  logger.info('系统代理设置保持不变');
  logger.info('提示: 节点选择不落盘，重启后回到订阅里的默认线路');
  return out;
}

module.exports = { run };
