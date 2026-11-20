'use strict';

const pkg = require('../../package.json');

async function run(ctx) {
  const out = {
    name: pkg.name,
    version: pkg.version,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    installed: !!ctx.installed,
    programRoot: ctx.programRoot,
    runtimeDir: ctx.p.runtime,
  };
  ctx.logger.json(out);
  ctx.logger.info(`${pkg.name} ${pkg.version}`);
  ctx.logger.info(`Node ${out.node} / ${out.platform} / ${out.arch}`);
  ctx.logger.info(`安装方式: ${out.installed ? '全局安装（程序与数据分离）' : '项目目录运行'}`);
  ctx.logger.info(`程序目录: ${out.programRoot}`);
  ctx.logger.info(`运行态目录: ${out.runtimeDir}`);
  return out;
}

module.exports = { run };
