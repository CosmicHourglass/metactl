'use strict';

// 节点延迟测速：直接复用 mihomo 外部控制器的 /group/{name}/delay，
// 不引入任何依赖，也不经过本机系统代理（测的是节点自身到测试地址的往返延迟）。
const proc = require('../process');
const { fail } = require('../errors');

const DEFAULT_URL = 'https://www.gstatic.com/generate_204';
const DEFAULT_TIMEOUT = 3000;
const REQUEST_SLACK_MS = 15000;

function clampInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// /proxies 里带 all 候选数组的条目就是代理组（Selector / URLTest / Fallback ...）
function collectGroups(proxies) {
  const groups = [];
  for (const [name, v] of Object.entries(proxies || {})) {
    if (!v || !Array.isArray(v.all)) continue;
    const nodes = v.all.filter((x) => typeof x === 'string' && x.length);
    if (!nodes.length) continue;
    groups.push({ name, type: String(v.type || ''), nodes });
  }
  return groups;
}

// 贪心集合覆盖：选最少的组把全部节点测一遍。
// 绝大多数订阅里 GLOBAL 已包含所有节点，一次请求就能测完全量。
function pickGroups(groups, onlyNames) {
  let picked = groups;
  if (onlyNames && onlyNames.length) {
    const wanted = new Set(onlyNames);
    picked = groups.filter((g) => wanted.has(g.name));
    if (!picked.length) {
      fail('E_SPEED_BAD_GROUP', `找不到代理组: ${onlyNames.join(', ')}`,
        '可用组名见 metactl speed --json 的 groups 字段');
    }
  }
  const universe = new Set();
  for (const g of picked) for (const n of g.nodes) universe.add(n);
  const uncovered = new Set(universe);
  const chosen = [];
  while (uncovered.size) {
    let best = null;
    let bestCount = 0;
    for (const g of picked) {
      if (chosen.indexOf(g) >= 0) continue;
      let count = 0;
      for (const n of g.nodes) if (uncovered.has(n)) count++;
      if (count > bestCount) { best = g; bestCount = count; }
    }
    if (!best) break;
    chosen.push(best);
    for (const n of best.nodes) uncovered.delete(n);
  }
  return { chosen, universe: Array.from(universe) };
}

async function run(ctx, args, opts) {
  const { logger } = ctx;
  const st = proc.status(ctx);
  if (!st.running) {
    fail('E_SPEED_NO_KERNEL', '内核未运行，无法测速', '请先执行 metactl start');
  }

  const url = String(opts.url || DEFAULT_URL).trim() || DEFAULT_URL;
  const delayTimeout = clampInt(opts.timeout, DEFAULT_TIMEOUT, 200, 30000);
  const only = Array.isArray(opts.group) ? opts.group : (opts.group ? [opts.group] : []);

  const list = await proc.controllerRequest(ctx, '/proxies', 5000);
  if (!list || list.status !== 200 || !list.data || !list.data.proxies) {
    fail('E_SPEED_CONTROLLER', '无法读取代理列表（外部控制器不可达或鉴权失败）',
      '请确认内核已启动、控制器地址与 secret 正确；可执行 metactl status 排查');
  }
  const groups = collectGroups(list.data.proxies);
  if (!groups.length) {
    fail('E_SPEED_NO_NODES', '订阅里没有可测速的代理组',
      '请执行 metactl init 更新订阅，或确认订阅包含代理组');
  }

  const { chosen, universe } = pickGroups(groups, only);
  const delays = Object.create(null);
  const groupErrors = [];
  for (const g of chosen) {
    const apiPath = '/group/' + encodeURIComponent(g.name) +
      '/delay?url=' + encodeURIComponent(url) + '&timeout=' + delayTimeout;
    // mihomo 会并发测完整个组再一次性返回，期间连接空闲，故请求超时要留足余量
    const r = await proc.controllerRequest(ctx, apiPath, delayTimeout + REQUEST_SLACK_MS);
    if (!r || r.status !== 200 || !r.data || typeof r.data !== 'object') {
      groupErrors.push(g.name);
      continue;
    }
    for (const [name, ms] of Object.entries(r.data)) {
      const n = Number(ms);
      if (!Number.isFinite(n) || n <= 0) continue;
      if (delays[name] == null || n < delays[name]) delays[name] = n;
    }
  }

  const ranked = Object.keys(delays)
    .map((name) => ({ name, delay: delays[name] }))
    .sort((a, b) => a.delay - b.delay);
  const failed = universe.filter((n) => delays[n] == null);
  if (!ranked.length) {
    fail('E_SPEED_FAILED', '所有节点均未返回延迟',
      '请检查节点可用性、测试地址 --url 与超时 --timeout；也可查看 .runtime/logs/mihomo.log');
  }

  const limit = opts.limit == null ? ranked.length
    : clampInt(opts.limit, ranked.length, 1, ranked.length);
  const shown = ranked.slice(0, limit);
  const stats = {
    total: universe.length,
    ok: ranked.length,
    failed: failed.length,
    fastest: ranked[0].delay,
    slowest: ranked[ranked.length - 1].delay,
    average: Math.round(ranked.reduce((s, x) => s + x.delay, 0) / ranked.length),
  };

  const out = {
    url,
    timeout: delayTimeout,
    groups: groups.map((g) => ({ name: g.name, type: g.type, nodes: g.nodes.length })),
    testedGroups: chosen.map((g) => g.name),
    groupErrors,
    stats,
    results: shown.map((r, i) => ({ rank: i + 1, name: r.name, delay: r.delay })),
    failures: failed,
  };
  logger.json(out);

  logger.info(`测速完成: ${stats.ok}/${stats.total} 个节点可用，最快 ${stats.fastest} ms / 平均 ${stats.average} ms / 最慢 ${stats.slowest} ms`);
  logger.info(`测试地址 ${url} | 单节点超时 ${delayTimeout} ms | 测试组 ${chosen.map((g) => g.name).join(', ')}`);
  const width = String(shown.length).length;
  for (let i = 0; i < shown.length; i++) {
    logger.info(`  ${String(i + 1).padStart(width)}. ${String(shown[i].delay).padStart(6)} ms  ${shown[i].name}`);
  }
  if (failed.length) logger.warn(`${failed.length} 个节点超时或不可用（--json 可查看名称）`);
  if (groupErrors.length) logger.warn(`代理组请求失败: ${groupErrors.join(', ')}`);
  if (limit < ranked.length) logger.info(`仅显示前 ${limit} 个，共 ${ranked.length} 个；去掉 --limit 查看全部`);
  return out;
}

module.exports = { run, collectGroups, pickGroups, DEFAULT_URL, DEFAULT_TIMEOUT };
