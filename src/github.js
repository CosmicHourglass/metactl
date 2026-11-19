'use strict';

const { getJson } = require('./http');
const { GITHUB, ARCH_MAP } = require('./constants');
const { fail } = require('./errors');

// tag / digest / 资产名一律运行时获取，绝不在源码里写死版本号。
async function latestRelease() {
  const r = await getJson(GITHUB.latestApi, {
    headers: {
      'User-Agent': GITHUB.apiUserAgent,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': GITHUB.apiVersion,
    },
    maxBytes: 4 * 1024 * 1024,
    errorCode: 'E_GITHUB_API',
    errorMessage: '无法获取 mihomo 最新版本信息',
    errorHint: '请检查网络；GitHub 匿名 API 有每小时限流，可稍后重试',
  });

  const remaining = String(r.headers['x-ratelimit-remaining'] || '');
  if ((r.status === 403 || r.status === 429) && remaining === '0') {
    fail('E_GITHUB_RATE_LIMIT', 'GitHub API 匿名请求已达限流',
      '请等待限流窗口重置后重试（通常 1 小时）');
  }
  if (r.status !== 200) {
    fail('E_GITHUB_API', `GitHub API 返回 HTTP ${r.status}`,
      '请检查网络或稍后重试');
  }
  const d = r.data;
  if (!d || typeof d.tag_name !== 'string' || !Array.isArray(d.assets)) {
    fail('E_GITHUB_API', 'GitHub API 返回结构异常（缺少 tag_name / assets）',
      '请稍后重试；若持续出现请检查 API 版本');
  }
  return d;
}

function assetFor(release, arch, compatible) {
  const a = ARCH_MAP[arch];
  if (!a) {
    fail('E_KERNEL_ASSET_NOT_FOUND', `不支持的 CPU 架构 ${arch}`,
      '可用 arch: x64 / ia32 / arm64（默认 auto 跟随当前 Node 架构）');
  }
  const tag = String(release.tag_name);
  const compat = compatible ? '-compatible' : '';
  const name = GITHUB.assetNameTemplate
    .replace('{arch}', a)
    .replace('{compat}', compat)
    .replace('{tag}', tag);

  // 精确名相等匹配：release 里同时存在 -go1xx / -v1 / -v2 / -v3 等变体，模糊匹配会选错。
  const asset = release.assets.find((x) => x.name === name);
  if (!asset) {
    const avail = release.assets
      .filter((x) => /^mihomo-windows-/.test(x.name))
      .map((x) => x.name).slice(0, 24);
    fail('E_KERNEL_ASSET_NOT_FOUND', `未找到内核资产 ${name}`,
      `该版本可用资产: ${avail.join(', ')}；也可尝试 --compatible`);
  }
  let digest = null;
  if (typeof asset.digest === 'string' && /^sha256:/i.test(asset.digest)) {
    digest = asset.digest.slice(7).toLowerCase();
  }
  if (typeof asset.browser_download_url !== 'string' || !asset.browser_download_url) {
    fail('E_KERNEL_ASSET_NOT_FOUND', `资产 ${name} 缺少下载地址`, '请稍后重试');
  }
  return {
    tag, name,
    // 主路径：GitHub API 的 release asset 端点（Accept: application/octet-stream），
    // 只依赖 api.github.com + 资产 CDN，不依赖常被阻断的 github.com。
    apiUrl: typeof asset.url === 'string' && asset.url ? asset.url : null,
    // 回退路径：官方发布页直链
    url: asset.browser_download_url,
    digest, size: Number(asset.size) || 0, arch, compatible: !!compatible,
  };
}

module.exports = { latestRelease, assetFor };
