'use strict';

// 节点延迟测速。测速参数与主流 Clash 客户端的延迟检查逻辑对齐：
//   - 测试地址优先用订阅代理组自己的 health-check url，没配才用兜底地址
//   - 默认单节点超时 10000 ms（旧版 3000 ms 会把慢节点误判为不可用）
//   - 按节点调用 /proxies/{name}/delay，而不是整组 /group/{name}/delay
//     （整组并发打满所有节点会互相争抢，单次数值抖动几百毫秒）
//   - 超时与错误单独分类，不混进成功结果
// 每次执行仍然即时重测，不使用缓存。
const fs = require('fs');
const proc = require('../process');
const { fail } = require('../errors');

const FALLBACK_URL = 'http://cp.cloudflare.com/generate_204';
const DEFAULT_TIMEOUT = 10000;
const CONCURRENCY = 12;
const REQUEST_SLACK_MS = 5000;
const IMPLAUSIBLE_DELAY = 1e5;
const BUILTIN = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE']);

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

// 只测真实节点：排除内置策略与本身就是代理组的名字。
function leafNodes(proxies, universe) {
  const out = [];
  for (const n of universe) {
    if (BUILTIN.has(n)) continue;
    const v = proxies[n];
    if (v && Array.isArray(v.all)) continue;
    out.push(n);
  }
  return out;
}

// 从生成的配置里读每个代理组的健康检查地址。读不到就返回空对象。
function readGroupUrls(configYaml) {
  let YAML;
  try { YAML = require('yaml'); } catch (_) { return Object.create(null); }
  try {
    const text = fs.readFileSync(configYaml, 'utf8');
    const doc = YAML.parse(text, { uniqueKeys: false, logLevel: 'silent' });
    const out = Object.create(null);
    for (const g of (doc && doc['proxy-groups']) || []) {
      if (g && g.name && typeof g.url === 'string' && g.url.trim()) {
        out[g.name] = g.url.trim();
      }
    }
    return out;
  } catch (_) {
    return Object.create(null);
  }
}

function resolveUrl(opts, groupUrls, chosenNames) {
  const explicit = String(opts.url || '').trim();
  if (explicit) return explicit;
  for (const n of chosenNames) if (groupUrls[n]) return groupUrls[n];
  for (const u of Object.values(groupUrls)) if (u) return u;
  return FALLBACK_URL;
}

// 与客户端的延迟状态分类保持一致：>= timeout 记超时，异常大值记错误。
function classifyDelay(delay, timeout) {
  if (!Number.isFinite(delay) || delay < 0) return 'untested';
  if (delay > IMPLAUSIBLE_DELAY) return 'error';
  if (delay === 0 || delay >= timeout) return 'timeout';
  return 'measured';
}

async function measureOne(ctx, name, url, timeout) {
  const apiPath = '/proxies/' + encodeURIComponent(name) +
    '/delay?url=' + encodeURIComponent(url) + '&timeout=' + timeout;
  const r = await proc.controllerRequest(ctx, apiPath, timeout + REQUEST_SLACK_MS);
  if (!r || r.status !== 200 || !r.data || typeof r.data !== 'object') {
    const detail = r && r.data && r.data.message ? String(r.data.message) : '控制器无响应或节点不可用';
    return { name, state: 'error', delay: null, detail };
  }
  const ms = Number(r.data.delay);
  const state = classifyDelay(ms, timeout);
  return {
    name, state,
    delay: state === 'measured' ? ms : null,
    detail: state === 'measured' ? null : (r.data.message ? String(r.data.message) : state),
  };
}

// 受限并发，避免一次打满所有节点造成互相干扰。
async function measureAll(ctx, names, url, timeout) {
  const results = new Array(names.length);
  let cursor = 0;
  const workers = [];
  for (let i = 0; i < Math.min(CONCURRENCY, names.length); i++) {
    workers.push((async () => {
      for (;;) {
        const i = cursor++;
        if (i >= names.length) return;
        results[i] = await measureOne(ctx, names[i], url, timeout);
      }
    })());
  }
  await Promise.all(workers);
  return results;
}

