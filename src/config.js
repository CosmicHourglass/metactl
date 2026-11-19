'use strict';

const crypto = require('crypto');
const { DEFAULT_CONFIG } = require('./constants');
const { readJson, writeAtomic } = require('./paths');
const { fail } = require('./errors');

function deepMerge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function load(p) {
  const raw = readJson(p.configJson, {});
  return deepMerge(DEFAULT_CONFIG, raw);
}

function save(p, cfg) {
  writeAtomic(p.configJson, JSON.stringify(cfg, null, 2) + '\n');
  return cfg;
}

function validatePorts(cfg) {
  const ports = cfg.ports;
  const nums = [ports.mixedPort, ports.socksPort, ports.port];
  const ctlPort = parseInt(String(ports.externalController).split(':').pop(), 10);
  const dnsPort = parseInt(String(ports.dnsListen).split(':').pop(), 10);
  const all = [...nums, ctlPort, dnsPort];
  for (const n of all) {
    if (!Number.isInteger(n) || n < 1024 || n > 65535) {
      fail('E_CONFIG_INVALID', `端口 ${n} 非法（应为 1024-65535 的整数）`,
        '请编辑 .runtime/config.json 的 ports 段');
    }
  }
  if (new Set(all).size !== all.length) {
    fail('E_CONFIG_INVALID', '端口存在重复', '请编辑 .runtime/config.json 的 ports 段，保证各端口互不相同');
  }
  return cfg;
}

function ensureSecret(p, cfg) {
  if (!cfg.controllerSecret) {
    cfg.controllerSecret = crypto.randomBytes(16).toString('hex');
    save(p, cfg);
  }
  return cfg.controllerSecret;
}

function ctlPort(cfg) {
  return parseInt(String(cfg.ports.externalController).split(':').pop(), 10);
}

function ctlHost(cfg) {
  const s = String(cfg.ports.externalController);
  const idx = s.lastIndexOf(':');
  return idx > 0 ? s.slice(0, idx) : '127.0.0.1';
}

function proxyServer(cfg) {
  return `127.0.0.1:${cfg.ports.mixedPort}`;
}

function resolveArch(cfg) {
  const a = cfg.kernel.arch;
  if (a && a !== 'auto') return a;
  return process.arch; // x64 / ia32 / arm64
}

module.exports = {
  load, save, validatePorts, ensureSecret,
  ctlPort, ctlHost, proxyServer, resolveArch, deepMerge,
};
