'use strict';

// 每个命令的公共上下文：路径派生 -> 运行态目录 -> 跨机自校验 -> 配置 -> 脱敏日志。
const paths = require('./paths');
const config = require('./config');
const logger = require('./logger');
const instance = require('./instance');

function create(opts) {
  const o = opts || {};
  const programRoot = paths.detectRoot();
  const root = paths.resolveRoot(o);
  const p = paths.createPaths(root);
  paths.ensureDirs(p);

  const migration = instance.check(p);
  const cfg = config.load(p);

  logger.init(p, o);
  if (cfg.controllerSecret) logger.registerSecret(cfg.controllerSecret);
  const meta = paths.readJson(p.profileMeta, null);
  if (meta && meta.url) logger.registerSecret(meta.url);
  if (meta && meta.token) logger.registerSecret(meta.token);

  if (migration.migrated) {
    logger.warn('检测到 .runtime 来自其他机器或路径，已清理进程记录并隔离系统代理快照。');
    logger.warn('内核与配置可复用，请执行 metactl start；如需更新订阅请执行 metactl init。');
  }

  return {
    root, programRoot, installed: paths.isBundle(programRoot),
    p, cfg, opts: o, migration, logger, paths, config,
  };
}

module.exports = { create };
