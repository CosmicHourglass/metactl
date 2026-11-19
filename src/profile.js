'use strict';

const fs = require('fs');
const crypto = require('crypto');
const YAML = require('yaml');
const { get } = require('./http');
const { HTTP } = require('./constants');
const { fail } = require('./errors');
const { writeAtomic, readJson } = require('./paths');

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function parseUrl(raw) {
  let u;
  try { u = new URL(raw); }
  catch (_) {
    fail('E_SUB_BAD_URL', '订阅地址不是合法 URL',
      '请传入完整地址，例如 https://example.com/sub/<token>/clash#MySub');
  }
  if (!/^https?:$/.test(u.protocol)) {
    fail('E_SUB_BAD_URL', '订阅地址仅支持 http / https', '请检查地址协议');
  }
  // #fragment 只作显示名，HTTP 请求必须剔除
  let displayName = 'default';
  if (u.hash) {
    try { displayName = decodeURIComponent(u.hash.slice(1)) || 'default'; }
    catch (_) { displayName = 'default'; }
    u.hash = '';
  }
  return { url: u.toString(), displayName };
}

function parseUserinfo(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = /^\d+$/.test(v) ? Number(v) : v;
  }
  return out;
}

function parseInterval(header) {
  if (!header) return null;
  const n = parseInt(String(header).trim(), 10);
  return Number.isFinite(n) ? n : null;
}

// MVP 只支持原生 Clash YAML（非 base64、非 HTML）。真正的可用性由 mihomo -t 兜底。
function assertYaml(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    fail('E_SUB_INVALID_YAML', '订阅内容为空', '请确认订阅链接有效且未过期');
  }
  if (/^<!doctype|^<html|^<body/i.test(trimmed)) {
    fail('E_SUB_INVALID_YAML', '订阅返回的是 HTML 页面而非 Clash YAML',
      '请确认订阅链接选择的是 Clash / mihomo 格式，且链接未过期');
  }
  if (!/:/m.test(trimmed) && /^[A-Za-z0-9+/=\s]+$/.test(trimmed)) {
    fail('E_SUB_INVALID_YAML', '订阅返回的是 base64 内容，MVP 仅支持原生 Clash YAML',
      '请改用返回 YAML 明文的 Clash 订阅链接');
  }
  const doc = YAML.parseDocument(text, { uniqueKeys: false, logLevel: 'silent' });
  if (doc.errors.length) {
    fail('E_SUB_INVALID_YAML', `订阅 YAML 解析失败: ${doc.errors[0].message}`,
      '请确认订阅返回的是原生 Clash YAML 明文');
  }
  if (!YAML.isMap(doc.contents)) {
    fail('E_SUB_INVALID_YAML', '订阅 YAML 顶层不是键值映射',
      '请确认订阅返回的是原生 Clash YAML 明文');
  }
  return doc;
}

async function fetch(ctx, rawUrl) {
  const { p, cfg, logger } = ctx;
  if (!rawUrl || typeof rawUrl !== 'string') {
    fail('E_SUB_BAD_URL', '缺少订阅地址',
      '首次使用请执行 metactl init --sub <订阅地址>');
  }
  const parsed = parseUrl(rawUrl);
  logger.info(`拉取订阅 ${logger.maskUrl(parsed.url)} ...`);

  const r = await get(parsed.url, {
    headers: { 'User-Agent': cfg.userAgent, Accept: '*/*' },
    maxBytes: HTTP.maxBodyBytes,
    errorCode: 'E_SUB_FETCH_FAILED',
    errorMessage: '订阅下载失败',
    errorHint: '请检查网络与订阅地址；已有 profile 与内核不会被删除',
  });
  if (r.status !== 200) {
    fail('E_SUB_HTTP', `订阅返回 HTTP ${r.status}`,
      '请确认订阅链接有效、未过期，且服务端未要求特定客户端');
  }

  const text = stripBom(r.body.toString('utf8'));
  assertYaml(text); // 校验失败直接抛，不落盘，保留上一份可用 profile

  const meta = {
    url: rawUrl,
    displayName: parsed.displayName,
    fetchedAt: new Date().toISOString(),
    bytes: Buffer.byteLength(text, 'utf8'),
    sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
    userinfo: parseUserinfo(r.headers['subscription-userinfo']),
    interval: parseInterval(r.headers['profile-update-interval']),
  };

  writeAtomic(p.profileYaml, text);
  writeAtomic(p.profileMeta, JSON.stringify(meta, null, 2) + '\n');
  logger.registerSecret(rawUrl);
  logger.ok(`订阅已保存 (${parsed.displayName}，${meta.bytes} 字节)`);
  if (meta.userinfo && meta.userinfo.total) {
    const used = (meta.userinfo.upload || 0) + (meta.userinfo.download || 0);
    logger.info(`订阅流量: ${(used / 1024 / 1024 / 1024).toFixed(2)} / ${(meta.userinfo.total / 1024 / 1024 / 1024).toFixed(2)} GB`);
  }
  return meta;
}

function savedUrl(p) {
  const meta = readJson(p.profileMeta, null);
  return meta && typeof meta.url === 'string' ? meta.url : null;
}

module.exports = { fetch, parseUrl, assertYaml, parseUserinfo, stripBom, savedUrl };
