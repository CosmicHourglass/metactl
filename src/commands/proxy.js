'use strict';

const proxy = require('../proxy');
const { fail } = require('../errors');

async function run(ctx, args, opts) {
  const { logger } = ctx;
  const action = String((args && args[0]) || '').toLowerCase();
  if (action === 'on') {
    const r = proxy.on(ctx);
    logger.json({ enabled: true, server: r.server, refreshed: r.refreshed });
    return r;
  }
  if (action === 'off') {
    const r = proxy.off(ctx, !!opts.force);
    logger.json({ enabled: false, restored: r.restored, disabled: r.disabled });
    return r;
  }
  if (action === 'fix') return require('./fix').run(ctx, args, opts);
  fail('E_USAGE', 'proxy 只接受 on / off / fix 三个动作',
    '示例: metactl proxy on / metactl proxy off / metactl proxy fix（或简写 metactl fix）');
}

module.exports = { run };
