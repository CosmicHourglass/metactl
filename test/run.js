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

// 用内存注册表替换 reg.exe，让代理相关逻辑可在受限终端下单元测试。
function withRegistry(store, fn, extraModules) {
  const sysPath = require.resolve('../src/system');
  const pxPath = require.resolve('../src/proxy');
  const extraPaths = (extraModules || []).map((m) => require.resolve(m));
  const realSys = require('../src/system');
  const runSync = (name, args) => {
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
    exports: Object.assign({}, realSys, { runSync }),
  };
  delete require.cache[pxPath];
  for (const ep of extraPaths) delete require.cache[ep];
  try { return fn(require('../src/proxy')); }
  finally {
    delete require.cache[sysPath];
    delete require.cache[pxPath];
    for (const ep of extraPaths) delete require.cache[ep];
  }
}

// 用假的外部控制器替换 process 模块，测速逻辑可离线单元测试。
async function withFakeProcess(fakeExports, fn) {
  const procPath = require.resolve('../src/process');
  const speedPath = require.resolve('../src/commands/speed');
  const realProc = require('../src/process');
  require.cache[procPath] = {
    id: procPath, filename: procPath, loaded: true,
    exports: Object.assign({}, realProc, fakeExports),
  };
  delete require.cache[speedPath];
  try { return await fn(require(speedPath)); }
  finally {
    delete require.cache[procPath];
    delete require.cache[speedPath];
  }
}

const quietLogger = {
  info() {}, ok() {}, warn() {}, err() {}, debug() {}, json() {},
  maskUrl: (s) => s, maskText: (s) => s,
};

