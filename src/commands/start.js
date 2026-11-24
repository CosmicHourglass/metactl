'use strict';

const lifecycle = require('../lifecycle');

async function run(ctx) {
  const { cfg, logger } = ctx;
  const rec = await lifecycle.startKernel(ctx);
  const out = {
    running: true,
    pid: rec.pid,
    startedAt: rec.startedAt,
    version: rec.version,
    controller: cfg.ports.externalController,
    mixedPort: cfg.ports.mixedPort,
  };
  logger.json(out);
  logger.ok(`内核已启动 PID ${rec.pid}${rec.version ? ` (${rec.version})` : ''}`);
  logger.info(`控制器 ${cfg.ports.externalController}，代理端口 ${cfg.ports.mixedPort}`);
  logger.info('系统代理未自动开启，如需全局代理请执行 metactl proxy on（或 metactl connect 一条命令连上）');
  return out;
}

module.exports = { run };
