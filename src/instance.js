'use strict';

// 跨机 / 跨路径指纹：整目录拷到别的电脑后，PID 与系统代理快照都会失效，
// 必须在所有命令执行前识别并隔离，避免误杀进程或把别人的代理设置恢复回来。
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { readJson, writeAtomic } = require('./paths');

function rootHash(root) {
  return crypto.createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16);
}

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

// 只比较「机器 + 项目路径」。Node 版本切换是正常行为，不视为迁移。
function identity(root) {
  return {
    hostname: os.hostname(),
    projectRootHash: rootHash(root),
    nodeVersion: process.versions.node,
  };
}

function check(p) {
  const cur = identity(p.root);
  const old = readJson(p.instanceJson, null);

  if (!old) {
    const fresh = Object.assign({ instanceId: newId(), createdAt: new Date().toISOString() }, cur);
    writeAtomic(p.instanceJson, JSON.stringify(fresh, null, 2) + '\n');
    return { migrated: false, created: true, instanceId: fresh.instanceId, removed: [] };
  }

  const same = old.hostname === cur.hostname && old.projectRootHash === cur.projectRootHash;
  if (same) {
    // Node 版本变化时只更新记录，不触发迁移
    if (old.nodeVersion !== cur.nodeVersion) {
      writeAtomic(p.instanceJson, JSON.stringify(Object.assign({}, old, { nodeVersion: cur.nodeVersion }), null, 2) + '\n');
    }
    return { migrated: false, created: false, instanceId: old.instanceId, removed: [] };
  }

  const removed = [];
  if (fs.existsSync(p.pidJson)) {
    try { fs.rmSync(p.pidJson, { force: true }); removed.push('mihomo.pid'); }
    catch (_) { /* 保留但不再使用 */ }
  }
  if (fs.existsSync(p.proxyBackup)) {
    const dest = path.join(p.stateDir, `proxy-backup.foreign-${Date.now()}.json`);
    try { fs.renameSync(p.proxyBackup, dest); removed.push('proxy-backup.json'); }
    catch (_) { /* ignore */ }
  }

  const fresh = Object.assign({ instanceId: newId(), createdAt: new Date().toISOString() }, cur);
  writeAtomic(p.instanceJson, JSON.stringify(fresh, null, 2) + '\n');
  return {
    migrated: true,
    created: false,
    instanceId: fresh.instanceId,
    removed,
    previousHostname: old.hostname,
    previousRootHash: old.projectRootHash,
  };
}

module.exports = { identity, rootHash, check };
