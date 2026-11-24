'use strict';

// 一键断开：关闭系统代理 + 停止内核，等价于 metactl proxy off && metactl stop。
// 顺序固定为先代理后内核：反序会让代理悬空，表现为「关了网」。
// 系统代理若不是本工具设的（用户自己在用别的代理），只提示不动它。

const lifecycle = require('../lifecycle');

async function run(ctx, args, opts) {
  const { logger } = ctx;
  const r = await lifecycle.disconnect(ctx, !!opts.force);
  logger.json(r);

  if (r.proxy.changed) {
    if (r.proxy.restored) {
      logger.ok('系统代理已关闭并恢复到开启前的设置');
    } else {
      logger.ok('系统代理已关闭');
    }
  } else if (r.proxy.reason === 'foreign-proxy') {
    logger.warn('当前系统代理不是本工具设置的，保持原样未改动');
  } else {
    logger.info('系统代理本来就没有开');
  }

  if (r.kernel.stopped) {
    logger.ok(`内核已停止 (PID ${r.kernel.pid})`);
  } else {
    logger.info('内核本来就没有在运行');
  }
  return r;
}

module.exports = { run };
