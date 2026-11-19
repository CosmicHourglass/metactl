'use strict';

// mihomo 校验含 GEOIP / GEOSITE 规则的配置时需要本地 geodata 文件；
// 若缺失它会自己去 GitHub 下载，受限网络下会失败并导致 -t 失败。
// 这里在 -t 失败后按需补下到 data/，复用 http 的镜像/代理能力。
const fs = require('fs');
const path = require('path');
const { download } = require('./http');

const GEO_FILES = [
  {
    name: 'geoip.metadb',
    url: 'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.metadb',
  },
  {
    name: 'geosite.dat',
    url: 'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geosite.dat',
  },
];

function wantedFromError(err) {
  // 只看真正的错误行，避免日志里的 "Geosite Matcher implementation" 这类 info 行误触发
  const s = String((err && err.hint) || '') + ' ' + String((err && err.message) || '');
  const errorLines = s.split(/\r?\n/).filter((l) => /can't download|level=error|error:/i.test(l)).join(' ');
  const source = errorLines || s;
  const names = [];
  if (/MMDB|geoip\.metadb|GeoIP|GEOIP/i.test(source)) names.push('geoip.metadb');
  if (/geosite\.dat|can't (initial|load) GeoSite/i.test(source)) names.push('geosite.dat');
  return names.length ? names : GEO_FILES.map((f) => f.name);
}

function isGeodataError(err) {
  const s = String((err && err.hint) || '') + ' ' + String((err && err.message) || '');
  return /can't download|download MMDB|geoip\.metadb|geosite\.dat|initial GeoIP/i.test(s);
}

async function ensure(ctx, mirror, names) {
  const { p, logger } = ctx;
  const prefix = String(mirror || process.env.METACTL_MIRROR || '').trim().replace(/\/+$/, '');
  const targets = GEO_FILES.filter((f) => !names || names.indexOf(f.name) >= 0);
  let count = 0;
  fs.mkdirSync(p.dataDir, { recursive: true });
  fs.mkdirSync(p.tmpDir, { recursive: true });

  for (const f of targets) {
    const final = path.join(p.dataDir, f.name);
    if (fs.existsSync(final) && fs.statSync(final).size > 0) {
      count++;
      continue;
    }
    const url = prefix ? prefix + '/' + f.url : f.url;
    const tmp = path.join(p.tmpDir, f.name + '.tmp');
    logger.info(`补下 Geo 数据 ${f.name} ...`);
    try {
      await download(url, tmp, {
        maxBytes: 64 * 1024 * 1024,
        retries: 1,
        errorCode: 'E_KERNEL_DOWNLOAD_FAILED',
        errorMessage: `下载 ${f.name} 失败`,
        errorHint: '可指定 --mirror <镜像前缀>，或手动把文件放到 .runtime/data/ 后重试 init',
      });
      fs.renameSync(tmp, final);
      count++;
      logger.ok(`${f.name} 已就位`);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch (_) { /* ignore */ }
      logger.warn(`${f.name} 下载失败: ${e.message}`);
    }
  }
  return count;
}

module.exports = { GEO_FILES, ensure, wantedFromError, isGeodataError };
