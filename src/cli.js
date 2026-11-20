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
  kernel: require('./commands/kernel'),
  fix: require('./commands/fix'),
  speed: require('./commands/speed'),
  route: require('./commands/route'),
  start: require('./commands/start'),
  stop: require('./commands/stop'),
  restart: require('./commands/restart'),
  status: require('./commands/status'),
  proxy: require('./commands/proxy'),
};

const DESCRIPTIONS = {
  version: '显示工具、Node 与运行态目录信息',
  test: '自检运行态（内核/配置/端口/控制器）',
  init: '添加订阅：拉取订阅、生成并校验配置',
  kernel: '查看 / 补装 / 升级 mihomo 官方内核',
  fix: '断网自救：清除关机残留的 metactl 系统代理，一键恢复上网',
  speed: '节点延迟测速：全量节点按延迟排行（需内核正在运行）',
  route: '查看当前代理路线：系统代理、分流模式、策略组选中与连接命中的规则',
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
    .option('--sub <url>', '订阅地址（首次必填；之后可省略以复用已保存地址）'))
    .action(makeHandler(program, 'init'));

  addGlobals(program.command('kernel')
    .description(DESCRIPTIONS.kernel)
    .argument('[action]', 'status | install | update', 'status')
    .option('--force', 'install 也强制重新下载；update 默认强制')
    .option('--arch <arch>', 'CPU 架构 auto|x64|ia32|arm64')
    .option('--compatible', '下载 compatible 兼容版内核（老 CPU）')
    .option('--mirror <url>', 'GitHub 下载镜像前缀（受限网络时自行指定，源码不内置镜像）')
    .option('--from-file <zip>', '从本地 mihomo zip 安装内核（下载反复失败或完全离线时用）')
    .option('--sha256 <hex>', '配合 --from-file 校验本地包完整性'))
    .action(makeHandler(program, 'kernel'));

  for (const name of ['start', 'stop', 'restart', 'status', 'test', 'version', 'route']) {
    addGlobals(program.command(name).description(DESCRIPTIONS[name]))
      .action(makeHandler(program, name));
  }

  addGlobals(program.command('fix')
    .description(DESCRIPTIONS.fix)
    .option('--force', '即使当前代理不是 metactl 设置的也强制关闭（仅关闭，保留原 ProxyServer 值）'))
    .action(makeHandler(program, 'fix'));

  addGlobals(program.command('speed')
    .description(DESCRIPTIONS.speed)
    .option('--group <name>', '只测指定代理组（可重复）', (v, prev) => { prev.push(v); return prev; }, [])
    .option('--url <url>', '延迟测试地址（默认取订阅健康检查地址，否则 cp.cloudflare.com）')
    .option('--timeout <ms>', '单节点超时毫秒（默认 10000）')
    .option('--limit <n>', '只显示延迟最低的前 n 个节点'))
    .action(makeHandler(program, 'speed'));

  addGlobals(program.command('proxy')
    .description('开启 / 恢复 / 修复 Windows 系统代理')
    .argument('<action>', 'on | off | fix')
    .option('--force', 'off 时仅关闭代理而不恢复；fix 时强制关闭外来代理'))
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
