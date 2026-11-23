'use strict';

// 卸载命令：确认计划 -> 交给 uninstall 模块执行 -> 输出汇总。
// 确认提示写 stderr（--json 时 stdout 只留 JSON），避免污染机器可读输出。
const readline = require('readline');
const uninstall = require('../uninstall');
const { fail } = require('../errors');

function planLines(plan) {
  const modeText = uninstall.MODE_TEXT[plan.mode] || plan.mode;
  const lines = [];
  lines.push('即将卸载 metactl：');
  lines.push(`  安装方式: ${modeText}`);
  lines.push(`  程序目录: ${plan.programRoot}`);
  lines.push(plan.launcherDir
    ? `  用户 PATH: ${plan.launcherDir}`
    : '  用户 PATH: 不改动（npm 全局目录为共享目录）');
  lines.push(`  运行态数据: ${plan.runtimeDir}${plan.purgeData ? '（--purge：连数据一起删除）' : '（保留）'}`);
  const steps = ['恢复系统代理', '停止内核'];
  if (plan.removePathEntry) steps.push('移除 PATH 条目');
  if (plan.removeProgram) steps.push('删除程序目录');
  if (plan.purgeData) steps.push('删除运行态数据');
  lines.push(`  将执行: ${steps.join(' -> ')}`);
  return lines;
}

async function confirm(plan, opts) {
  if (!process.stdin.isTTY) {
    fail('E_UNINSTALL_CONFIRM', '卸载需要确认，非交互环境下无法询问',
      '请加上 --yes 重新执行（确认会删除程序目录）');
  }
  const out = opts.json ? process.stderr : process.stdout;
  for (const line of planLines(plan)) out.write(line + '\n');
  const rl = readline.createInterface({ input: process.stdin, output: out });
  const answer = await new Promise((resolve) => {
    rl.question('确认卸载？输入 y 继续（其它键取消）: ', (a) => resolve(a));
    rl.on('close', () => resolve(''));
  });
  rl.close();
  return /^(y|yes)$/i.test(String(answer).trim());
}

function emit(opts, out) {
  if (opts.json) {
    process.stdout.write(JSON.stringify(out) + '\n');
    return;
  }
  for (const line of uninstall.summary(out)) process.stdout.write(line + '\n');
}

async function run(ctx, args, opts) {
  const o = opts || {};
  const plan = uninstall.plan(ctx, o);

  if (!o.yes) {
    const ok = await confirm(plan, o);
    if (!ok) {
      ctx.logger.info('已取消卸载，什么都没改动');
      const cancelled = { ok: false, cancelled: true, mode: plan.mode };
      emit(o, cancelled);
      return cancelled;
    }
  }

  const out = await uninstall.run(ctx, o);
  // 汇总走 stdout 直写：--purge 之后 logger 会把刚删掉的日志目录重建出来
  emit(o, out);
  return out;
}

module.exports = { run, planLines };