async function run(ctx, args, opts) {
  const { logger, p } = ctx;
  const st = proc.status(ctx);
  if (!st.running) {
    fail('E_SPEED_NO_KERNEL', '内核未运行，无法测速', '请先执行 metactl start');
  }

  const timeout = clampInt(opts.timeout, DEFAULT_TIMEOUT, 200, 30000);
  const only = Array.isArray(opts.group) ? opts.group : (opts.group ? [opts.group] : []);

  const list = await proc.controllerRequest(ctx, '/proxies', 8000);
  if (!list || list.status !== 200 || !list.data || !list.data.proxies) {
    fail('E_SPEED_CONTROLLER', '无法读取代理列表（外部控制器不可达或鉴权失败）',
      '请确认内核已启动、控制器地址与 secret 正确；可执行 metactl status 排查');
  }
  const proxies = list.data.proxies;
  const groups = collectGroups(proxies);
  if (!groups.length) {
    fail('E_SPEED_NO_NODES', '订阅里没有可测速的代理组',
      '请执行 metactl init 更新订阅，或确认订阅包含代理组');
  }

  const { chosen, universe } = pickGroups(groups, only);
  const names = leafNodes(proxies, universe);
  if (!names.length) {
    fail('E_SPEED_NO_NODES', '没有可测速的实际节点',
      '请检查订阅内容，或用 --group 指定代理组');
  }

  const groupUrls = readGroupUrls(p.configYaml);
  const url = resolveUrl(opts, groupUrls, chosen.map((g) => g.name));
  const measured = await measureAll(ctx, names, url, timeout);

  const ok = measured.filter((r) => r.state === 'measured')
    .map((r) => ({ name: r.name, delay: r.delay }))
    .sort((a, b) => a.delay - b.delay);
  const bad = measured.filter((r) => r.state !== 'measured');
  if (!ok.length) {
    fail('E_SPEED_FAILED', '所有节点均未返回有效延迟',
      '请检查节点可用性、测试地址 --url 与超时 --timeout；也可查看 .runtime/logs/mihomo.log');
  }

  const limit = opts.limit == null ? ok.length : clampInt(opts.limit, ok.length, 1, ok.length);
  const shown = ok.slice(0, limit);
  const timeoutCount = bad.filter((r) => r.state === 'timeout').length;
  const errorCount = bad.length - timeoutCount;
  const stats = {
    total: names.length,
    ok: ok.length,
    failed: bad.length,
    timeout: timeoutCount,
    error: errorCount,
    fastest: ok[0].delay,
    slowest: ok[ok.length - 1].delay,
    average: Math.round(ok.reduce((s, x) => s + x.delay, 0) / ok.length),
  };

  const out = {
    url,
    timeout,
    concurrency: Math.min(CONCURRENCY, names.length),
    groups: groups.map((g) => ({ name: g.name, type: g.type, nodes: g.nodes.length })),
    testedGroups: chosen.map((g) => g.name),
    groupUrls,
    stats,
    results: shown.map((r, i) => ({ rank: i + 1, name: r.name, delay: r.delay })),
    failures: bad.map((r) => r.name),
    failureDetails: bad.map((r) => ({ name: r.name, state: r.state, detail: r.detail })),
  };
  logger.json(out);

  logger.info(`测速完成: ${stats.ok}/${stats.total} 个节点可用，最快 ${stats.fastest} ms / 平均 ${stats.average} ms / 最慢 ${stats.slowest} ms`);
  logger.info(`测试地址 ${url} | 单节点超时 ${timeout} ms | 并发 ${out.concurrency} | 测试组 ${chosen.map((g) => g.name).join(', ')}`);
  const width = String(shown.length).length;
  for (let i = 0; i < shown.length; i++) {
    logger.info(`  ${String(i + 1).padStart(width)}. ${String(shown[i].delay).padStart(6)} ms  ${shown[i].name}`);
  }
  if (bad.length) logger.warn(`${bad.length} 个节点超时或错误（超时 ${timeoutCount} / 错误 ${errorCount}；--json 可查看原因）`);
  if (limit < ok.length) logger.info(`仅显示前 ${limit} 个，共 ${ok.length} 个；去掉 --limit 查看全部`);
  return out;
}

module.exports = {
  run, collectGroups, pickGroups, leafNodes, readGroupUrls, resolveUrl,
  classifyDelay, measureAll, FALLBACK_URL, DEFAULT_TIMEOUT, CONCURRENCY,
};
