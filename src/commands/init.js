'use strict';

// init 只负责「添加订阅」：拉取订阅原文 -> 生成配置 -> mihomo -t 校验。
// 内核由 npm install 的 postinstall 安装，这里绝不下载/替换内核文件。

const fs = require('fs');
const config = require('../config');
const profile = require('../profile');
const yamlPatch = require('../yaml-patch');
const validate = require('../validate');
const geodata = require('../geodata');
const userpath = require('../userpath');
const { readJson } = require('../paths');
const { fail } = require('../errors');

function requireKernel(p) {
  const info = readJson(p.kernelJson, null);
  if (info && info.tag && fs.existsSync(p.mihomoExe)) return info;
  fail('E_KERNEL_NOT_INSTALLED', '内核尚未安装，无法生成并校验配置',
    '请执行 metactl kernel install 安装官方内核（网络慢或离线时可用 kernel install --from-file <zip>）');
}

async function run(ctx, args, opts) {
  const { p, cfg, logger } = ctx;
  config.validatePorts(cfg);

  const kernelInfo = requireKernel(p);

  const subUrl = opts.sub || profile.savedUrl(p);
  if (!subUrl) {
    fail('E_SUB_BAD_URL', '缺少订阅地址',
      '首次使用请执行 metactl init --sub <订阅地址>；地址含 token，仅存本地 .runtime/');
  }

  const meta = await profile.fetch(ctx, subUrl);

  const built = yamlPatch.build(ctx);
  try {
    validate.validate(ctx, built.tmpFile);
  } catch (e) {
    if (e && e.code === 'E_CONFIG_INVALID' && geodata.isGeodataError(e)) {
      logger.warn('内核需要 Geo 数据文件但自动下载失败，改由 metactl 补下后重试校验');
      const n = await geodata.ensure(ctx, opts.mirror, geodata.wantedFromError(e));
      if (n > 0) validate.validate(ctx, built.tmpFile);
      else throw e;
    } else {
      throw e;
    }
  }
  const configPath = yamlPatch.commit(ctx, built);
  logger.ok('生成的配置已通过 mihomo -t 校验');

  // PATH 放最后：订阅、配置、-t 都成功之后才动用户环境；失败只警告，不回滚配置。
  let pathSetup = { skipped: true, reason: 'disabled' };
  if (ctx.installed) {
    // 自包含安装的 PATH 由 install.ps1 负责；这里不插手，也避免 -NoPath 被覆盖回去
    pathSetup = { skipped: true, reason: 'managed-by-installer' };
  } else if (opts.path !== false) {
    try {
      const dir = ctx.paths.detectRoot();
      pathSetup = userpath.ensure(dir);
      if (pathSetup.changed) logger.ok(`已加入用户 PATH: ${dir}`);
      else logger.info(`已在用户 PATH 中: ${dir}`);
      logger.info('重新打开终端后即可直接使用 metactl 命令');
      if (pathSetup.changed && !pathSetup.notified) {
        logger.warn('环境变更通知未送达；已开着的终端需要重新打开才能看到新 PATH');
      }
    } catch (e) {
      pathSetup = {
        ok: false,
        error: (e && e.code) || 'E_UNKNOWN',
        message: (e && e.message) || String(e),
      };
      logger.warn(`自动加入用户 PATH 失败 [${pathSetup.error}]: ${pathSetup.message}`);
      logger.warn('订阅与配置已正常生成；可手动把项目目录加入用户 PATH，或在真实终端重跑 init');
    }
  }

  const out = {
    subscription: { displayName: meta.displayName, bytes: meta.bytes, sha256: meta.sha256 },
    kernel: {
      tag: kernelInfo.tag, arch: kernelInfo.arch,
      compatible: !!kernelInfo.compatible, sha256: kernelInfo.sha256,
      source: ctx.installed ? 'install.ps1' : 'npm install (postinstall)',
    },
    config: { file: configPath, sha256: built.sha256 },
    ports: cfg.ports,
    pathSetup,
  };
  logger.json(out);
  logger.info(`订阅: ${logger.maskUrl(subUrl)} (${meta.displayName})`);
  logger.info(`内核: ${kernelInfo.tag}（本次未改动）`);
  logger.info(`配置: ${configPath}`);
  logger.info(`端口: mixed ${cfg.ports.mixedPort} / socks ${cfg.ports.socksPort} / http ${cfg.ports.port} / 控制 ${cfg.ports.externalController}`);
  logger.info('下一步: metactl start -> metactl proxy on');
  return out;
}

module.exports = { run };
