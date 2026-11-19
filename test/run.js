'use strict';

// 纯本地单元测试：不联网、不启动内核、不改注册表。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const YAML = require('yaml');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'metactl-test-'));
let passed = 0;
let failed = 0;

async function t(name, fn) {
  try { await fn(); passed++; process.stdout.write(`  OK  ${name}\n`); }
  catch (e) { failed++; process.stderr.write(` FAIL ${name}: ${e.message}\n`); }
}

const paths = require('../src/paths');
const config = require('../src/config');
const errors = require('../src/errors');
const constants = require('../src/constants');
const logger = require('../src/logger');
const profile = require('../src/profile');
const yamlPatch = require('../src/yaml-patch');
const instance = require('../src/instance');
const kernel = require('../src/kernel');
const http = require('../src/http');
const system = require('../src/system');
const proc = require('../src/process');
const scan = require('../scripts/scan-forbidden');

async function main() {
  await t('全部模块可加载', () => {
    for (const m of [
      'constants', 'errors', 'paths', 'config', 'logger', 'system', 'instance',
      'context', 'http', 'github', 'kernel', 'profile', 'yaml-patch', 'validate',
      'process', 'proxy', 'geodata', 'cli',
    ]) require('../src/' + m);
    for (const c of ['init', 'kernel', 'start', 'stop', 'restart', 'status', 'test', 'version', 'proxy']) {
      require('../src/commands/' + c);
    }
  });

  await t('AppError 退出码映射', () => {
    const e = new errors.AppError('E_PORT_IN_USE', 'x', 'hint');
    assert.strictEqual(e.exitCode, constants.EXIT.PORT_IN_USE);
    assert.strictEqual(errors.toExitCode(e), 17);
    assert.strictEqual(errors.toExitCode(new Error('x')), 1);
    assert.strictEqual(new errors.AppError('E_NOT_INITIALIZED', 'x').exitCode, 11);
  });

  await t('paths 原子写入与读取', () => {
    const f = path.join(TMP, 'a', 'b.json');
    paths.writeAtomic(f, '{"x":1}');
    assert.deepStrictEqual(paths.readJson(f, null), { x: 1 });
    paths.writeAtomic(f, '{"x":2}');
    assert.deepStrictEqual(paths.readJson(f, null), { x: 2 });
    assert.strictEqual(paths.readJson(path.join(TMP, 'nope.json'), 42), 42);
    assert.ok(paths.tail(f, 1).includes('x'));
    const p = paths.createPaths(TMP);
    assert.strictEqual(p.root, TMP);
    assert.ok(p.mihomoExe.endsWith('mihomo.exe'));
  });

  await t('config 合并 / 端口校验 / 端口助手', () => {
    assert.strictEqual(config.deepMerge({ a: 1, b: { c: 2 } }, { b: { d: 3 } }).b.c, 2);
    const p = paths.createPaths(path.join(TMP, 'cfg'));
    paths.ensureDirs(p);
    const cfg = config.load(p);
    config.validatePorts(cfg);
    assert.strictEqual(config.ctlPort(cfg), 19090);
    assert.strictEqual(config.ctlHost(cfg), '127.0.0.1');
    assert.strictEqual(config.proxyServer(cfg), '127.0.0.1:17890');
    const s = config.ensureSecret(p, cfg);
    assert.match(s, /^[a-f0-9]{32}$/);
    assert.strictEqual(config.load(p).controllerSecret, s);
    const bad = JSON.parse(JSON.stringify(cfg));
    bad.ports.mixedPort = 80;
    assert.throws(() => config.validatePorts(bad), (e) => e && e.code === 'E_CONFIG_INVALID');
    const dup = JSON.parse(JSON.stringify(cfg));
    dup.ports.socksPort = dup.ports.mixedPort;
    assert.throws(() => config.validatePorts(dup), /重复/);
  });

  await t('logger URL 打码与全局脱敏', () => {
    logger.init(paths.createPaths(TMP), {});
    const masked = logger.maskUrl('https://example.com/sub/abcdef1234567890/clash');
    assert.ok(!masked.includes('abcdef1234567890'), masked);
    assert.ok(masked.startsWith('https://example.com/'));
    logger.registerSecret('SECRET-TOKEN-123');
    assert.ok(!logger.maskText('a SECRET-TOKEN-123 b').includes('SECRET-TOKEN-123'));
  });

  await t('profile URL fragment 剔除 / UA 友好解析', () => {
    const r = profile.parseUrl('https://example.com/sub/tok/clash#MySub');
    assert.strictEqual(r.url, 'https://example.com/sub/tok/clash');
    assert.strictEqual(r.displayName, 'MySub');
    assert.throws(() => profile.parseUrl('not-a-url'), (e) => e && e.code === 'E_SUB_BAD_URL');
    assert.deepStrictEqual(profile.parseUserinfo('upload=1; download=2; total=3; expire=4'),
      { upload: 1, download: 2, total: 3, expire: 4 });
    assert.strictEqual(profile.stripBom('\ufeffabc'), 'abc');
  });

  await t('profile YAML 预检拒绝 HTML / base64', () => {
    const good = fs.readFileSync(path.join(__dirname, 'fixtures', 'profile-basic.yaml'), 'utf8');
    profile.assertYaml(good);
    assert.throws(() => profile.assertYaml('<!doctype html><html></html>'), (e) => e && e.code === 'E_SUB_INVALID_YAML');
    assert.throws(() => profile.assertYaml('cHJveGllczoKICAtIG5hbWU6IEEKYA=='), (e) => e && e.code === 'E_SUB_INVALID_YAML');
    assert.throws(() => profile.assertYaml('a: [1, 2'), (e) => e && e.code === 'E_SUB_INVALID_YAML');
  });

  await t('yaml-patch 覆盖顶层键并保留注释/锚点/节点', () => {
    const root = path.join(TMP, 'yaml');
    const p = paths.createPaths(root);
    paths.ensureDirs(p);
    fs.writeFileSync(p.profileYaml,
      fs.readFileSync(path.join(__dirname, 'fixtures', 'profile-basic.yaml')), 'utf8');
    const cfg = config.load(p);
    const ctx = { p, cfg, logger, migration: { instanceId: 'test' } };
    const built = yamlPatch.build(ctx);
    const text = fs.readFileSync(built.tmpFile, 'utf8');
    const doc = YAML.parseDocument(text, { uniqueKeys: false, logLevel: 'silent' });
    const obj = YAML.parse(text); // 纯 JS 对象，便于断言集合内容（merge key 会展开）
    assert.strictEqual(doc.errors.length, 0);
    assert.strictEqual(doc.get('mixed-port'), 17890);
    assert.strictEqual(doc.get('socks-port'), 17891);
    assert.strictEqual(doc.get('port'), 17892);
    assert.strictEqual(doc.get('external-controller'), '127.0.0.1:19090');
    assert.strictEqual(doc.get('secret'), cfg.controllerSecret);
    assert.strictEqual(doc.get('mode'), 'rule');
    assert.strictEqual(doc.get('allow-lan'), false);
    assert.strictEqual(doc.get('ipv6'), false);
    assert.deepStrictEqual(obj.tun, { enable: false });
    assert.strictEqual(doc.get('external-controller-pipe'), undefined);
    assert.strictEqual(doc.get('external-ui'), undefined);
    assert.strictEqual(doc.get('bind-address'), undefined);
    assert.strictEqual(doc.get('redir-port'), undefined);
    assert.ok(text.includes('# 测试用订阅快照'), '注释应保留');
    assert.ok(text.includes('&base') && text.includes('<<'), '锚点与 merge key 应保留');
    assert.ok(text.includes('测试节点-A') && text.includes('测试节点-B'), '节点内容应保留');
    assert.strictEqual(obj.proxies.length, 2);
    assert.strictEqual(obj.rules[0], 'MATCH,PROXY');
    assert.strictEqual(obj.dns.listen, '127.0.0.1:1053');
    yamlPatch.commit(ctx, built);
    assert.ok(fs.existsSync(p.configYaml));
  });

  await t('yaml-patch 重复顶层键只保留一个且值正确', () => {
    const root = path.join(TMP, 'yaml2');
    const p = paths.createPaths(root);
    paths.ensureDirs(p);
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'profile-duplicate.yaml'), p.profileYaml);
    const cfg = config.load(p);
    const built = yamlPatch.build({ p, cfg, logger, migration: { instanceId: 'test' } });
    const doc = YAML.parseDocument(fs.readFileSync(built.tmpFile, 'utf8'),
      { uniqueKeys: false, logLevel: 'silent' });
    assert.strictEqual(doc.errors.length, 0);
    const count = doc.contents.items.filter((it) => yamlPatch.keyOf(it) === 'mixed-port').length;
    assert.strictEqual(count, 1);
    assert.strictEqual(doc.get('mixed-port'), 17890);
    assert.strictEqual(doc.get('external-controller-pipe'), undefined);
    assert.strictEqual(YAML.parse(fs.readFileSync(built.tmpFile, 'utf8')).proxies.length, 1);
  });

  await t('instance 跨机指纹迁移与状态隔离', () => {
    const root = path.join(TMP, 'inst');
    const p = paths.createPaths(root);
    paths.ensureDirs(p);
    const first = instance.check(p);
    assert.strictEqual(first.migrated, false);
    assert.ok(first.instanceId);
    fs.writeFileSync(p.pidJson, '{"pid":99999}');
    fs.writeFileSync(p.proxyBackup, JSON.stringify({ instanceId: first.instanceId }));
    const rec = JSON.parse(fs.readFileSync(p.instanceJson, 'utf8'));
    rec.hostname = rec.hostname + '-OTHER';
    fs.writeFileSync(p.instanceJson, JSON.stringify(rec));
    const second = instance.check(p);
    assert.strictEqual(second.migrated, true);
    assert.notStrictEqual(second.instanceId, first.instanceId);
    assert.strictEqual(fs.existsSync(p.pidJson), false);
    assert.strictEqual(fs.existsSync(p.proxyBackup), false);
    const foreign = fs.readdirSync(p.stateDir).filter((n) => n.startsWith('proxy-backup.foreign-'));
    assert.strictEqual(foreign.length, 1);
    // 同一机器再次 check 不应再迁移
    assert.strictEqual(instance.check(p).migrated, false);
  });

  await t('kernel zip-slip 条目名防护', () => {
    assert.strictEqual(kernel.safeEntryName('mihomo-windows-amd64/mihomo.exe'), true);
    assert.strictEqual(kernel.safeEntryName('mihomo.exe'), true);
    assert.strictEqual(kernel.safeEntryName('../evil.exe'), false);
    assert.strictEqual(kernel.safeEntryName('/abs/evil.exe'), false);
    assert.strictEqual(kernel.safeEntryName('C:\\evil.exe'), false);
    assert.strictEqual(kernel.safeEntryName('a\\b\\evil.exe'), false);
    assert.strictEqual(kernel.safeEntryName('a/../evil.exe'), false);
  });

  await t('http 可重试错误判定', () => {
    assert.strictEqual(http.isRetryable(Object.assign(new Error('reset'), { code: 'ECONNRESET' })), true);
    assert.strictEqual(http.isRetryable(new Error('socket hang up')), true);
    assert.strictEqual(http.isRetryable(new Error('响应体过大')), false);
    assert.strictEqual(http.isRetryable(new errors.AppError('E_USAGE', 'x')), false);
  });

  await t('system 编码命令与系统根目录', () => {
    assert.ok(system.systemRoot().length > 0);
    const script = '$x = 1; Write-Output "中文 <local>"';
    assert.strictEqual(Buffer.from(system.encodedCommand(script), 'base64').toString('utf16le'), script);
  });

  await t('process 端口占用探测', async () => {
    const srv = net.createServer();
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    try {
      const busy = await proc.probePort(port);
      assert.strictEqual(busy.ok, false);
      assert.strictEqual(busy.code, 'EADDRINUSE');
    } finally {
      await new Promise((r) => srv.close(r));
    }
    const free = await proc.probePort(port);
    assert.strictEqual(free.ok, true);
  });

  await t('cli 装配：kernel 命令与 init 边界', () => {
    const program = require('../src/cli').build();
    const names = program.commands.map((c) => c.name());
    for (const n of ['init', 'kernel', 'start', 'stop', 'restart', 'status', 'test', 'version', 'proxy']) {
      assert.ok(names.includes(n), '缺少命令 ' + n);
    }
    const optNames = (name) => program.commands.find((c) => c.name() === name)
      .options.map((o) => o.long);
    const initOpts = optNames('init');
    assert.ok(initOpts.includes('--sub'));
    assert.ok(!initOpts.includes('--no-kernel'), 'init 不应再带内核选项');
    assert.ok(!initOpts.includes('--mirror'), 'init 不应再带镜像选项');
    assert.ok(!initOpts.includes('--arch'), 'init 不应再带架构选项');
    const kernelOpts = optNames('kernel');
    for (const o of ['--force', '--arch', '--compatible', '--mirror']) {
      assert.ok(kernelOpts.includes(o), 'kernel 缺少选项 ' + o);
    }
  });

  await t('postinstall 钩子与幂等判定', () => {
    const pkg = require('../package.json');
    assert.strictEqual(pkg.scripts.postinstall, 'node scripts/postinstall.js');
    const pi = require('../scripts/postinstall');
    const p = paths.createPaths(path.join(TMP, 'postinstall'));
    paths.ensureDirs(p);
    assert.strictEqual(pi.kernelPresent(p), false);
    fs.writeFileSync(p.mihomoExe, 'stub');
    fs.writeFileSync(p.kernelJson, JSON.stringify({ tag: 'stub-tag' }));
    assert.strictEqual(pi.kernelPresent(p), true);
    assert.strictEqual(pi.envFlag('METACTL_TEST_FLAG'), false);
  });

  await t('init 缺内核时拒绝且不联网', async () => {
    const p = paths.createPaths(path.join(TMP, 'init-no-kernel'));
    paths.ensureDirs(p);
    const ctx = { p, cfg: config.load(p), logger, migration: {} };
    await assert.rejects(
      () => require('../src/commands/init').run(ctx, [], { sub: 'https://example.com/sub/x/clash' }),
      (e) => e && e.code === 'E_KERNEL_NOT_INSTALLED'
    );
  });

  await t('proxy 注册表备份/恢复（模拟 reg.exe）', () => {
    // 受限终端无法调用真实 reg.exe，用内存注册表验证备份 -> 覆盖 -> 精确恢复
    const sysPath = require.resolve('../src/system');
    const realSys = require('../src/system');
    const store = { ProxyEnable: { type: 'REG_DWORD', value: '0x0' } };
    const fakeRunSync = (name, args) => {
      if (name !== 'reg.exe') return { code: 0, stdout: '', stderr: '' };
      const verb = args[0];
      const v = args[args.indexOf('/v') + 1];
      if (verb === 'query') {
        const rec = store[v];
        if (!rec) return { code: 1, stdout: '', stderr: '' };
        return { code: 0, stdout: `\n    ${v}    ${rec.type}    ${rec.value}\n`, stderr: '' };
      }
      if (verb === 'add') {
        store[v] = { type: args[args.indexOf('/t') + 1], value: args[args.indexOf('/d') + 1] };
        return { code: 0, stdout: '', stderr: '' };
      }
      if (verb === 'delete') { delete store[v]; return { code: 0, stdout: '', stderr: '' }; }
      return { code: 1, stdout: '', stderr: '' };
    };
    require.cache[sysPath] = {
      id: sysPath, filename: sysPath, loaded: true,
      exports: Object.assign({}, realSys, { runSync: fakeRunSync }),
    };
    delete require.cache[require.resolve('../src/proxy')];
    try {
      const px = require('../src/proxy');
      const root = path.join(TMP, 'proxy');
      const p = paths.createPaths(root);
      paths.ensureDirs(p);
      const ctx = { p, cfg: config.load(p), logger, migration: { instanceId: 'px-test' } };
      assert.strictEqual(px.current().enabled, false);
      const rec = px.backup(ctx);
      px.apply(ctx);
      assert.strictEqual(px.current().enabled, true);
      assert.strictEqual(px.current().server, '127.0.0.1:17890');
      assert.ok(String(px.current().override).includes('<local>'));
      // 二次 backup 不能把 metactl 自己设的值当成「用户原值」
      assert.strictEqual(px.backup(ctx).keys.ProxyServer.exists, false);
      px.restore(ctx, rec);
      const after = px.current();
      assert.strictEqual(after.enabled, false);
      assert.strictEqual(after.server, null);
      assert.strictEqual(after.override, null);
    } finally {
      delete require.cache[sysPath];
      delete require.cache[require.resolve('../src/proxy')];
    }
  });

  await t('禁词扫描全绿', () => {
    const hits = scan.scan();
    if (hits.length) {
      assert.fail('命中 ' + hits.length + ' 处:\n' + hits.map((h) => `${h.file}:${h.line} [${h.rule}] ${h.text}`).join('\n'));
    }
  });

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.stdout.write(`\n测试完成: ${passed} 通过, ${failed} 失败\n`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  process.stderr.write('测试脚本异常: ' + e.stack + '\n');
  process.exitCode = 1;
});
