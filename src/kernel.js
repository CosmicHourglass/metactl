'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const rs = fs.createReadStream(file);
    rs.on('data', (c) => hash.update(c));
    rs.on('end', () => resolve(hash.digest('hex')));
    rs.on('error', reject);
  });
}

// 内核 exe 自身的指纹。zip 的 sha256 只能证明「下载的包没被篡改」，
// 这个能证明「落到磁盘上的 exe 就是那个 exe」—— 安装包自带内核时用它校验。
async function exeFingerprint(p) {
  const exeSha256 = await sha256File(p.mihomoExe);
  let exeBytes = 0;
  try { exeBytes = fs.statSync(p.mihomoExe).size; } catch (_) { /* ignore */ }
  return { exeSha256, exeBytes };
}

// 从本地 zip 安装：慢速网络（下载反复超时）或完全离线时用。
// 不删除用户提供的文件；有 --sha256 就校验，没有则如实标注未比对官方 digest。
async function installFromFile(ctx, o, arch, compatible) {
  const { p, logger } = ctx;
  const src = path.resolve(o.zipPath);
  if (!fs.existsSync(src)) {
    fail('E_KERNEL_PACKAGE_MISSING', `找不到本地内核包: ${src}`,
      '请确认路径正确；也可用 metactl kernel install 直接联网下载');
  }
  const stat = fs.statSync(src);
  if (!stat.isFile() || stat.size < 1024 * 1024) {
    fail('E_KERNEL_PACKAGE_MISSING', '本地内核包不像有效的 mihomo 压缩包',
      '官方 mihomo-windows-amd64 zip 约 22 MB，请确认文件完整后重试');
  }

  logger.info(`使用本地内核包 ${path.basename(src)} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
  const sha = await sha256File(src);
  const expected = String(o.sha256 || '').trim().toLowerCase();
  if (expected && expected !== sha) {
    fail('E_KERNEL_CHECKSUM', '本地内核包 sha256 与 --sha256 不一致',
      '文件可能损坏或被替换，请重新获取');
  }
  logger.ok(`sha256 ${sha.slice(0, 12)}...${expected ? '（已与 --sha256 比对）' : '（未比对官方 digest）'}`);

  try {
    fs.rmSync(p.mihomoNew, { force: true });
    await extractExe(src, p.mihomoNew);
    replaceExe(p);
  } catch (e) {
    try { fs.rmSync(p.mihomoNew, { force: true }); } catch (_) { /* ignore */ }
    if (e instanceof AppError) throw e;
    throw wrap('E_KERNEL_UNPACK', '内核解压失败', '请确认这是 mihomo 官方 zip（内含 .exe）', e);
  }

  const info = Object.assign({
    tag: 'local',
    asset: path.basename(src),
    sha256: sha,
    size: stat.size,
    arch,
    compatible: !!compatible,
    digestVerified: !!expected,
    downloadedAt: new Date().toISOString(),
  }, await exeFingerprint(p));
  writeAtomic(p.kernelJson, JSON.stringify(info, null, 2) + '\n');
  logger.ok(`内核就位（本地包） -> ${path.basename(p.mihomoExe)}`);
  return Object.assign({}, info, { skipped: false });
}

// 安装包自带内核：直接从包内拷到运行态，全程不联网。
// exeFile / metaFile 由调用方给出（npm 包内 assets/，或自包含包的 assets/）。
// metaFile 里必须有 exeSha256 —— 这是「包里的 exe 确实是那个 exe」的凭据。
async function installBundled(ctx, exeFile, metaFile) {
  const { p, logger } = ctx;
  if (!fs.existsSync(exeFile)) {
    fail('E_KERNEL_PACKAGE_MISSING', `安装包内没有内核文件: ${exeFile}`,
      '请重新安装；也可执行 metactl kernel install 联网下载官方内核');
  }
  const meta = readJson(metaFile, null);
  if (!meta || !meta.exeSha256) {
    fail('E_KERNEL_PACKAGE_MISSING', '安装包内的内核元信息缺失',
      '请重新安装最新版本；也可执行 metactl kernel install 联网下载官方内核');
  }
  const sha = await sha256File(exeFile);
  if (sha !== meta.exeSha256) {
    fail('E_KERNEL_CHECKSUM', '安装包内的内核校验不通过',
      '安装包可能已损坏或被修改过，请重新下载安装包');
  }
  fs.mkdirSync(p.binDir, { recursive: true });
  try {
    fs.copyFileSync(exeFile, p.mihomoExe);
  } catch (e) {
    throw wrap('E_KERNEL_UNPACK', '内核落盘失败',
      '内核可能正在运行，请先执行 metactl stop 后重试', e);
  }
  // 0.2.x 留下的旧内核文件清掉：不再被使用，却占着 60 MB
  const legacy = path.join(p.binDir, 'mihomo.exe');
  if (fs.existsSync(legacy)) {
    try { fs.rmSync(legacy, { force: true }); } catch (_) { /* 清不掉也无妨 */ }
  }
  const info = Object.assign({}, meta, {
    installedFrom: 'bundle',
    installedAt: new Date().toISOString(),
  });
  writeAtomic(p.kernelJson, JSON.stringify(info, null, 2) + '\n');
  logger.ok(`内核就位 ${info.tag || '内置'}（随安装包提供，无需联网）`);
  return info;
}

async function install(ctx, opts) {
  const { p, cfg, logger } = ctx;
  const o = opts || {};
  const arch = o.arch && o.arch !== 'auto' ? o.arch : require('./config').resolveArch(cfg);
  const compatible = o.compatible == null ? !!cfg.kernel.compatible : !!o.compatible;

  if (o.zipPath) return installFromFile(ctx, o, arch, compatible);

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

  const info = Object.assign({
    tag: asset.tag, asset: asset.name, sha256: result.sha256,
    size: result.bytes, arch, compatible: !!compatible,
    digestVerified: !!asset.digest,
    downloadedAt: new Date().toISOString(),
  }, await exeFingerprint(p));
  writeAtomic(p.kernelJson, JSON.stringify(info, null, 2) + '\n');
  logger.ok(`内核就位 ${asset.tag} -> ${path.basename(p.mihomoExe)}`);
  return Object.assign({}, info, { skipped: false });
}

module.exports = { install, installFromFile, installBundled, extractExe, safeEntryName, sha256File, exeFingerprint };
