'use strict';

// 显示「开启代理后流量走哪条路线」：
//   应用 → Windows 系统代理 → mihomo 入站端口 → mode 规则匹配
//   → 规则指向的策略组 → 该组当前选中的节点 → 出站
// 同时列出实时连接命中的规则与完整链路。
const proc = require('../process');
const proxy = require('../proxy');
const { fail } = require('../errors');

function groupRows(proxies) {
  const rows = [];
  for (const [name, v] of Object.entries(proxies || {})) {
    if (!v || !Array.isArray(v.all) || !v.all.length) continue;
    rows.push({
      name,
      type: String(v.type || ''),
      now: v.now == null ? null : String(v.now),
      candidates: v.all.length,
    });
  }
  return rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function connectionRows(connections, max) {
  const list = Array.isArray(connections) ? connections : [];
  return {
    total: list.length,
    shown: list.slice(0, max).map((x) => {
      const m = x && x.metadata ? x.metadata : {};
      return {
        host: m.host || m.destinationIP || '?',
        port: m.destinationPort == null ? null : m.destinationPort,
        network: m.network || null,
        rule: x.rule || null,
        rulePayload: x.rulePayload || null,
        chains: Array.isArray(x.chains) ? x.chains.slice() : [],
      };
    }),
  };
}

function pointsToMetactl(state, cfg) {
  if (!state || !state.enabled || !state.server) return false;
  const port = String(cfg.ports.mixedPort);
  return new RegExp('(^|[:\\s])' + port + '$').test(String(state.server).trim());
}

async function run(ctx, args, opts) {
  const { cfg, logger } = ctx;
  const st = proc.status(ctx);
  if (!st.running) {
    fail('E_ROUTE_NO_KERNEL', '内核未运行，无法查看当前路线', '请先执行 metactl start');
  }

  let proxyState = null;
  let proxyError = null;
  try { proxyState = proxy.current(); }
  catch (e) { proxyError = (e && e.code) || 'E_UNKNOWN'; }

  const conf = await proc.controllerRequest(ctx, '/configs', 5000);
  if (!conf || conf.status !== 200 || !conf.data) {
    fail('E_ROUTE_CONTROLLER', '无法读取内核配置（外部控制器不可达或鉴权失败）',
      '请执行 metactl status 排查控制器状态');
  }
  const px = await proc.controllerRequest(ctx, '/proxies', 8000);
  const con = await proc.controllerRequest(ctx, '/connections', 8000);

  const mode = String((conf.data && conf.data.mode) || 'rule');
  const mixedPort = (conf.data && conf.data['mixed-port']) || cfg.ports.mixedPort;
  const allowLan = !!(conf.data && conf.data['allow-lan']);
  const expected = '127.0.0.1:' + cfg.ports.mixedPort;
  const groups = groupRows(px && px.data ? px.data.proxies : null);
  const connections = connectionRows(con && con.data ? con.data.connections : null, 20);
  const aligned = pointsToMetactl(proxyState, cfg);

  const out = {
    running: st.running,
    pid: st.pid || null,
    mode,
    mixedPort,
    allowLan,
    expectedProxyServer: expected,
    systemProxy: proxyState ? {
      enabled: !!proxyState.enabled,
      server: proxyState.server || null,
      override: proxyState.override || null,
      pointsToMetactl: aligned,
    } : null,
    proxyError,
    groups,
    connections,
  };
  logger.json(out);

  logger.info('当前代理路线');
  if (proxyError) {
    logger.warn(`  系统代理  : 无法读取 (${proxyError})`);
  } else if (!proxyState || !proxyState.enabled) {
    logger.info(`  系统代理  : 关闭（ProxyServer=${proxyState && proxyState.server ? proxyState.server : '未设置'}）`);
  } else {
    logger.info(`  系统代理  : 开启 → ${proxyState.server}${aligned ? '（指向本工具）' : '（不是本工具）'}`);
  }
  logger.info(`  入站端口  : mixed ${mixedPort} | 期望系统代理 ${expected}`);
  logger.info(`  分流模式  : ${mode}${allowLan ? ' | allow-lan 开启' : ''}`);
  logger.info(`  链路      : 应用 → 系统代理 → mihomo:${mixedPort} → ${mode} 规则匹配 → 策略组 → 出口节点`);

  logger.info(`  策略组选中（${groups.length} 个组）:`);
  for (const g of groups) {
    logger.info(`    ${g.name} [${g.type}] → ${g.now || '(未选中)'}`);
  }

  logger.info(`  活跃连接  : ${connections.total} 条`);
  for (const c of connections.shown) {
    const chains = c.chains.length ? c.chains.join(' → ') : '(无)';
    logger.info(`    ${c.host}${c.port ? ':' + c.port : ''} | ${c.rule || '-'}${c.rulePayload ? '/' + c.rulePayload : ''} | ${chains}`);
  }
  if (connections.total > connections.shown.length) {
    logger.info(`    ... 另有 ${connections.total - connections.shown.length} 条，--json 可查看全部`);
  }

  if (!aligned && !proxyError) {
    logger.warn('  提示: 系统代理未指向本工具，应用流量不会经过上述链路；如需全局代理请执行 metactl proxy on');
  }
  if (mode === 'global') {
    const g = groups.find((x) => x.name === 'GLOBAL');
    if (g && /^DIRECT$/i.test(String(g.now || ''))) {
      logger.warn('  警告: 全局模式下 GLOBAL 当前选中 DIRECT，所有流量都会直连');
    }
  }
  if (!connections.total) {
    logger.info('  提示: 当前无活跃连接，开启系统代理并访问网站后这里会显示命中的规则');
  }
  return out;
}

module.exports = { run, groupRows, connectionRows, pointsToMetactl };
