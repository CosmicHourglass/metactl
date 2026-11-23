'use strict';

// 卸载命令：不再交互确认，一条命令直接收尾。
// 默认保留订阅快照与配置（重装后不用重新拉订阅），内核不保留；--purge 连订阅与配置一起删。
const uninstall = require('../uninstall');

function emit(opts, out) {
  if (opts.json) {
    process.stdout.write(JSON.stringify(out) + '\n');
    return;
  }
  for (const line of uninstall.summary(out)) process.stdout.write(line + '\n');
}

async function run(ctx, args, opts) {
  const o = opts || {};
  const out = await uninstall.run(ctx, o);
  // 汇总走 stdout 直写：--purge 之后 logger 会把刚删掉的日志目录重建出来
  emit(o, out);
  return out;
}

module.exports = { run };
