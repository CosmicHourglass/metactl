'use strict';

const proc = require('../process');

async function run(ctx) {
  const { logger } = ctx;
  const r = await proc.stop(ctx);
  const out = { running: false, stopped: r.stopped, pid: r.pid || null, reason: r.reason || null };
  logger.json(out);
  if (r.stopped) logger.ok(`内核已停止 (PID ${r.pid})`);
  else logger.info('内核本来就没有在运行');
  logger.warn('提示: 停止内核不会自动关闭系统代理，如需恢复请执行 metactl proxy off');
  return out;
}

module.exports = { run };
