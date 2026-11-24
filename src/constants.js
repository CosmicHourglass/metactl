'use strict';

// 只放模板与默认值。任何运行时实测值（release tag、digest、订阅信息、端口占用）都不得出现在这里。

const DEFAULT_CONFIG = {
  version: 1,
  ports: {
    mixedPort: 17890,
    socksPort: 17891,
    port: 17892,
    externalController: '127.0.0.1:19090',
    dnsListen: '127.0.0.1:1053',
  },
  mode: 'rule',
  logLevel: 'info',
  allowLan: false,
  ipv6: false,
  // 本地网页操作端的端口。只监听回环地址，不对外暴露
  webPort: 17893,
  // 订阅服务通常按 UA 里的 clash / mihomo 关键字返回原生 YAML
  userAgent: 'Clash/2024 mihomo/1.19 metactl/0.1',
  kernel: {
    // auto = 跟随 process.arch 推导；也可显式 x64 / ia32 / arm64
    arch: 'auto',
    compatible: false,
  },
  proxy: {
    override: 'localhost;127.*;127.0.0.1;<local>',
  },
};

const GITHUB = {
  latestApi: 'https://api.github.com/repos/MetaCubeX/mihomo/releases/latest',
  apiVersion: '2022-11-28',
  apiUserAgent: 'metactl/0.1',
  // 资产名模板：tag 在运行时从 API 取得后填入，精确名相等匹配
  assetNameTemplate: 'mihomo-windows-{arch}{compat}-{tag}.zip',
};

const ARCH_MAP = {
  x64: 'amd64',
  ia32: '386',
  arm64: 'arm64',
};

const HTTP = {
  connectTimeoutMs: 10000,
  readTimeoutMs: 60000,
  maxRedirects: 5,
  maxBodyBytes: 16 * 1024 * 1024,
  maxZipBytes: 80 * 1024 * 1024,
  retries: 2,
  retryDelayMs: 600,
};

const PROCESS = {
  healthIntervalMs: 300,
  healthMaxMs: 15000,
  stopWaitMs: 5000,
  imageName: 'mihomo-metactl.exe',
  // 0.2.x 装的是 mihomo.exe。升级后仍在运行的老内核也要认得出来，
  // 否则会被当成 PID 复用而清掉记录，老进程就成了没人管的孤儿。
  legacyImageNames: ['mihomo.exe'],
};

// 退出码 -> 语义。AppError 的 exitCode 从这里派生。
const EXIT = {
  OK: 0,
  INTERNAL: 1,
  USAGE: 2,
  ENV: 10,
  NOT_INITIALIZED: 11,
  SUBSCRIPTION: 12,
  KERNEL: 13,
  CONFIG: 14,
  ALREADY_RUNNING: 15,
  NOT_RUNNING: 16,
  PORT_IN_USE: 17,
  START_FAILED: 18,
  REGISTRY: 19,
  FOREIGN_BACKUP: 20,
  SELECT: 21,
  WEB: 22,
};

const REG = {
  key: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
  enable: 'ProxyEnable',
  server: 'ProxyServer',
  override: 'ProxyOverride',
};

module.exports = {
  DEFAULT_CONFIG,
  GITHUB,
  ARCH_MAP,
  HTTP,
  PROCESS,
  EXIT,
  REG,
};
