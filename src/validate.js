'use strict';

// 生成的配置一律交给内核自身校验：AST 合法 != mihomo 接受。
const fs = require('fs');
const path = require('path');
const { runSync } = require('./system');
const { fail } = require('./errors');

function validate(ctx, configFile) {
  const { p } = ctx;
  if (!fs.existsSync(p.mihomoExe)) {
    fail('E_KERNEL_EXE_NOT_FOUND', '内核 mihomo.exe 不存在',
      '请先执行 metactl init 下载内核');
  }
  if (!fs.existsSync(configFile)) {
    fail('E_CONFIG_INVALID', '待校验的配置文件不存在', '请重新执行 metactl init');
  }
  fs.mkdirSync(p.dataDir, { recursive: true });
  const absConfig = path.resolve(configFile);
  const absData = path.resolve(p.dataDir);
  const r = runSync(p.mihomoExe, ['-t', '-f', absConfig, '-d', absData], {
    cwd: path.resolve(p.runtime),
    timeout: 60000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.code !== 0) {
    const lines = String(r.stderr || r.stdout || '')
      .split(/\r?\n/).filter((l) => l.trim()).slice(-15).join('\n');
    fail('E_CONFIG_INVALID', '生成的配置未通过 mihomo -t 校验',
      `内核输出（末 15 行）:\n${lines || '(无输出)'}\n可编辑 .runtime/config.json 的 ports 后重试 init`);
  }
  return true;
}

module.exports = { validate };
