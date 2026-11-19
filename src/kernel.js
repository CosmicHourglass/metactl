'use strict';

const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');
const { download } = require('./http');
const github = require('./github');
const { HTTP } = require('./constants');
const { fail, wrap, AppError } = require('./errors');
const { writeAtomic, readJson } = require('./paths');

// 只把 exe 写到固定目标文件，不按压缩包内路径创建文件 —— 天然免疫 zip-slip；
// 仍逐条校验 entry 名，遇到可疑条目直接放弃整个包。
function safeEntryName(name) {
  if (!name || typeof name !== 'string') return false;
  if (/[\\:]/.test(name)) return false;
  if (/^[A-Za-z]:/.test(name)) return false;
  if (name.startsWith('/')) return false;
  const segs = name.split('/');
  if (segs.some((s) => s === '..' || s === '.')) return false;
  return true;
}

function extractExe(zipFile, destFile) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipFile, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err) { reject(err); return; }
      const entries = [];
      let finished = false;
      const done = (e, value) => {
        if (finished) return;
        finished = true;
        try { zip.close(); } catch (_) { /* ignore */ }
        if (e) reject(e); else resolve(value);
      };

      zip.on('entry', (entry) => {
        if (!safeEntryName(entry.fileName)) {
          done(new Error('压缩包包含不安全条目名: ' + entry.fileName));
          return;
        }
        entries.push(entry);
        zip.readEntry();
      });
      zip.on('error', (e) => done(e));
      zip.on('end', () => {
        const exes = entries.filter((e) => /\.exe$/i.test(e.fileName) && !/\/$/.test(e.fileName));
        if (!exes.length) { done(new Error('压缩包内没有 .exe 文件')); return; }
        const pick = exes.find((e) => /mihomo/i.test(path.posix.basename(e.fileName))) || exes[0];
        zip.openReadStream(pick, (e2, rs) => {
          if (e2) { done(e2); return; }
          fs.mkdirSync(path.dirname(destFile), { recursive: true });
          const ws = fs.createWriteStream(destFile);
          rs.on('error', (e3) => { try { ws.destroy(); } catch (_) {} done(e3); });
          ws.on('error', (e3) => { try { rs.destroy(); } catch (_) {} done(e3); });
          ws.on('finish', () => done(null, { entry: pick.fileName, size: pick.uncompressedSize }));
          rs.pipe(ws);
        });
      });
      zip.readEntry();
    });
  });
}

function replaceExe(p) {
  try {
    fs.renameSync(p.mihomoNew, p.mihomoExe);
  } catch (e) {
    if (['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) {
      fail('E_KERNEL_BUSY', '内核文件被占用，无法替换',
        '请先执行 metactl stop 停止正在运行的内核，再重试 init', e);
    }
    throw wrap('E_KERNEL_UNPACK', '替换内核文件失败', '请查看 .runtime/logs/metactl.log', e);
  }
}

async function install(ctx, opts) {
  const { p, cfg, logger } = ctx;
  const o = opts || {};
  const arch = o.arch && o.arch !== 'auto' ? o.arch : require('./config').resolveArch(cfg);
  const compatible = o.compatible == null ? !!cfg.kernel.compatible : !!o.compatible;

  const release = await github.latestRelease();
  const asset = github.assetFor(release, arch, compatible);
  logger.debug(`release tag=${asset.tag} asset=${asset.name}`);

  const existing = readJson(p.kernelJson, null);
  const unchanged = existing && existing.tag === asset.tag &&
    existing.arch === arch && !!existing.compatible === !!compatible &&
    fs.existsSync(p.mihomoExe);
  if (unchanged && !o.force) {
    logger.ok(`内核已是 ${asset.tag}，跳过下载`);
    return Object.assign({}, existing, { skipped: true });
  }

  const zipPath = path.join(p.tmpDir, asset.name);
  const label = asset.size ? ` (${(asset.size / 1024 / 1024).toFixed(1)} MB)` : '';
  const routes = [];
  // 可选镜像前缀：受限网络下由用户自行指定，源码不内置任何第三方域名。
  // sha256 仍按 GitHub 官方 digest 校验，镜像无法篡改内容。
  const mirror = String(o.mirror || process.env.METACTL_MIRROR || '').trim().replace(/\/+$/, '');
  if (mirror) {
    routes.push({
      url: mirror + '/' + asset.url,
      headers: {},
      name: `镜像 ${mirror.replace(/^https?:\/\//, '').split('/')[0]}`,
    });
  }
  if (asset.apiUrl) {
    routes.push({
      url: asset.apiUrl,
      headers: { Accept: 'application/octet-stream' },
      name: 'GitHub API 资产端点',
    });
  }
  routes.push({ url: asset.url, headers: {}, name: 'GitHub 发布页' });

  let result = null;
  let lastError = null;
  for (const route of routes) {
    logger.info(`下载内核 ${asset.name}${label} <- ${route.name} ...`);
    try {
      result = await download(route.url, zipPath, {
        maxBytes: HTTP.maxZipBytes,
        headers: route.headers,
        retries: 1,
        errorCode: 'E_KERNEL_DOWNLOAD_FAILED',
        errorMessage: '内核下载失败',
        errorHint: '请检查网络；若处于受限网络可设置 HTTPS_PROXY 环境变量。已有内核未被删除，可重试',
      });
      break;
    } catch (e) {
      lastError = e;
      try { fs.rmSync(zipPath, { force: true }); } catch (_) { /* ignore */ }
      logger.warn(`${route.name} 下载失败，尝试另一条路径`);
    }
  }
  if (!result) throw lastError;

  if (asset.digest && result.sha256 !== asset.digest) {
    try { fs.rmSync(zipPath, { force: true }); } catch (_) { /* ignore */ }
    fail('E_KERNEL_CHECKSUM', '内核 sha256 校验不通过',
      '文件可能损坏或被中间网络篡改，请重试 init；已有内核未被删除');
  }
  logger.ok(`下载完成 ${result.bytes} 字节，sha256 ${result.sha256.slice(0, 12)}...`);

  try {
    fs.rmSync(p.mihomoNew, { force: true });
    await extractExe(zipPath, p.mihomoNew);
    replaceExe(p);
  } catch (e) {
    try { fs.rmSync(p.mihomoNew, { force: true }); } catch (_) { /* ignore */ }
    if (e instanceof AppError) throw e; // 业务错误直接透传
    throw wrap('E_KERNEL_UNPACK', '内核解压失败', '请查看 .runtime/logs/metactl.log', e);
  } finally {
    try { fs.rmSync(zipPath, { force: true }); } catch (_) { /* ignore */ }
  }

  const info = {
    tag: asset.tag, asset: asset.name, sha256: result.sha256,
    size: result.bytes, arch, compatible: !!compatible,
    digestVerified: !!asset.digest,
    downloadedAt: new Date().toISOString(),
  };
  writeAtomic(p.kernelJson, JSON.stringify(info, null, 2) + '\n');
  logger.ok(`内核就位 ${asset.tag} -> ${path.basename(p.mihomoExe)}`);
  return Object.assign({}, info, { skipped: false });
}

module.exports = { install, extractExe, safeEntryName };
