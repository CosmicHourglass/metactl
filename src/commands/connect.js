'use strict';

// 一键连接：启动内核 + 开启系统代理，等价于 metactl start && metactl proxy on。
// 内核已经在跑时直接复用，不当成错误。

const lifecycle = require('../lifecycle');

async function run(ctx, args, opts) {
  const { logger } = ctx;
  const r = await lifecycle.connect(ctx);
  logger.json(r);

  if (r.kernel.started) {
    logger.ok(`内核已启动 (PID ${r.kernel.pid})`);
  } else {
    logger.info(`内核已在运行 (PID ${r.kernel.pid})，直接复用`);
  }
  logger.ok(`系统代理已开启 -> ${r.proxy.server}`);
  logger.info('提示: Node / curl / git 默认不读系统代理；验证请用浏览器，或 curl.exe -x http://' + r.proxy.server);
  logger.info('提醒: 关机或重启前执行 metactl disconnect；忘记的话开机后无法上网时执行 metactl fix');
  return r;
}

module.exports = { run };
