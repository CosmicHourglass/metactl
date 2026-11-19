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
  fail('E_USAGE', 'proxy 只接受 on / off 两个动作',
    '示例: metactl proxy on / metactl proxy off');
}

module.exports = { run };
