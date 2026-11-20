'use strict';

// 生成自包含的 install.ps1（纯 ASCII、无 BOM）。
//
// 把 install-core.ps1 的 UTF-8 原字节以 base64 内嵌，这样「一行安装」只需要
// 一次网络请求：不会再因为第二次去 raw 拉取主脚本失败而中断。
// 主脚本保留 BOM + CRLF + 中文，运行时解码后剥离 BOM 再执行。
//
// 改完 install-core.ps1 后必须重新生成：npm run build:install

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const corePath = path.join(ROOT, 'install-core.ps1');
const outPath = path.join(ROOT, 'install.ps1');

const b64 = fs.readFileSync(corePath).toString('base64');
const lines = b64.match(/.{1,100}/g) || [];

const header = [
  '# metactl one-line installer (generated file; ASCII only, deliberately no BOM).',
  '# The real installer is embedded below as base64. Edit install-core.ps1,',
  '# then regenerate with: npm run build:install',
  '#',
  '#   irm https://raw.githubusercontent.com/CosmicHourglass/metactl/main/install.ps1 | iex',
  '#',
  '# Arguments are forwarded to the embedded script, e.g.',
  '#   .\\install.ps1 -ZipPath .\\metactl-0.2.0-win32-x64.zip -SkipKernel',
  '',
  "$ErrorActionPreference = 'Stop'",
  '$coreB64 = @(',
];
const body = lines.map((line) => "  '" + line + "'");
const footer = [
  ") -join ''",
  "$core = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($coreB64)) -replace '^\\uFEFF', ''",
  "$entry = [scriptblock]::Create($core)",
  '& $entry @args',
  '',
];

const out = header.concat(body, footer).join('\r\n');
if (/[^\x00-\x7F]/.test(out)) throw new Error('生成结果含非 ASCII 字符');
fs.writeFileSync(outPath, out, 'utf8');

process.stdout.write(
  'generated install.ps1: ' + out.length + ' bytes, ' + lines.length + ' base64 lines\n'
);
