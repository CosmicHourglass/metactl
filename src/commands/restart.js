'use strict';

const proc = require('../process');

async function run(ctx) {
  const { cfg, logger } = ctx;
  const before = await proc.stop(ctx);
  const rec = await proc.start(ctx);
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
  return out;
}

module.exports = { run };
