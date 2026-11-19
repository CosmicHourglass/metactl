'use strict';

const pkg = require('../../package.json');

async function run(ctx) {
  const out = {
    name: pkg.name,
    version: pkg.version,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    runtimeDir: ctx.p.runtime,
  };
  ctx.logger.json(out);
  ctx.logger.info(`${pkg.name} ${pkg.version}`);
  ctx.logger.info(`Node ${out.node} / ${out.platform} / ${out.arch}`);
  ctx.logger.info(`运行态目录: ${out.runtimeDir}`);
  return out;
}

module.exports = { run };
