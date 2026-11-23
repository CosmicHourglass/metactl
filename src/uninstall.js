'use strict';

// 卸载：把 install.ps1 的卸载能力搬进 CLI，`metactl uninstall` 一条命令收尾。
//
// 三种安装方式分别处理：
//   bundle     自包含安装（install.ps1）：程序在 <installDir>\current，数据在 <installDir>\.runtime
//   npm-global npm i -g 装的：程序在 <prefix>\node_modules\metactl，删除交给 npm 自己
//   source     项目目录里跑源码：只清运行态与代理，绝不删用户自己的源码目录
//
// 顺序有讲究：先恢复系统代理（否则卸载到一半用户还断网），再停内核，
// 然后摘 PATH、删程序，最后才按需清数据。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const pkg = require('../package.json');
const paths = require('./paths');
const proc = require('./process');
const proxy = require('./proxy');
const userpath = require('./userpath');
const { encodedCommand, resolveExe } = require('./system');

const MODES = ['bundle', 'npm-global', 'source'];

const MODE_TEXT = {
  bundle: '自包含安装（install.ps1）',
  'npm-global': 'npm 全局安装',
  source: '项目目录内运行',
};

function detectMode(programRoot) {
  if (paths.isBundle(programRoot)) return 'bundle';
  if (paths.isGlobalNpm(programRoot)) return 'npm-global';
  return 'source';
}

function describe(ctx) {
  const programRoot = ctx.programRoot;
  const mode = detectMode(programRoot);
  return {
    mode,
    programRoot,
    // 自包含安装的启动器在 current\bin，install.ps1 加进用户 PATH 的就是这个目录
    launcherDir: mode === 'bundle' ? path.join(programRoot, 'bin') : null,
    runtimeDir: ctx.p.runtime,
    dataRoot: ctx.root,
  };
}

// 卸载要做什么：先算清楚再动手，确认提示与实际执行共用同一份计划。
function plan(ctx, opts) {
  const o = opts || {};
  const d = describe(ctx);
  const keepProgram = !!o.keepProgram;
  return {
    mode: d.mode,
    programRoot: d.programRoot,
    launcherDir: d.launcherDir,
    runtimeDir: d.runtimeDir,
    restoreProxy: true,
    stopKernel: true,
    // npm 全局目录是共享的，删掉会影响别的全局包，所以不动 PATH
    removePathEntry: d.mode === 'bundle' && !keepProgram,
    removeProgram: !keepProgram,
    purgeData: !!o.purge,
  };
}

// 后台清理：程序目录里的 node.exe 正是当前进程在跑的 exe，直接删不掉。
// 改由一个脱离父进程的 PowerShell 稍后重试删除，父进程退出后文件锁自然释放。
function scheduleRemove(dir) {
  const target = String(dir).replace(/'/g, "''");
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$p = '" + target + "'",
    'for ($i = 0; $i -lt 60; $i++) {',
    '  Start-Sleep -Milliseconds 500',
    '  if (-not (Test-Path -LiteralPath $p)) { exit 0 }',
    '  try { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction Stop } catch { }',
    '}',
  ].join('\n');
  try {
    const child = spawn(resolveExe('powershell.exe'), [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', encodedCommand(script),
    ], { detached: true, windowsHide: true, stdio: 'ignore', cwd: os.tmpdir() });
    child.unref();
    return true;
  } catch (_) {
    return false;
  }
}

// 自包含安装：先改名让位（PATH 里的命令目录随即可用），再交给后台进程删除。
function removeProgramDir(dir) {
  const aside = dir + '.uninstalled-' + Date.now().toString(36);
  let renamed = false;
  try {
    fs.renameSync(dir, aside);
    renamed = true;
  } catch (_) {
    // 改名失败就原地删除：后台脚本会反复重试，进程退出后就能删掉
  }
  const target = renamed ? aside : dir;
  const scheduled = scheduleRemove(target);
  return { removed: true, renamed, target, scheduled };
}

// npm 全局包由 npm 自己管：它会一并清掉命令 shim 与全局锁文件里的条目。
function removeNpmPackage(name) {
  try {
    execFileSync('npm.cmd', ['uninstall', '-g', name], {
      stdio: 'inherit', shell: true, timeout: 180000, cwd: os.tmpdir(),
    });
    return { removed: true, via: 'npm', error: null };
  } catch (e) {
    return { removed: false, via: 'npm', error: (e && e.message) || String(e) };
  }
}

function purgeRuntime(dir) {
  try {
    if (!fs.existsSync(dir)) return { ok: true, skipped: true, error: null };
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    return { ok: !fs.existsSync(dir), skipped: false, error: null };
  } catch (e) {
    return { ok: false, skipped: false, error: (e && e.message) || String(e) };
  }
}

