'use strict';

// init 只负责「添加订阅」：拉取订阅原文 -> 生成配置 -> mihomo -t 校验。
// 内核由安装阶段（postinstall / install.ps1）提供，命令可用性（PATH）也在安装阶段完成。

const fs = require('fs');
const config = require('../config');
const profile = require('../profile');
const yamlPatch = require('../yaml-patch');
const validate = require('../validate');
const geodata = require('../geodata');
const { readJson } = require('../paths');
const { fail } = require('../errors');

function requireKernel(p) {
  const info = readJson(p.kernelJson, null);
  if (info && info.tag && fs.existsSync(p.mihomoExe)) return info;
  fail('E_KERNEL_NOT_INSTALLED', '内核尚未安装，无法生成并校验配置',
    '请执行 metactl kernel install 安装官方内核');
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

  const out = {
    subscription: { displayName: meta.displayName, bytes: meta.bytes, sha256: meta.sha256 },
    kernel: {
      tag: kernelInfo.tag, arch: kernelInfo.arch,
      compatible: !!kernelInfo.compatible, sha256: kernelInfo.sha256,
    },
    config: { file: configPath, sha256: built.sha256 },
    ports: cfg.ports,
  };
  logger.json(out);
  logger.info(`订阅: ${logger.maskUrl(subUrl)} (${meta.displayName})`);
  logger.info(`配置: ${configPath}`);
  logger.info(`端口: mixed ${cfg.ports.mixedPort} / socks ${cfg.ports.socksPort} / http ${cfg.ports.port} / 控制 ${cfg.ports.externalController}`);
  logger.info('下一步: metactl start -> metactl proxy on');
  return out;
}

module.exports = { run };