async function main() {
  await t('全部模块可加载', () => {
    for (const m of [
      'constants', 'errors', 'paths', 'config', 'logger', 'system', 'instance',
      'context', 'http', 'github', 'kernel', 'profile', 'yaml-patch', 'validate',
      'process', 'proxy', 'geodata', 'userpath', 'uninstall', 'cli',
    ]) require('../src/' + m);
    for (const c of ['init', 'kernel', 'fix', 'speed', 'route', 'start', 'stop', 'restart', 'status', 'test', 'version', 'proxy', 'uninstall']) {
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
    for (const n of ['init', 'kernel', 'fix', 'speed', 'route', 'start', 'stop', 'restart', 'status', 'test', 'version', 'proxy']) {
      assert.ok(names.includes(n), '缺少命令 ' + n);
    }
    const fixOpts = program.commands.find((c) => c.name() === 'fix').options.map((o) => o.long);
    assert.ok(fixOpts.includes('--force'), 'fix 缺少 --force');
    const speedOpts = program.commands.find((c) => c.name() === 'speed').options.map((o) => o.long);
    for (const o of ['--group', '--url', '--timeout', '--limit']) {
      assert.ok(speedOpts.includes(o), 'speed 缺少选项 ' + o);
    }
    const optNames = (name) => program.commands.find((c) => c.name() === name)
      .options.map((o) => o.long);
    const initOpts = optNames('init');
    assert.ok(initOpts.includes('--sub'));
    assert.ok(!initOpts.includes('--no-path'), 'PATH 属于安装阶段，init 不应再带该选项');
    assert.ok(!initOpts.includes('--no-kernel'), 'init 不应再带内核选项');
    assert.ok(!initOpts.includes('--mirror'), 'init 不应再带镜像选项');
    assert.ok(!initOpts.includes('--arch'), 'init 不应再带架构选项');
    const kernelOpts = optNames('kernel');
    for (const o of ['--force', '--arch', '--compatible', '--mirror']) {
      assert.ok(kernelOpts.includes(o), 'kernel 缺少选项 ' + o);
    }
  });

  await t('uninstall 安装方式判定与卸载计划', () => {
    const u = require('../src/uninstall');
    const program = require('../src/cli').build();
    assert.ok(program.commands.map((c) => c.name()).includes('uninstall'), '缺少 uninstall 命令');
    const uninstallOpts = program.commands.find((c) => c.name() === 'uninstall').options.map((o) => o.long);
    for (const o of ['--purge', '--yes', '--keep-program']) {
      assert.ok(uninstallOpts.includes(o), 'uninstall 缺少选项 ' + o);
    }

    // 自包含安装：程序根下有 bundle.json
    const bundleRoot = path.join(TMP, 'install', 'current');
    fs.mkdirSync(bundleRoot, { recursive: true });
    fs.writeFileSync(path.join(bundleRoot, 'bundle.json'), JSON.stringify({ name: 'metactl' }));
    assert.strictEqual(u.detectMode(bundleRoot), 'bundle');
    // npm 全局安装：路径里有 node_modules
    const npmRoot = path.join(TMP, 'npm-global', 'node_modules', 'metactl');
    assert.strictEqual(u.detectMode(npmRoot), 'npm-global');
    // 项目目录内运行
    assert.strictEqual(u.detectMode(path.join(TMP, 'project')), 'source');

    const mkCtx = (programRoot, root) => ({
      programRoot, root, p: paths.createPaths(root),
    });
    const bundleCtx = mkCtx(bundleRoot, path.join(TMP, 'install'));
    let p = u.plan(bundleCtx, {});
    assert.strictEqual(p.mode, 'bundle');
    assert.strictEqual(p.removePathEntry, true, '自包含安装应移除 PATH 条目');
    assert.strictEqual(p.removeProgram, true);
    assert.strictEqual(p.purgeData, false);
    assert.strictEqual(p.launcherDir, path.join(bundleRoot, 'bin'));

    p = u.plan(bundleCtx, { keepProgram: true });
    assert.strictEqual(p.removeProgram, false);
    assert.strictEqual(p.removePathEntry, false, '保留程序时不该动 PATH');

    p = u.plan(bundleCtx, { purge: true });
    assert.strictEqual(p.purgeData, true);

    // npm 全局安装：命令目录是共享的，不动 PATH
    const npmCtx = mkCtx(npmRoot, path.join(TMP, 'npm-data'));
    p = u.plan(npmCtx, {});
    assert.strictEqual(p.mode, 'npm-global');
    assert.strictEqual(p.removePathEntry, false, 'npm 全局目录为共享目录，不应动 PATH');
    assert.strictEqual(p.launcherDir, null);

    // 源码目录运行：绝不删用户自己的代码
    const srcCtx = mkCtx(path.join(TMP, 'project'), path.join(TMP, 'project'));
    p = u.plan(srcCtx, {});
    assert.strictEqual(p.mode, 'source');
    assert.strictEqual(p.removePathEntry, false);
  });

  await t('uninstall PATH 条目移除：只删目标项 / 幂等', () => {
    const dir = path.join(TMP, 'cmd 目录');
    const store = {};
    withRegistry(store, () => {
      const up = require('../src/userpath');
      store.Path = { type: 'REG_EXPAND_SZ', value: 'C:\\a;' + dir + ';C:\\b' };
      const r = up.remove(dir);
      assert.strictEqual(r.changed, true);
      assert.strictEqual(r.reason, 'removed');
      assert.strictEqual(store.Path.value, 'C:\\a;C:\\b', '只应删掉目标目录，其余原样保留');
      // 幂等：再删一次什么都不做
      const again = up.remove(dir);
      assert.strictEqual(again.changed, false);
      assert.strictEqual(again.reason, 'absent');
      // 大小写与末尾斜杠视为同一项
      store.Path = { type: 'REG_EXPAND_SZ', value: dir.toUpperCase() + '\\' };
      const r2 = up.remove(dir);
      assert.strictEqual(r2.changed, true);
      assert.strictEqual(r2.reason, 'removed');
    }, ['../src/userpath']);
  });

  await t('uninstall 汇总文案与数据清理', () => {
    const u = require('../src/uninstall');
    const target = path.join(TMP, 'purge-me');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'a.txt'), 'x');
    const r = u.purgeRuntime(target);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(fs.existsSync(target), false, '数据目录应被删除');
    const missing = u.purgeRuntime(path.join(TMP, 'never-existed'));
    assert.strictEqual(missing.ok, true);
    assert.strictEqual(missing.skipped, true);

    const out = {
      ok: true, mode: 'bundle', runtimeDir: target,
      proxy: { changed: true, reason: 'stale-proxy', mode: 'restored' },
      kernelStopped: true,
      pathEntry: { removed: true },
      program: { removed: true },
      dataPurged: true, notes: [],
    };
    const text = u.summary(out).join('\n');
    assert.ok(text.includes('卸载完成'), text);
    assert.ok(text.includes('已删除'), text);
    const foreign = u.summary(Object.assign({}, out, {
      proxy: { changed: false, reason: 'foreign-proxy' },
      pathEntry: { removed: false },
      program: { removed: false, reason: 'source-mode' },
      notes: ['提示信息'],
    })).join('\n');
    assert.ok(foreign.includes('未改动'), foreign);
    assert.ok(foreign.includes('源码目录未删除'), foreign);
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

  await t('fix 断网自救：悬空代理 / 精确恢复 / 外来代理保护', () => {
    const p = paths.createPaths(path.join(TMP, 'fix'));
    paths.ensureDirs(p);
    const cfg = config.load(p);
    const ctx = { p, cfg, logger, migration: { instanceId: 'fix-test' } };
    const ours = config.proxyServer(cfg);
    const store = {};
    const reset = (obj) => {
      for (const k of Object.keys(store)) delete store[k];
      Object.assign(store, obj);
    };
    const backupRec = {
      instanceId: 'fix-test',
      keys: {
        ProxyEnable: { exists: true, type: 'REG_DWORD', value: '0x0' },
        ProxyServer: { exists: false, value: null, type: null },
        ProxyOverride: { exists: false, value: null, type: null },
      },
    };
    const stale = {
      ProxyEnable: { type: 'REG_DWORD', value: '0x1' },
      ProxyServer: { type: 'REG_SZ', value: ours },
      ProxyOverride: { type: 'REG_SZ', value: cfg.proxy.override },
    };

    withRegistry(store, (px) => {
      assert.strictEqual(px.isStale({ enabled: true, server: ours }, cfg, false), true);
      assert.strictEqual(px.isStale({ enabled: true, server: ours }, cfg, true), false);
      assert.strictEqual(px.isStale({ enabled: false, server: ours }, cfg, false), false);
      assert.strictEqual(px.isOurServer('http=' + ours + ';https=' + ours, cfg), true);
      assert.strictEqual(px.isOurServer('10.0.0.1:8080', cfg), false);

      // A 悬空代理 + 本实例备份 -> 精确恢复，备份清理
      reset(stale);
      fs.writeFileSync(p.proxyBackup, JSON.stringify(backupRec));
      const r1 = px.repair(ctx, false);
      assert.strictEqual(r1.changed, true);
      assert.strictEqual(r1.mode, 'restored');
      assert.strictEqual(px.current().enabled, false);
      assert.strictEqual(px.current().server, null);
      assert.strictEqual(fs.existsSync(p.proxyBackup), false, '备份应被清理');

      // B 悬空代理 + 无备份 -> 只清理 metactl 写入的值
      reset(stale);
      try { fs.rmSync(p.proxyBackup, { force: true }); } catch (_) { /* ignore */ }
      const r2 = px.repair(ctx, false);
      assert.strictEqual(r2.changed, true);
      assert.strictEqual(r2.mode, 'cleared');
      assert.strictEqual(px.current().enabled, false);
      assert.strictEqual(px.current().server, null);
      assert.strictEqual(px.current().override, null);

      // C 已关闭 -> 幂等 no-op
      reset({ ProxyEnable: { type: 'REG_DWORD', value: '0x0' } });
      const r3 = px.repair(ctx, false);
      assert.strictEqual(r3.changed, false);
      assert.strictEqual(r3.reason, 'already-off');

      // D 外来代理 + 无备份 + 无 force -> 完全不动
      reset({
        ProxyEnable: { type: 'REG_DWORD', value: '0x1' },
        ProxyServer: { type: 'REG_SZ', value: '10.0.0.1:8080' },
      });
      const r4 = px.repair(ctx, false);
      assert.strictEqual(r4.changed, false);
      assert.strictEqual(r4.reason, 'foreign-proxy');
      assert.strictEqual(px.current().enabled, true);
      assert.strictEqual(px.current().server, '10.0.0.1:8080');

      // E 外来代理 + force -> 只关闭，仍保留原 ProxyServer
      const r5 = px.repair(ctx, true);
      assert.strictEqual(r5.changed, true);
      assert.strictEqual(r5.mode, 'disabled');
      assert.strictEqual(px.current().enabled, false);
      assert.strictEqual(px.current().server, '10.0.0.1:8080', 'force 也应保留原 ProxyServer');
    });
  });

  await t('speed 全量测速：按节点测 / 排序 / 超时分类', async () => {
    const calls = [];
    const proxies = {
      GLOBAL: { type: 'Selector', all: ['节点A', '节点B', '节点C'] },
      '影视组': { type: 'Selector', all: ['节点A', '节点B'] },
      'AI组': { type: 'Selector', all: ['节点C'] },
      节点A: { type: 'Vmess' }, 节点B: { type: 'Trojan' }, 节点C: { type: 'Shadowsocks' },
    };
    const delays = { 节点A: 120, 节点B: 40, 节点C: 0 };
    const ctx = {
      cfg: config.load(paths.createPaths(TMP)),
      p: { configYaml: path.join(TMP, 'nonexistent-config.yaml') },
      logger: quietLogger,
    };
    await withFakeProcess({
      status: () => ({ running: true, pid: 1 }),
      controllerRequest: async (c, apiPath) => {
        calls.push(apiPath);
        if (apiPath === '/proxies') return { status: 200, data: { proxies } };
        const m = /^\/proxies\/([^/]+)\/delay/.exec(apiPath);
        if (m) return { status: 200, data: { delay: delays[decodeURIComponent(m[1])] } };
        return { status: 200, data: {} };
      },
    }, async (speed) => {
      const out = await speed.run(ctx, [], { group: [] });
      const nodeCalls = calls.filter((c) => c.includes('/delay'));
      assert.strictEqual(nodeCalls.length, 3, '按节点逐个测，3 个节点各一次');
      assert.ok(nodeCalls.every((c) => c.includes('timeout=10000')), '默认超时应为 10000');
      assert.ok(nodeCalls.every((c) => c.includes('cp.cloudflare.com')), '无健康检查地址时用兜底地址');
      assert.strictEqual(out.timeout, 10000);
      assert.strictEqual(out.stats.total, 3);
      assert.strictEqual(out.stats.ok, 2, '延迟为 0 视为超时');
      assert.strictEqual(out.stats.timeout, 1);
      assert.deepStrictEqual(out.results.map((r) => r.name), ['节点B', '节点A']);
      assert.deepStrictEqual(out.results.map((r) => r.delay), [40, 120]);
      assert.deepStrictEqual(out.failures, ['节点C']);
    });
  });

  await t('speed 多组覆盖 / --group 过滤 / 未运行拒绝', async () => {
    const proxies = {
      G1: { type: 'Selector', all: ['A', 'B'] },
      G2: { type: 'Selector', all: ['B', 'C'] },
    };
    const delays = { A: 100, B: 50, C: 200 };
    const ctx = {
      cfg: config.load(paths.createPaths(TMP)),
      p: { configYaml: path.join(TMP, 'nonexistent-config.yaml') },
      logger: quietLogger,
    };
    const calls = [];
    const fake = {
      status: () => ({ running: true, pid: 1 }),
      controllerRequest: async (c, apiPath) => {
        calls.push(apiPath);
        if (apiPath === '/proxies') return { status: 200, data: { proxies } };
        const m = /^\/proxies\/([^/]+)\/delay/.exec(apiPath);
        if (m) return { status: 200, data: { delay: delays[decodeURIComponent(m[1])] } };
        return { status: 200, data: {} };
      },
    };
    await withFakeProcess(fake, async (speed) => {
      const out = await speed.run(ctx, [], { group: [] });
      assert.strictEqual(out.testedGroups.length, 2, '两个组才能覆盖 A/B/C');
      assert.deepStrictEqual(out.results.map((r) => [r.name, r.delay]),
        [['B', 50], ['A', 100], ['C', 200]], '全量节点按延迟排序');
    });

    calls.length = 0;
    await withFakeProcess(fake, async (speed) => {
      const out = await speed.run(ctx, [], { group: ['G2'] });
      assert.strictEqual(out.stats.total, 2);
      assert.deepStrictEqual(out.results.map((r) => [r.name, r.delay]), [['B', 50], ['C', 200]]);
      const nodeCalls = calls.filter((c) => c.includes('/delay'));
      assert.ok(nodeCalls.every((c) => /\/proxies\/(B|C)\/delay/.test(c)), '只应测指定组的节点');
      await assert.rejects(() => speed.run(ctx, [], { group: ['不存在的组'] }),
        (e) => e && e.code === 'E_SPEED_BAD_GROUP');
    });

    await withFakeProcess({
      status: () => ({ running: false, reason: 'no-pid' }),
      controllerRequest: async () => null,
    }, async (speed) => {
      await assert.rejects(() => speed.run(ctx, [], { group: [] }),
        (e) => e && e.code === 'E_SPEED_NO_KERNEL');
    });
  });

  await t('安装阶段：全局 / 本地 PATH 决策与数据目录一致', () => {
    const pi = require('../scripts/postinstall');
    const saved = { g: process.env.npm_config_global, p: process.env.npm_config_prefix };
    try {
      process.env.npm_config_global = 'true';
      process.env.npm_config_prefix = path.join(TMP, 'npm-global');
      assert.strictEqual(pi.launcherDir(), path.join(TMP, 'npm-global'),
        '全局安装应把 npm prefix 加入 PATH');
      assert.strictEqual(paths.isGlobalNpm(path.join(TMP, 'npm-global', 'node_modules', 'metactl')), true);
      assert.strictEqual(paths.isGlobalNpm(TMP), false);
      // postinstall 与 CLI 运行时必须解析到同一数据目录
      assert.strictEqual(
        paths.defaultDataRoot(path.join(TMP, 'npm-global', 'node_modules', 'metactl')),
        paths.globalDataRoot()
      );
      process.env.npm_config_global = 'false';
      assert.strictEqual(pi.launcherDir(), ROOT, '本地安装应把项目根加入 PATH');
    } finally {
      if (saved.g === undefined) delete process.env.npm_config_global;
      else process.env.npm_config_global = saved.g;
      if (saved.p === undefined) delete process.env.npm_config_prefix;
      else process.env.npm_config_prefix = saved.p;
    }
  });

  await t('用户 PATH：reg.exe 被拦时自动切 .NET 通道', () => {
    const sysPath = require.resolve('../src/system');
    const upPath = require.resolve('../src/userpath');
    const realSys = require('../src/system');
    const dir = path.join(TMP, 'bin 目录');
    let rec = null; // { type, value }
    // 模拟：reg.exe 调用直接抛出被拦截错误，PowerShell 走内存注册表
    const runSync = (name, args) => {
      if (name === 'reg.exe') {
        throw new errors.AppError('E_REGISTRY_DENIED', 'blocked', 'hint');
      }
      if (name !== 'powershell.exe') return { code: 0, stdout: '', stderr: '' };
      const enc = args[args.indexOf('-EncodedCommand') + 1];
      const script = Buffer.from(enc, 'base64').toString('utf16le');
      if (script.includes('B64=')) {
        if (!rec) return { code: 0, stdout: 'EXISTS=0\r\nTYPE=REG_EXPAND_SZ\r\nB64=\r\n', stderr: '' };
        const b64 = Buffer.from(rec.value, 'utf8').toString('base64');
        return { code: 0, stdout: 'EXISTS=1\r\nTYPE=' + rec.type + '\r\nB64=' + b64 + '\r\n', stderr: '' };
      }
      if (script.includes('FromBase64String')) {
        const m = /FromBase64String\('([^']+)'\)/.exec(script);
        const value = Buffer.from(m[1], 'base64').toString('utf8');
        const type = script.includes('RegistryValueKind]::String') ? 'REG_SZ' : 'REG_EXPAND_SZ';
        rec = { type, value };
        return { code: 0, stdout: 'OK\r\n', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' }; // 广播通知
    };
    require.cache[sysPath] = {
      id: sysPath, filename: sysPath, loaded: true,
      exports: Object.assign({}, realSys, { runSync }),
    };
    delete require.cache[upPath];
    try {
      const up = require('../src/userpath');
      const a = up.ensure(dir);
      assert.strictEqual(a.changed, true, '应通过 .NET 通道写入');
      assert.strictEqual(a.via, 'dotnet');
      assert.strictEqual(rec.value, dir);
      const b = up.ensure(dir);
      assert.strictEqual(b.changed, false, '重复执行应幂等');
      assert.strictEqual(b.reason, 'already-present');
      // 保留既有值与类型
      rec = { type: 'REG_SZ', value: '%USERPROFILE%\\bin' };
      const c = up.ensure(dir);
      assert.strictEqual(c.type, 'REG_SZ');
      assert.strictEqual(rec.value, '%USERPROFILE%\\bin;' + dir);
    } finally {
      delete require.cache[sysPath];
      delete require.cache[upPath];
    }
  });

  await t('init 用户 PATH：创建 / 幂等 / 保留原值类型', () => {
    const dir = path.join(TMP, '项目 目录');
    const store = {};
    withRegistry(store, () => {
      const up = require('../src/userpath');
      const reset = (type, value) => {
        for (const k of Object.keys(store)) delete store[k];
        if (type) store.Path = { type, value };
      };

      // A 用户 PATH 不存在 -> 创建
      reset(null);
      let r = up.ensure(dir);
      assert.strictEqual(r.changed, true);
      assert.strictEqual(r.reason, 'added');
      assert.strictEqual(store.Path.value, dir);
      assert.strictEqual(store.Path.type, 'REG_EXPAND_SZ');
      assert.strictEqual(r.notified, true, '应广播环境变更');

      // B 重复执行 -> 幂等，不重复追加
      const once = store.Path.value;
      r = up.ensure(dir);
      assert.strictEqual(r.changed, false);
      assert.strictEqual(r.reason, 'already-present');
      assert.strictEqual(store.Path.value, once);

      // C 已有其它项且为 REG_SZ -> 追加并保留原值与类型
      reset('REG_SZ', '%USERPROFILE%\\bin;%APPDATA%\\npm;');
      r = up.ensure(dir);
      assert.strictEqual(r.changed, true);
      assert.strictEqual(r.type, 'REG_SZ', '应保持原有值类型');
      assert.ok(store.Path.value.startsWith('%USERPROFILE%\\bin;%APPDATA%\\npm;'));
      assert.ok(store.Path.value.endsWith(';' + dir));

      // D 判定大小写 / 末尾斜杠 / 引号，以及值拼接
      assert.strictEqual(up.hasDir(dir.toUpperCase() + '\\', dir), true);
      assert.strictEqual(up.hasDir('"' + dir + '"', dir), true);
      assert.strictEqual(up.hasDir(path.join(TMP, 'other'), dir), false);
      assert.strictEqual(up.buildValue('a;b;', dir), 'a;b;' + dir);
      assert.strictEqual(up.buildValue('', dir), dir);
    }, ['../src/userpath']);
  });

  await t('speed 测速参数对齐', () => {
    const s = require('../src/commands/speed');
    assert.strictEqual(s.DEFAULT_TIMEOUT, 10000, '默认超时应为 10000 ms');
    assert.strictEqual(s.FALLBACK_URL, 'http://cp.cloudflare.com/generate_204');
    assert.strictEqual(s.classifyDelay(120, 10000), 'measured');
    assert.strictEqual(s.classifyDelay(0, 10000), 'timeout');
    assert.strictEqual(s.classifyDelay(10000, 10000), 'timeout');
    assert.strictEqual(s.classifyDelay(1e6, 10000), 'error');
    const urls = { 'auto': 'http://www.gstatic.com/generate_204' };
    assert.strictEqual(s.resolveUrl({}, urls, ['auto']), 'http://www.gstatic.com/generate_204');
    assert.strictEqual(s.resolveUrl({ url: 'https://example.com/204' }, urls, ['auto']), 'https://example.com/204');
    assert.strictEqual(s.resolveUrl({}, {}, []), s.FALLBACK_URL);
    const proxies = { GLOBAL: { all: ['A', 'DIRECT'] }, A: { type: 'vmess' }, DIRECT: {} };
    const picked = s.pickGroups(s.collectGroups(proxies), []);
    assert.deepStrictEqual(s.leafNodes(proxies, picked.universe), ['A']);
  });

  await t('route 路线数据组装', () => {
    const r = require('../src/commands/route');
    const program = require('../src/cli').build();
    assert.ok(program.commands.map((c) => c.name()).includes('route'), '缺少 route 命令');
    const groups = r.groupRows({
      GLOBAL: { type: 'Selector', now: 'DIRECT', all: ['A', 'DIRECT'] },
      A: { type: 'vmess', history: [] },
    });
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].now, 'DIRECT');
    const conns = r.connectionRows([{
      metadata: { host: 'x.example', destinationPort: 443 },
      rule: 'DOMAIN', rulePayload: 'x.example', chains: ['group', 'node'],
    }], 20);
    assert.strictEqual(conns.total, 1);
    assert.strictEqual(conns.shown[0].chains[1], 'node');
    assert.strictEqual(r.pointsToMetactl({ enabled: true, server: '127.0.0.1:17890' }, { ports: { mixedPort: 17890 } }), true);
    assert.strictEqual(r.pointsToMetactl({ enabled: true, server: '127.0.0.1:7892' }, { ports: { mixedPort: 17890 } }), false);
    assert.strictEqual(r.pointsToMetactl({ enabled: false, server: '127.0.0.1:17890' }, { ports: { mixedPort: 17890 } }), false);
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
