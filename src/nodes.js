'use strict';

// 策略组与节点：读 /proxies、切换 select 组选中的节点。
// 命令层与网页端共用这里的逻辑，避免两套实现各自漂移。
//
// mihomo 的组类型决定能不能手动挑：
//   Selector      —— 能切，本模块只对这类组提供切换
//   URLTest       —— 不能切，内核按延迟自动选（订阅里的「自动选择」就是它）
//   Fallback      —— 不能切，按可用性自动降级
//   LoadBalance   —— 不能切，按权重分流
//
// 切换是运行时的：内核一重启就回到订阅里 select 组的第一个候选，也就是默认线路。
// 本工具不做持久化，重启后连默认是明确的设计取舍。

const proc = require('./process');
const { fail } = require('./errors');

const SWITCHABLE_TYPE = 'selector';

function isSwitchable(group) {
  return !!group && Array.isArray(group.all) && group.all.length > 0
    && String(group.type || '').toLowerCase() === SWITCHABLE_TYPE;
}

// 组列表。all 数组是代理组的标志；节点本身没有 all。
function groupRows(proxies) {
  const rows = [];
  for (const [name, v] of Object.entries(proxies || {})) {
    if (!v || !Array.isArray(v.all) || !v.all.length) continue;
    rows.push({
      name,
      type: String(v.type || ''),
      now: v.now == null ? null : String(v.now),
      candidates: v.all.length,
      switchable: isSwitchable(v),
    });
  }
  return rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

// 某个组的候选节点 + 当前选中
function groupDetail(proxies, name) {
  const g = proxies && proxies[name];
  if (!g || !Array.isArray(g.all)) return null;
  return {
    name,
    type: String(g.type || ''),
    now: g.now == null ? null : String(g.now),
    switchable: isSwitchable(g),
    candidates: g.all.slice(),
  };
}

async function loadProxies(ctx, timeoutMs) {
  const r = await proc.controllerRequest(ctx, '/proxies', timeoutMs || 8000);
  if (!r || r.status !== 200 || !r.data || !r.data.proxies) {
    fail('E_SELECT_CONTROLLER', '无法读取代理列表（外部控制器不可达或鉴权失败）',
      '请确认内核已启动、控制器地址与 secret 正确；可执行 metactl status 排查');
  }
  return r.data.proxies;
}

// 切换。opts.proxies 可传入已读好的代理列表，避免重复请求。
async function switchNode(ctx, groupName, nodeName, opts) {
  const o = opts || {};
  const proxies = o.proxies || await loadProxies(ctx);
  const group = proxies[groupName];
  if (!group || !Array.isArray(group.all)) {
    fail('E_SELECT_BAD_GROUP', `找不到策略组: ${groupName}`,
      '可用组名见 metactl select');
  }
  if (!isSwitchable(group)) {
    fail('E_SELECT_NOT_SWITCHABLE', `策略组 ${groupName} 的类型是 ${group.type}，不能手动切换`,
      '只有 Selector 类型的组可选节点；URLTest / Fallback 由内核自动挑选');
  }
  if (group.all.indexOf(nodeName) < 0) {
    const head = group.all.slice(0, 10).join(' / ');
    fail('E_SELECT_BAD_NODE', `节点 ${nodeName} 不在策略组 ${groupName} 里`,
      `候选节点：${head}${group.all.length > 10 ? ' ...' : ''}`);
  }

  const r = await proc.controllerPut(ctx, '/proxies/' + encodeURIComponent(groupName), { name: nodeName });
  if (!r) {
    fail('E_SELECT_CONTROLLER', '控制器无响应，切换未完成', '请确认内核仍在运行');
  }
  if (r.status !== 204 && r.status !== 200) {
    const detail = (r.data && r.data.message) ? String(r.data.message) : `HTTP ${r.status}`;
    fail('E_SELECT_FAILED', `切换失败: ${detail}`, '请确认内核仍在运行，且该组类型可选');
  }

  // 回读确认，避免内核悄悄拒绝了请求
  const after = await proc.controllerRequest(ctx, '/proxies/' + encodeURIComponent(groupName), 5000);
  const now = (after && after.data && after.data.now != null) ? String(after.data.now) : null;
  const confirmed = now === nodeName;

  return { group: groupName, node: nodeName, now, confirmed };
}

module.exports = {
  SWITCHABLE_TYPE, isSwitchable, groupRows, groupDetail, loadProxies, switchNode,
};
