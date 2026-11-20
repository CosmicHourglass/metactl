'use strict';

// 可移植性守卫：源码里不得出现任何本机专有路径、真实订阅信息、实测常量或其它客户端名称。
// 用字符串拼接构造敏感字面量，避免扫描器自身包含这些串。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const W = {
  usersBack: 'C:' + '\\' + 'Users',
  usersSlash: 'C:' + '/' + 'Users',
  windowsBack: 'C:' + '\\' + 'Windows',
  windowsSlash: 'C:' + '/' + 'Windows',
  driveD: 'D:' + '\\' + 'Program',
  otherClient: 'ver' + 'ge',
  subName: 'COCO' + 'DUCK',
  localPortA: '78' + '97',
  localPortB: '90' + '97',
};

const RULES = [
  { name: '本机用户目录', re: new RegExp([W.usersBack, W.usersSlash].map(escapeRe).join('|'), 'i') },
  { name: '系统盘路径', re: new RegExp([W.windowsBack, W.windowsSlash].map(escapeRe).join('|'), 'i') },
  { name: '本机 D 盘路径', re: new RegExp(escapeRe(W.driveD), 'i') },
  // 任意 Windows 绝对路径字面量；要求字母前是行首/空白/引号等，避免误伤 http:// 这类 URL
  { name: 'Windows 绝对路径字面量', re: /(?:^|[\s"'=(\[])[A-Za-z]:[\\/]/m },
  { name: '其它客户端名称', re: new RegExp(W.otherClient, 'i') },
  { name: '真实订阅名', re: new RegExp(W.subName, 'i') },
  { name: '本机实测端口', re: new RegExp('\\b(' + W.localPortA + '|' + W.localPortB + ')\\b') },
  { name: '写死的 release tag', re: /\bv\d+\.\d+\.\d+\b/i },
  { name: '写死的 sha256 片段', re: /\b[a-f0-9]{32,}\b/i },
  { name: '写死的用户名', re: /\bliu\b/i },
];

function collect() {
  const files = [];
  for (const f of ['bin/cli.js', 'package.json', 'metactl.cmd', 'install.ps1', 'install-core.ps1', 'README.md']) {
    const abs = path.join(ROOT, f);
    if (fs.existsSync(abs)) files.push(abs);
  }
  const srcDir = path.join(ROOT, 'src');
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile() && e.name.endsWith('.js')) files.push(abs);
    }
  }(srcDir));
  const scriptsDir = path.join(ROOT, 'scripts');
  if (fs.existsSync(scriptsDir)) {
    for (const e of fs.readdirSync(scriptsDir, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.js')) files.push(path.join(scriptsDir, e.name));
    }
  }
  return files;
}

function scan() {
  const hits = [];
  for (const file of collect()) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const rule of RULES) {
        if (rule.re.test(line)) {
          hits.push({ file: rel(file), line: i + 1, rule: rule.name, text: line.trim().slice(0, 120) });
        }
      }
    });
  }
  return hits;
}

function report(hits) {
  if (!hits.length) return 0;
  for (const h of hits) {
    process.stderr.write(`  ${h.file}:${h.line}  [${h.rule}]  ${h.text}\n`);
  }
  return hits.length;
}

if (require.main === module) {
  const files = collect();
  const hits = scan();
  if (hits.length) {
    process.stderr.write(`禁词扫描未通过：${hits.length} 处命中\n`);
    report(hits);
    process.exitCode = 1;
  } else {
    process.stdout.write(`禁词扫描通过：${files.length} 个文件，未发现本机耦合或敏感字面量\n`);
  }
}

module.exports = { collect, scan, report, RULES, ROOT };
