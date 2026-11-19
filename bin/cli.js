#!/usr/bin/env node
'use strict';

// 入口守卫：平台 / Node 版本 / 依赖，全部在加载业务代码之前完成，
// 保证「没装依赖」「Node 太老」「非 Windows」能给出稳定的两行错误而不是栈。

function guardError(code, message, hint) {
  process.stderr.write(`错误 [${code}]: ${message}\n`);
  if (hint) process.stderr.write(`提示: ${hint}\n`);
}

if (process.platform !== 'win32') {
  guardError('E_UNSUPPORTED_PLATFORM', 'metactl 仅支持 Windows',
    '请在 Windows 上运行；其他平台请直接使用 mihomo 内核');
  process.exit(10);
}

const MIN = [16, 20, 2];
const cur = process.versions.node.split('.').map((n) => parseInt(n, 10));
const tooOld = cur[0] < MIN[0] ||
  (cur[0] === MIN[0] && (cur[1] < MIN[1] || (cur[1] === MIN[1] && (cur[2] || 0) < MIN[2])));
if (tooOld) {
  guardError('E_NODE_TOO_OLD', `Node.js 版本过低（当前 ${process.versions.node}，要求 >= 16.20.2）`,
    '请安装 Node.js 16.20.2 或更高版本后重试');
  process.exit(10);
}

for (const dep of ['commander', 'yaml', 'yauzl']) {
  try {
    require.resolve(dep);
  } catch (_) {
    guardError('E_DEPS_MISSING', `缺少依赖 ${dep}`,
      '请先在项目目录执行 npm install（或 npm ci），完成后重试');
    process.exit(10);
  }
}

require('../src/cli').main(process.argv).catch((err) => {
  // cli.main 已统一处理 AppError；此处只兜底未预料的异常
  const logger = require('../src/logger');
  logger.printError(err);
  process.exitCode = 1;
});
