'use strict';

const { Command, Option } = require('commander');
const pkg = require('../package.json');
const logger = require('./logger');
const context = require('./context');
const { toExitCode } = require('./errors');
const { EXIT } = require('./constants');

const COMMANDS = {
  version: require('./commands/version'),
  test: require('./commands/test'),
  init: require('./commands/init'),
  start: require('./commands/start'),
  stop: require('./commands/stop'),
  restart: require('./commands/restart'),
  status: require('./commands/status'),
  proxy: require('./commands/proxy'),
};

const DESCRIPTIONS = {
  version: '显示工具、Node 与运行态目录信息',
  test: '自检运行态（内核/配置/端口/控制器）',
  init: '拉取订阅、下载官方内核、生成并校验配置',
  start: '启动内核（不自动开启系统代理）',
  stop: '停止内核（不自动关闭系统代理）',
  restart: '重启内核（系统代理设置保持不变）',
  status: '查看内核、进程、控制器与系统代理状态',
};

// 全局选项同时挂在 program 与每个子命令上：
// 既支持 metactl --json status，也支持 metactl status --json。
function addGlobals(cmd) {
  cmd.addOption(new Option('--home <dir>', '覆盖运行态目录（默认项目内 .runtime）'));
  cmd.addOption(new Option('--json', '以 JSON 输出结果'));
  cmd.addOption(new Option('--quiet', '静默输出'));
  cmd.addOption(new Option('-v, --verbose', '输出调试信息'));
  return cmd;
}

function makeHandler(program, name) {
  return async function (...args) {
    const cmd = args[args.length - 1];
    const own = cmd && typeof cmd.opts === 'function' ? cmd.opts() : {};
    const glob = program.opts();
    const opts = Object.assign({}, glob, own);
    const positional = args.slice(0, -2); // 去掉 commander 追加的 opts 与 command
    try {
      const ctx = context.create(opts);
      return await COMMANDS[name].run(ctx, positional, opts);
    } catch (err) {
      logger.printError(err);
      process.exitCode = toExitCode(err);
    }
  };
}

function build() {
  const program = new Command();
  program
    .name('metactl')
    .description('Windows 上管理 mihomo(Clash.Meta) 内核的命令行工具')
    .version(pkg.version, '-V, --version');
  program.enablePositionalOptions();
  program.exitOverride();
  addGlobals(program);

  addGlobals(program.command('init')
    .description(DESCRIPTIONS.init)
    .option('--force', '强制重新下载内核（即使版本已是最新）')
    .option('--sub <url>', '订阅地址（首次必填；之后可省略以复用已保存地址）')
    .option('--arch <arch>', 'CPU 架构 auto|x64|ia32|arm64', 'auto')
    .option('--compatible', '下载 compatible 兼容版内核（老 CPU）')
    .option('--mirror <url>', 'GitHub 下载镜像前缀（受限网络时自行指定，源码不内置镜像）')
    .option('--no-kernel', '跳过内核下载，仅刷新订阅与配置'))
    .action(makeHandler(program, 'init'));

  for (const name of ['start', 'stop', 'restart', 'status', 'test', 'version']) {
    addGlobals(program.command(name).description(DESCRIPTIONS[name]))
      .action(makeHandler(program, name));
  }

  addGlobals(program.command('proxy')
    .description('开启 / 恢复 Windows 系统代理')
    .argument('<action>', 'on 或 off')
    .option('--force', 'off 时仅关闭代理而不恢复（用于外来/缺失备份）'))
    .action(makeHandler(program, 'proxy'));

  return program;
}

async function main(argv) {
  const program = build();
  try {
    await program.parseAsync(argv);
  } catch (err) {
    // commander 已自行把错误/帮助文本写到 stderr/stdout，这里只决定退出码
    if (err && typeof err.code === 'string' && err.code.indexOf('commander.') === 0) {
      process.exitCode = err.exitCode === 0 ? EXIT.OK : EXIT.USAGE;
      return;
    }
    logger.printError(err);
    process.exitCode = toExitCode(err);
  }
}

module.exports = { main, build };
