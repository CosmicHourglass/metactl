'use strict';

// 连接 / 断开：把「内核」和「系统代理」两件事合成一条命令。
//
// 顺序是有讲究的，颠倒任何一边都会造成断网：
//   连接 —— 先起内核再开代理。反过来会让系统代理指向一个还没人监听的端口。
//   断开 —— 先关代理再停内核。反过来同样会让代理悬空。

const fs = require('fs');
const proc = require('./process');
const proxy = require('./proxy');
const { fail } = require('./errors');

function ensureReady(p) {
  if (!fs.existsSync(p.mihomoExe) || !fs.existsSync(p.configYaml)) {
    fail('E_NOT_INITIALIZED', '尚未初始化（缺少内核或生成配置）',
      '请先执行 metactl init --sub <订阅地址>');
  }
}

// 启动内核。节点选择不落盘，重启后就是订阅里的默认线路。
async function startKernel(ctx) {
  return await proc.start(ctx);
}

async function connect(ctx) {
  const { p } = ctx;
  ensureReady(p);

  const st = proc.status(ctx);
  let rec = null;
  let started = false;
  if (st.running) {
    // 内核已经在跑就直接复用，不当成错误——重连系统代理是常见操作
    rec = { pid: st.pid, startedAt: st.startedAt || null, version: null };
  } else {
    rec = await startKernel(ctx);
    started = true;
  }

  try {
    const pr = proxy.on(ctx, { silent: true });
    return {
      connected: true,
      kernel: {
        running: true,
        pid: rec.pid,
        started,
        reused: !started,
        version: rec.version || null,
      },
      proxy: { enabled: true, server: pr.server, refreshed: pr.refreshed },
    };
  } catch (e) {
    // 代理没开成就不算连上：把本次启动的内核收回去，
    // 别留下「内核在跑但没代理」这种半吊子状态
    if (started) {
      try { await proc.stop(ctx); } catch (_) { /* 回滚失败不掩盖原始错误 */ }
    }
    throw e;
  }
}

async function disconnect(ctx, force) {
  // 先解除系统代理。代理还指着本工具而内核已经停了，浏览器会直接连不上。
  let pr;
  try {
    pr = proxy.repair(ctx, !!force);
  } catch (e) {
    e.hint = (e.hint ? e.hint + '；' : '') + '系统代理尚未解除，内核保持运行，请先处理代理再执行 metactl disconnect';
    throw e;
  }

  const st = proc.status(ctx);
  let stopped = false;
  let pid = null;
  if (st.running) {
    const r = await proc.stop(ctx);
    stopped = !!(r && r.stopped);
    pid = (r && r.pid) ? r.pid : st.pid;
  }

  return {
    connected: false,
    proxy: {
      changed: !!pr.changed,
      mode: pr.mode || null,
      reason: pr.reason || null,
      restored: pr.mode === 'restored',
    },
    kernel: { running: false, stopped, pid },
  };
}

module.exports = { ensureReady, startKernel, connect, disconnect };
