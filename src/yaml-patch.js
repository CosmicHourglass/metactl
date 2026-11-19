'use strict';

// 用 YAML AST 覆盖顶层键：保留订阅的注释、锚点、merge key、proxies/rules 原语义。
// 订阅原文与本地覆盖分离——刷新订阅不会丢手工配置。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const YAML = require('yaml');
const { fail } = require('./errors');
const { ensureSecret, ctlPort } = require('./config');
const { stripBom } = require('./profile');

function keyOf(item) {
  const k = item.key;
  const v = k && typeof k === 'object' && 'value' in k ? k.value : k;
  return String(v);
}

// 注释挂在 pair.key.commentBefore 上；删除 pair 会连注释一起吞掉。
// 因此删之前先把注释收集起来，覆盖完成后回填到文档顶部。
function collectComment(item, collector) {
  if (!item || !collector) return;
  const node = item.key && typeof item.key === 'object' ? item.key : null;
  if (!node) return;
  // commentBefore 的前导空格决定输出时 `# ` 后是否带空格，不能 trim 掉
  if (node.commentBefore) collector.push(String(node.commentBefore).replace(/\s+$/, ''));
  if (node.comment) collector.push(String(node.comment).replace(/\s+$/, ''));
}

function restoreComments(doc, collector) {
  if (!collector || !collector.length) return;
  const text = Array.from(new Set(collector.filter(Boolean))).join('\n');
  if (!text) return;
  doc.commentBefore = doc.commentBefore ? `${doc.commentBefore}\n${text}` : text;
}

// 订阅里可能有重复顶层键（parseDocument 用 uniqueKeys:false 容忍），
// doc.delete 只删第一个，因此必须循环删干净再 set。
function deleteAll(doc, key, collector) {
  const m = doc.contents;
  if (!m || !Array.isArray(m.items)) return;
  for (const item of m.items) {
    if (keyOf(item) === key) collectComment(item, collector);
  }
  for (let i = m.items.length - 1; i >= 0; i--) {
    if (keyOf(m.items[i]) === key) m.items.splice(i, 1);
  }
}

function setTop(doc, key, value, collector) {
  deleteAll(doc, key, collector);
  doc.set(key, value);
}

const DELETE_KEYS = [
  'external-controller-pipe',
  'external-controller-unix',
  'external-controller-tls',
  'bind-address',
  'interface-name',
  'redir-port',
  'tproxy-port',
];
const DELETE_PREFIXES = [/^external-ui/];

function deleteUnwanted(doc, collector) {
  const m = doc.contents;
  if (!m || !Array.isArray(m.items)) return;
  const doomed = (k) => DELETE_KEYS.includes(k) || DELETE_PREFIXES.some((re) => re.test(k));
  for (const item of m.items) {
    if (doomed(keyOf(item))) collectComment(item, collector);
  }
  for (let i = m.items.length - 1; i >= 0; i--) {
    if (doomed(keyOf(m.items[i]))) m.items.splice(i, 1);
  }
}

function readDocument(p) {
  if (!fs.existsSync(p.profileYaml)) {
    fail('E_NOT_INITIALIZED', '缺少订阅快照 profile.yaml', '请先执行 metactl init');
  }
  const text = stripBom(fs.readFileSync(p.profileYaml, 'utf8'));
  const doc = YAML.parseDocument(text, { uniqueKeys: false, logLevel: 'silent' });
  if (doc.errors.length) {
    fail('E_SUB_INVALID_YAML', `订阅 YAML 解析失败: ${doc.errors[0].message}`,
      '请执行 metactl init --force 重新拉取订阅');
  }
  if (!YAML.isMap(doc.contents)) {
    fail('E_SUB_INVALID_YAML', '订阅 YAML 顶层不是键值映射',
      '请执行 metactl init --force 重新拉取订阅');
  }
  return doc;
}

function build(ctx) {
  const { p, cfg } = ctx;
  const secret = ensureSecret(p, cfg);
  const doc = readDocument(p);
  const savedComments = []; // 被覆盖/删除的键上方的注释，最后回填到文档顶部

  // 端口：订阅自带 7890 等默认值，必须全部覆盖成 CLI 自己的一套
  setTop(doc, 'mixed-port', cfg.ports.mixedPort, savedComments);
  setTop(doc, 'socks-port', cfg.ports.socksPort, savedComments);
  setTop(doc, 'port', cfg.ports.port, savedComments);

  // 控制器：secret 写进配置文件而非 argv（argv 会被任务管理器 / WMI 看到）
  setTop(doc, 'external-controller', cfg.ports.externalController, savedComments);
  setTop(doc, 'secret', secret, savedComments);

  setTop(doc, 'allow-lan', !!cfg.allowLan, savedComments);
  setTop(doc, 'mode', cfg.mode, savedComments);
  setTop(doc, 'log-level', cfg.logLevel, savedComments);
  setTop(doc, 'ipv6', !!cfg.ipv6, savedComments);

  // 显式关闭 TUN（MVP 不做 TUN），同时清掉 tun 专属子字段
  setTop(doc, 'tun', { enable: false }, savedComments);

  deleteUnwanted(doc, savedComments);
  restoreComments(doc, savedComments);

  // dns.listen 只有在订阅本来就带 dns 块时才覆盖，避免凭空造出半个 dns 配置
  const dnsVal = doc.get('dns');
  if (dnsVal && typeof dnsVal === 'object' && !Array.isArray(dnsVal)) {
    try { doc.setIn(['dns', 'listen'], cfg.ports.dnsListen); }
    catch (_) { /* 结构异常时交给 -t 兜底 */ }
  }

  let text;
  try { text = String(doc); }
  catch (e) {
    fail('E_CONFIG_WRITE', '生成配置文本失败', '请执行 metactl init --force 重新拉取订阅', e);
  }
  if (!text.endsWith('\n')) text += '\n';

  fs.mkdirSync(p.tmpDir, { recursive: true });
  const tmpFile = path.join(p.tmpDir, 'config.yaml.tmp');
  fs.writeFileSync(tmpFile, text, 'utf8'); // UTF-8 无 BOM

  return {
    tmpFile,
    text,
    sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
    controllerPort: ctlPort(cfg),
    secret,
  };
}

// -t 通过后才替换正式配置；失败时旧 config.yaml 完全不受影响
function commit(ctx, built) {
  const { p } = ctx;
  if (fs.existsSync(p.configYaml)) {
    try { fs.copyFileSync(p.configYaml, p.configBak); }
    catch (_) { /* 备份失败不阻断 */ }
  }
  try {
    fs.renameSync(built.tmpFile, p.configYaml);
  } catch (e) {
    fail('E_CONFIG_WRITE', '写入 config.yaml 失败', '请查看 .runtime/logs/metactl.log', e);
  }
  return p.configYaml;
}

module.exports = {
  build, commit, readDocument, keyOf, deleteAll, setTop, deleteUnwanted,
  collectComment, restoreComments,
};
