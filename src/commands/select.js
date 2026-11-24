'use strict';

// 切换线路：查看策略组、查看候选节点、把某个组切到指定节点。
//
// 用法：
//   metactl select                  列出所有策略组与当前选中
//   metactl select <组名>            列出该组的候选节点
//   metactl select <组名> <节点名>     切换
//
// 只有 Selector 类型的组能手动挑节点；「自动选择」这类 URLTest 组由内核按延迟自动选，
// 对它执行切换会被内核拒绝，所以这里提前拦下来并说明原因。

const proc = require('../process');
const nodes = require('../nodes');
const { fail } = require('../errors');

// 中文是全角，按字符数补空格会歪。这里按显示宽度算。
function displayWidth(s) {
  let w = 0;
  for (const ch of String(s == null ? '' : s)) {
    const c = ch.codePointAt(0);
    const wide = (c >= 0x1100 && c <= 0x115f)
      || (c >= 0x2e80 && c <= 0xa4cf)
      || (c >= 0xac00 && c <= 0xd7a3)
      || (c >= 0xf900 && c <= 0xfaff)
      || (c >= 0xfe30 && c <= 0xfe4f)
      || (c >= 0xff00 && c <= 0xff60)
      || (c >= 0xffe0 && c <= 0xffe6)
      || (c >= 0x20000 && c <= 0x3fffd);
    w += wide ? 2 : 1;
  }
  return w;
}

function pad(s, n) {
  const str = String(s == null ? '' : s);
  return str + ' '.repeat(Math.max(0, n - displayWidth(str)));
}

async function run(ctx, args, opts) {
  const { logger } = ctx;
  const st = proc.status(ctx);
  if (!st.running) {
    fail('E_SELECT_NO_KERNEL', '内核未运行，无法查看或切换节点',
      '请先执行 metactl start，或用 metactl connect 一条命令连上');
  }

  const [groupName, nodeName] = args || [];
  const proxies = await nodes.loadProxies(ctx);

  // 一、只给组名：列出所有组
  if (!groupName) {
    const groups = nodes.groupRows(proxies);
    const out = { groups };
    logger.json(out);
    if (!groups.length) {
      logger.warn('订阅里没有策略组，请执行 metactl init 更新订阅');
      return out;
    }
    logger.info(`策略组（${groups.length} 个）:`);
    const w = Math.max(...groups.map((g) => displayWidth(g.name)));
    for (const g of groups) {
      const mark = g.switchable ? '' : '（内核自动选）';
      logger.info(`  ${pad(g.name, w)}  [${g.type}] → ${g.now || '(未选中)'}${mark}`);
    }
    logger.info('提示: 切换用 metactl select <组名> <节点名>；先看候选用 metactl select <组名>');
    return out;
  }

  const detail = nodes.groupDetail(proxies, groupName);
  if (!detail) {
    fail('E_SELECT_BAD_GROUP', `找不到策略组: ${groupName}`,
      '可用组名见 metactl select');
  }

  // 二、给了组名没给节点名：列出候选
  if (!nodeName) {
    const out = { group: detail };
    logger.json(out);
    logger.info(`策略组 ${detail.name} [${detail.type}] 当前选中: ${detail.now || '(未选中)'}`);
    if (!detail.switchable) {
      logger.warn('该组不是 Selector 类型，由内核自动选择，不能手动切换');
      return out;
    }
    logger.info(`候选节点（${detail.candidates.length} 个）:`);
    const w = Math.max(...detail.candidates.map((n) => displayWidth(n)));
    for (const n of detail.candidates) {
      logger.info(`  ${pad(n, w)}${n === detail.now ? '   ← 当前' : ''}`);
    }
    logger.info('提示: 切换用 metactl select ' + detail.name + ' <节点名>');
    return out;
  }

  // 三、切换
  const r = await nodes.switchNode(ctx, groupName, nodeName, { proxies });
  const out = { selected: r };
  logger.json(out);
  if (r.confirmed) {
    logger.ok(`已切换: ${r.group} → ${r.node}`);
  } else {
    logger.warn(`已请求切换 ${r.group} → ${r.node}，但内核回读到的选中项是 ${r.now || '(空)'}`);
  }
  logger.info('提示: 切换只影响新建立的连接，已有的连接仍走原来的节点');
  logger.info('提示: 切换不落盘，内核重启后回到默认线路');
  return out;
}

module.exports = { run, displayWidth, pad };
