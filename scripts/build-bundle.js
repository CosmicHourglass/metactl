'use strict';

// 把 metactl 打成「自带 Node 运行时 + 自带 mihomo 内核」的自包含包，
// 目标机既不需要安装 Node，也不需要能连通 MetaCubeX 的 GitHub。
//
//   node scripts/build-bundle.js --node <node.exe 路径> [--out <目录>] [--no-zip]
//
// 产物结构（平铺，与源码布局一致）：
//   metactl-<version>-win32-x64/
//     node.exe              <- 打包进来的运行时
//     bundle.json           <- 安装模式标记，运行时据此把数据目录移到用户目录
//     bin/metactl.cmd       <- 启动器，指向同包的 node.exe
//     bin/cli.js  src/  node_modules/  package.json  README.md
//     assets/mihomo-metactl.exe  assets/kernel.json   <- 随包分发的 mihomo 内核
//
// 内核对外改名成 mihomo-metactl.exe，与官方 mihomo 的产物区分开；
// assets/kernel.json 里的 exeSha256 供安装时校验。
//
// 压缩依赖系统自带的 bsdtar（Win10 1803+），不引入任何构建期 npm 依赖。

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const stageKernel = require('./stage-kernel');

const ROOT = path.resolve(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));

function parseArgs(argv) {
  const o = { zip: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--node') o.node = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--no-zip') o.zip = false;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error('未知参数: ' + a);
  }
  return o;
}

function say(msg) { process.stdout.write(msg + '\n'); }
function mb(bytes) { return (bytes / 1024 / 1024).toFixed(1) + ' MB'; }

// 系统命令一律从 SystemRoot 派生，不写死盘符。
function systemExe(name) {
  const rootDir = process.env.SystemRoot || process.env.WINDIR || process.env.windir || '';
  const abs = path.join(rootDir, 'System32', name);
  return fs.existsSync(abs) ? abs : name;
}

// 递归复制；filter 收到源绝对路径，返回 false 则跳过。
function copyTree(src, dest, filter) {
  if (filter && !filter(src)) return;
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) {
    try { fs.symlinkSync(fs.readlinkSync(src), dest); } catch (_) { /* 链接失败就跳过 */ }
    return;
  }
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) copyTree(path.join(src, name), path.join(dest, name), filter);
    return;
  }
  fs.copyFileSync(src, dest);
}

// 只允许删除 dist 祖先内的路径，杜绝通配误删。
function rmInside(baseDir, target) {
  const rel = path.relative(baseDir, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('拒绝删除 ' + target + '（不在 ' + baseDir + ' 内）');
  }
  fs.rmSync(target, { recursive: true, force: true });
}

function dirSize(dir) {
  let total = 0;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.lstatSync(p);
    if (st.isDirectory()) total += dirSize(p);
    else if (st.isFile()) total += st.size;
  }
  return total;
}

function launcherCmd() {
  return [
    '@echo off',
    'setlocal',
    '"%~dp0..\\node.exe" "%~dp0cli.js" %*',
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    say('用法: node scripts/build-bundle.js [--node <node.exe>] [--out <目录>] [--no-zip]');
    return;
  }
  if (process.platform !== 'win32') throw new Error('本打包脚本仅支持 Windows');

  const nodeExe = path.resolve(opts.node || process.execPath);
  if (!fs.existsSync(nodeExe)) throw new Error('找不到 node.exe: ' + nodeExe);

  const version = pkg.version;
  const target = 'win32-' + (process.arch === 'ia32' ? 'x86' : process.arch);
  const outDir = path.resolve(opts.out || path.join(ROOT, 'dist'));
  const dirName = `metactl-${version}-${target}`;
  const stage = path.join(outDir, dirName);

  fs.mkdirSync(outDir, { recursive: true });
  if (fs.existsSync(stage)) rmInside(outDir, stage);
  fs.mkdirSync(stage, { recursive: true });

  // 1. Node 运行时
  fs.copyFileSync(nodeExe, path.join(stage, 'node.exe'));

  // 2. 应用代码与依赖
  copyTree(path.join(ROOT, 'bin'), path.join(stage, 'bin'), (p) => p !== path.join(ROOT, 'bin', 'metactl.cmd'));
  copyTree(path.join(ROOT, 'src'), path.join(stage, 'src'));
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(stage, 'package.json'));
  // 许可证必须随包分发：项目是 GPL-3.0，随包还带 GPLv3 的 mihomo 内核
  if (fs.existsSync(path.join(ROOT, 'LICENSE'))) {
    fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(stage, 'LICENSE'));
  }
  if (fs.existsSync(path.join(ROOT, 'README.md'))) {
    fs.copyFileSync(path.join(ROOT, 'README.md'), path.join(stage, 'README.md'));
  }
  const modules = path.join(ROOT, 'node_modules');
  if (!fs.existsSync(modules)) throw new Error('缺少 node_modules，请先执行 npm install');
  copyTree(modules, path.join(stage, 'node_modules'), (p) => {
    const rel = path.relative(modules, p);
    const top = rel.split(path.sep)[0];
    return top !== '.bin' && top !== '.package-lock.json' && top !== '.cache';
  });

  // 3. mihomo 内核：随包分发，安装时不再联网下载
  const staged = stageKernel.stage({ out: path.join(stage, 'assets') });

  // 4. 启动器与安装标记
  fs.writeFileSync(path.join(stage, 'bin', 'metactl.cmd'), launcherCmd(), 'utf8');
  fs.writeFileSync(path.join(stage, 'bundle.json'), JSON.stringify({
    name: pkg.name,
    version,
    target,
    node: execFileSync(nodeExe, ['-v'], { encoding: 'utf8' }).trim(),
    kernel: {
      tag: staged.info.tag,
      exeName: staged.info.exeName,
      exeSha256: staged.info.exeSha256,
      exeBytes: staged.info.exeBytes,
    },
    builtAt: new Date().toISOString(),
  }, null, 2) + '\n', 'utf8');

  const rawSize = dirSize(stage);
  say(`已生成目录: ${stage}  (${mb(rawSize)})`);

  if (!opts.zip) return;

  // 5. 压缩：系统 bsdtar 支持按扩展名选格式
  const zipPath = path.join(outDir, dirName + '.zip');
  if (fs.existsSync(zipPath)) rmInside(outDir, zipPath);
  const tar = systemExe('tar.exe');
  try {
    execFileSync(tar, ['-a', '-c', '-f', zipPath, '-C', outDir, dirName], { stdio: 'pipe' });
  } catch (e) {
    throw new Error('压缩失败（需要 Win10 1803+ 自带的 bsdtar）: ' + (e.message || e));
  }
  const zipSize = fs.statSync(zipPath).size;
  say(`已生成安装包: ${zipPath}  (${mb(zipSize)}，压缩率 ${Math.round((1 - zipSize / rawSize) * 100)}%)`);
}

try {
  main();
} catch (e) {
  process.stderr.write('[build-bundle] 失败: ' + (e && e.message ? e.message : e) + '\n');
  process.exitCode = 1;
}