async function run(ctx, opts) {
  const o = opts || {};
  const { logger } = ctx;
  const p = plan(ctx, o);

  const out = {
    ok: true,
    mode: p.mode,
    programRoot: p.programRoot,
    runtimeDir: p.runtimeDir,
    proxy: { changed: false, reason: null, mode: null },
    kernelStopped: false,
    pathEntry: null,
    program: null,
    dataPurged: false,
    notes: [],
  };

  // 1. 先恢复系统代理：内核还在跑时恢复，卸载过程中也不会出现「代理指向死端口」的窗口
  if (p.restoreProxy) {
    const r = proxy.repair(ctx, false);
    out.proxy = { changed: !!r.changed, reason: r.reason || null, mode: r.mode || null };
    if (r.reason === 'already-off') {
      logger.info('系统代理本来就是关闭状态');
    } else if (r.reason === 'foreign-proxy') {
      logger.warn('当前系统代理不是 metactl 设置的，未作改动（避免破坏你自己的代理配置）');
      out.notes.push('你自己的系统代理设置被保留，如需关闭请自行在系统设置里处理');
    } else {
      logger.ok(r.mode === 'restored'
        ? '系统代理已关闭并恢复到开启前的设置'
        : '系统代理已关闭，metactl 写入的代理值已清除');
    }
  }

  // 2. 停内核
  if (p.stopKernel) {
    const st = proc.status(ctx);
    if (st.running) {
      await proc.stop(ctx);
      out.kernelStopped = true;
      logger.ok(`内核已停止 (PID ${st.pid})`);
    } else {
      logger.info('内核本来就没有在运行');
    }
  }

  // 3. 摘掉用户 PATH 里的命令目录
  if (p.removePathEntry && p.launcherDir) {
    try {
      const r = userpath.remove(p.launcherDir);
      out.pathEntry = { removed: !!r.changed, reason: r.reason || null, dir: p.launcherDir, error: null };
      if (r.changed) logger.ok(`已从用户 PATH 移除 ${p.launcherDir}`);
      else logger.info('用户 PATH 中没有 metactl 命令目录，无需移除');
    } catch (e) {
      out.pathEntry = {
        removed: false, reason: 'failed', dir: p.launcherDir,
        error: (e && e.message) || String(e),
      };
      logger.warn(`从用户 PATH 移除命令目录失败：${(e && e.message) || e}`);
      out.notes.push('请手动在「编辑账户的环境变量」里删除 metactl 命令目录');
    }
  } else {
    out.pathEntry = { removed: false, reason: 'not-applicable', dir: p.launcherDir, error: null };
  }

  // 4. 删除程序本体
  if (!p.removeProgram) {
    out.program = { removed: false, reason: 'kept' };
    logger.info('按 --keep-program 保留程序本体');
  } else if (p.mode === 'bundle') {
    const r = removeProgramDir(p.programRoot);
    out.program = {
      removed: true, reason: 'removed', renamed: r.renamed,
      pendingDelete: r.scheduled, dir: r.target, error: null,
    };
    logger.ok(`程序目录已移除：${p.programRoot}`);
    if (!r.scheduled) {
      logger.warn('后台清理未启动，若目录仍在请手动删除：' + r.target);
      out.notes.push('后台清理未启动，请手动删除残留目录');
    }
  } else if (p.mode === 'npm-global') {
    const r = removeNpmPackage(pkg.name);
    out.program = { removed: r.removed, reason: r.removed ? 'removed' : 'failed', via: 'npm', error: r.error };
    if (r.removed) {
      logger.ok('已通过 npm 卸载全局包');
    } else {
      logger.warn(`npm 卸载失败：${r.error}`);
      logger.info(`请手动执行：npm uninstall -g ${pkg.name}`);
      out.notes.push(`npm 卸载失败，请手动执行 npm uninstall -g ${pkg.name}`);
    }
  } else {
    out.program = { removed: false, reason: 'source-mode' };
    logger.info('当前是项目目录内运行，不删除源码目录');
    out.notes.push('源码目录不会被删除，如需彻底清理请手动删除 .runtime 目录');
  }

  // 5. 清数据放最后：日志目录被删后再写日志会把它重建出来
  if (p.purgeData) {
    const r = purgeRuntime(p.runtimeDir);
    out.dataPurged = r.ok;
    out.dataError = r.error;
    if (r.ok) logger.ok(`运行态数据已删除：${p.runtimeDir}`);
    else logger.warn(`运行态数据删除失败（${r.error}）：${p.runtimeDir}`);
  } else {
    out.dataPurged = false;
    logger.info(`运行态数据保留在 ${p.runtimeDir}`);
  }

  out.ok = !out.dataError && !(out.program && out.program.reason === 'failed');
  return out;
}

function proxyText(p) {
  if (!p) return '未处理';
  if (p.reason === 'already-off') return '本来就是关闭状态';
  if (p.reason === 'foreign-proxy') return '不是 metactl 设置的，未改动';
  if (p.changed) return p.mode === 'restored' ? '已关闭并精确恢复原值' : '已关闭并清除 metactl 写入的值';
  return '未改动';
}

function programText(p) {
  if (!p) return '未处理';
  if (p.reason === 'kept') return '按 --keep-program 保留';
  if (p.reason === 'source-mode') return '源码目录未删除';
  if (p.removed) return '已删除';
  return '删除失败：' + (p.error || '未知原因');
}

// 汇总文案。purge 之后不再经过 logger（写日志会把刚删掉的目录重建出来），
// 所以最终输出走 stdout 直写。
function summary(out) {
  const lines = [];
  lines.push(out.ok ? '卸载完成。' : '卸载完成，但有步骤未成功（见下方提示）。');
  lines.push(`  安装方式: ${MODE_TEXT[out.mode] || out.mode}`);
  lines.push(`  系统代理: ${proxyText(out.proxy)}`);
  lines.push(`  内核: ${out.kernelStopped ? '已停止' : '本就未运行'}`);
  if (out.pathEntry) {
    lines.push(`  用户 PATH: ${out.pathEntry.removed ? '已移除命令目录' : '未改动'}`);
  }
  lines.push(`  程序: ${programText(out.program)}`);
  lines.push(`  运行态数据: ${out.dataPurged ? '已删除' : '保留在 ' + out.runtimeDir}`);
  for (const n of out.notes || []) lines.push('  提示: ' + n);
  return lines;
}

module.exports = {
  MODES, MODE_TEXT, detectMode, describe, plan,
  scheduleRemove, removeProgramDir, removeNpmPackage, purgeRuntime,
  run, summary, proxyText, programText,
};
