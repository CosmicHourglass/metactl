'use strict';

// 所有路径都由 __dirname / os.homedir / 环境变量派生，绝不写死盘符或用户名。
const path = require('path');
const fs = require('fs');

function detectRoot() {
  // 从 src/ 向上找含 metactl 的 package.json；不用 cwd。
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const pkgPath = path.join(dir, 'package.json');
    try {
      const raw = fs.readFileSync(pkgPath, 'utf8');
      if (JSON.parse(raw).name === 'metactl') return dir;
    } catch (_) { /* 继续向上 */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 兜底：src 的上一级
  return path.resolve(__dirname, '..');
}

function resolveRoot(opts) {
  if (opts && opts.home) return path.resolve(opts.home);
  if (process.env.METACTL_HOME) return path.resolve(process.env.METACTL_HOME);
  return detectRoot();
}

function writeAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, buf);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // Windows 同卷 rename 覆盖已存在文件可行
  fs.renameSync(tmp, file);
  return file;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function createPaths(root) {
  const rt = path.join(root, '.runtime');
  const p = {
    root,
    runtime: rt,
    configJson: path.join(rt, 'config.json'),
    profileYaml: path.join(rt, 'profile.yaml'),
    profileMeta: path.join(rt, 'profile.meta.json'),
    configYaml: path.join(rt, 'config.yaml'),
    configBak: path.join(rt, 'config.yaml.bak'),
    binDir: path.join(rt, 'bin'),
    mihomoExe: path.join(rt, 'bin', 'mihomo.exe'),
    mihomoNew: path.join(rt, 'bin', 'mihomo.exe.new'),
    kernelJson: path.join(rt, 'bin', 'kernel.json'),
    stateDir: path.join(rt, 'state'),
    instanceJson: path.join(rt, 'state', 'instance.json'),
    pidJson: path.join(rt, 'state', 'mihomo.pid'),
    proxyBackup: path.join(rt, 'state', 'proxy-backup.json'),
    logsDir: path.join(rt, 'logs'),
    logOut: path.join(rt, 'logs', 'mihomo.log'),
    logErr: path.join(rt, 'logs', 'mihomo.err.log'),
    logCli: path.join(rt, 'logs', 'metactl.log'),
    tmpDir: path.join(rt, 'tmp'),
    dataDir: path.join(rt, 'data'),
  };
  return p;
}

function ensureDirs(p) {
  const dirs = [p.runtime, p.binDir, p.stateDir, p.logsDir, p.tmpDir, p.dataDir];
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
}

function cleanTmp(p) {
  try {
    for (const name of fs.readdirSync(p.tmpDir)) {
      try { fs.rmSync(path.join(p.tmpDir, name), { recursive: true, force: true }); }
      catch (_) { /* 忽略单个失败 */ }
    }
  } catch (_) { /* 目录不存在 */ }
}

function tail(file, lines) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const arr = text.split(/\r?\n/).filter((l) => l.length);
    return arr.slice(-lines).join('\n');
  } catch (_) {
    return '';
  }
}

module.exports = {
  detectRoot, resolveRoot, createPaths, ensureDirs, cleanTmp,
  writeAtomic, readJson, tail, path, fs,
};
