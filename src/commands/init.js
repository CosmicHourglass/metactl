'use strict';

const fs = require('fs');
const config = require('../config');
const profile = require('../profile');
const kernel = require('../kernel');
const yamlPatch = require('../yaml-patch');
const validate = require('../validate');
const geodata = require('../geodata');
const proc = require('../process');
const { readJson } = require('../paths');
const { fail } = require('../errors');

async function run(ctx, args, opts) {
  const { p, cfg, logger } = ctx;
  config.validatePorts(cfg);

  const subUrl = opts.sub || profile.savedUrl(p);
  if (!subUrl) {
    fail('E_SUB_BAD_URL', '缺少订阅地址',
      '首次使用请执行 metactl init --sub <订阅地址>；地址含 token，仅存本地 .runtime/');
  }

  // 换内核会替换正在运行的 exe，Windows 上会失败，提前拦住
  if (opts.kernel !== false && opts.force) {
    const st = proc.status(ctx);
    if (st.running) {
      fail('E_KERNEL_BUSY', '内核正在运行，无法替换内核文件',
        '请先执行 metactl stop，再执行 metactl init --force');
    }
  }

  const meta = await profile.fetch(ctx, subUrl);

  let kernelInfo = null;
  if (opts.kernel !== false) {
    kernelInfo = await kernel.install(ctx, {
      force: !!opts.force,
      arch: opts.arch,
      compatible: opts.compatible,
      mirror: opts.mirror,
    });
  } else {
    if (!fs.existsSync(p.mihomoExe)) {
      fail('E_KERNEL_EXE_NOT_FOUND', '指定了 --no-kernel，但内核尚未下载',
        '请去掉 --no-kernel 重新执行 init');
    }
    kernelInfo = readJson(p.kernelJson, null);
    logger.info('按 --no-kernel 跳过内核下载');
  }

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

  const out = {
    subscription: { displayName: meta.displayName, bytes: meta.bytes, sha256: meta.sha256 },
    kernel: kernelInfo ? {
      tag: kernelInfo.tag, arch: kernelInfo.arch,
      compatible: kernelInfo.compatible, sha256: kernelInfo.sha256,
      skipped: !!kernelInfo.skipped,
    } : null,
    config: { file: configPath, sha256: built.sha256 },
    ports: cfg.ports,
  };
  logger.json(out);
  logger.info(`订阅: ${logger.maskUrl(subUrl)} (${meta.displayName})`);
  if (kernelInfo) {
    logger.info(`内核: ${kernelInfo.tag}${kernelInfo.skipped ? ' (已是最新，未重新下载)' : ' (已下载并校验)'}`);
  }
  logger.info(`配置: ${configPath}`);
  logger.info(`端口: mixed ${cfg.ports.mixedPort} / socks ${cfg.ports.socksPort} / http ${cfg.ports.port} / 控制 ${cfg.ports.externalController}`);
  logger.info('下一步: metactl start -> metactl proxy on');
  return out;
}

module.exports = { run };
