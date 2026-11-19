'use strict';

// 断网自救：开机后发现系统代理还指向已停掉的内核时，一条命令恢复。
// 与 proxy off 的区别：不要求内核运行、不要求备份存在、可重复执行。
const proxy = require('../proxy');

async function run(ctx, args, opts) {
  const { logger } = ctx;
  const r = proxy.repair(ctx, !!opts.force);
  const out = Object.assign({ ok: r.reason !== 'foreign-proxy' }, r);
  logger.json(out);

  if (r.reason === 'already-off') {
    logger.ok('系统代理本来就是关闭状态，无需恢复，可以正常上网');
  } else if (r.reason === 'foreign-proxy') {
    logger.warn('当前系统代理不是 metactl 设置的，未作改动，避免破坏你自己的代理配置');
    logger.info(`当前代理: ${r.before.server || '(未设置)'}`);
    logger.info('如确需关闭，请执行 metactl fix --force（仅关闭，仍保留原 ProxyServer 值）');
  } else {
    const how = r.mode === 'restored'
      ? '已精确恢复到开启代理前的设置'
      : r.mode === 'cleared'
        ? '已关闭并清除 metactl 写入的代理值'
        : '已将 ProxyEnable 置 0（保留原有 ProxyServer 值）';
    logger.ok(`检测到残留的 metactl 系统代理，${how}`);
    logger.ok('网络已恢复，重新打开浏览器即可');
    if (r.refreshError) {
      logger.warn(`代理刷新被拦截 (${r.refreshError})；注册表已恢复，重新打开浏览器或注销后生效`);
    }
    logger.info('提示: 下次关机前执行 metactl proxy off；若想开机自动恢复，见 README「断网自救」');
  }
  return out;
}

module.exports = { run };
