'use strict';

// 纯本地单元测试：不联网、不启动内核、不改注册表。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const nodeHttp = require('http');
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
async function withFakeProcess(fakeExports, fn, modulePaths) {
  const procPath = require.resolve('../src/process');
  const targets = (modulePaths || ['../src/commands/speed']).map((m) => require.resolve(m));
  const realProc = require('../src/process');
  require.cache[procPath] = {
    id: procPath, filename: procPath, loaded: true,
    exports: Object.assign({}, realProc, fakeExports),
  };
  for (const t of targets) delete require.cache[t];
  try { return await fn(require(targets[0])); }
  finally {
    delete require.cache[procPath];
    for (const t of targets) delete require.cache[t];
  }
}

// 依赖 process / proxy 的模块清单。
// 这两个模块在文件顶层就被 require，换掉它们之后必须把这些模块重新加载，
// 否则它们手里还握着旧引用，mock 不会生效。
const PROC_DEPENDENTS = [
  '../src/nodes', '../src/lifecycle', '../src/web',
  '../src/commands/select', '../src/commands/connect', '../src/commands/disconnect',
  '../src/commands/web', '../src/commands/start', '../src/commands/restart',
];

// 替换若干模块的导出后跑一段逻辑，结束后全部还原。
async function withModules(mocks, reload, fn) {
  const replaced = [];
  for (const [mod, exports] of Object.entries(mocks)) {
    const p = require.resolve(mod);
    const real = require(mod);
    replaced.push(p);
    require.cache[p] = {
      id: p, filename: p, loaded: true,
      exports: Object.assign({}, real, exports),
    };
  }
  const targets = (reload || []).map((m) => require.resolve(m));
  for (const t of targets) delete require.cache[t];
  try { return await fn(); }
  finally {
    for (const t of targets) delete require.cache[t];
    for (const p of replaced) delete require.cache[p];
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
      'nodes', 'lifecycle', 'web', 'web-page',
    ]) require('../src/' + m);    for (const c of ['init', 'kernel', 'fix', 'speed', 'route', 'select', 'connect',
      'disconnect', 'web', 'start', 'stop', 'restart', 'status', 'test', 'version',
      'proxy', 'uninstall']) {
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
    assert.ok(p.mihomoExe.endsWith('mihomo-metactl.exe'));
    assert.ok(p.mihomoNew.endsWith('mihomo-metactl.exe.new'));
  });

  await t('内核改名：映像名认新旧两个', () => {
    assert.strictEqual(constants.PROCESS.imageName, 'mihomo-metactl.exe');
    assert.ok(constants.PROCESS.legacyImageNames.includes('mihomo.exe'),
      '0.2.x 的旧内核名也要认，否则升级后老进程会成孤儿');
  });

  await t('stage-kernel：暂存内核并算出 exe 指纹', () => {
    const stageKernel = require('../scripts/stage-kernel');
    const root = path.join(TMP, 'stage');
    const binDir = path.join(root, '.runtime', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const exe = path.join(binDir, 'mihomo-metactl.exe');
    fs.writeFileSync(exe, 'fake kernel binary');
    fs.writeFileSync(path.join(binDir, 'kernel.json'),
      JSON.stringify({ tag: 'v-test', arch: 'x64', compatible: false }));
    const r = stageKernel.stage({ root });
    assert.ok(r.exe.endsWith(path.join('assets', 'mihomo-metactl.exe')));
    assert.ok(r.meta.endsWith(path.join('assets', 'kernel.json')));
    const meta = JSON.parse(fs.readFileSync(r.meta, 'utf8'));
    assert.strictEqual(meta.tag, 'v-test');
    assert.strictEqual(meta.exeName, 'mihomo-metactl.exe');
    assert.strictEqual(meta.exeSha256, stageKernel.sha256File(exe));
    assert.strictEqual(meta.exeBytes, fs.statSync(exe).size);
    // 找不到内核时必须明确报错，不能静默产出一个空包
    assert.throws(() => stageKernel.stage({ root: path.join(TMP, 'no-kernel-here') }),
      /找不到 mihomo 内核/);
  });

  await t('installBundled：校验后落盘并清理旧内核', async () => {
    const crypto = require('crypto');
    const root = path.join(TMP, 'bundled');
    const p = paths.createPaths(root);
    paths.ensureDirs(p);
    const src = path.join(TMP, 'bundled-src.exe');
    fs.writeFileSync(src, 'bundled kernel bytes');
    const sha = crypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex');
    const metaFile = path.join(TMP, 'bundled-meta.json');
    fs.writeFileSync(metaFile, JSON.stringify({ tag: 'v-bundled', exeSha256: sha }));
    // 旧版本留下的内核文件
    fs.writeFileSync(path.join(p.binDir, 'mihomo.exe'), 'old kernel');

    const ctx = { p, cfg: config.load(p), logger, migration: { instanceId: 'test' } };
    const info = await kernel.installBundled(ctx, src, metaFile);
    assert.strictEqual(info.installedFrom, 'bundle');
    assert.ok(fs.existsSync(p.mihomoExe), '内核应落到运行态目录');
    assert.strictEqual(fs.readFileSync(p.mihomoExe, 'utf8'), 'bundled kernel bytes');
    assert.strictEqual(fs.existsSync(path.join(p.binDir, 'mihomo.exe')), false,
      '旧内核文件应被清掉');
    const written = JSON.parse(fs.readFileSync(p.kernelJson, 'utf8'));
    assert.strictEqual(written.tag, 'v-bundled');
    assert.strictEqual(written.exeSha256, sha);

    // 被改过的内核必须拒绝落盘
    const bad = path.join(TMP, 'bundled-bad.exe');
    fs.writeFileSync(bad, 'tampered');
    await assert.rejects(
      () => kernel.installBundled(ctx, bad, metaFile),
      (e) => e && e.code === 'E_KERNEL_CHECKSUM'
    );
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

  await t('logger.raw 只写 stdout，不把令牌落进日志', () => {
    const p = paths.createPaths(path.join(TMP, 'logger-raw'));
    paths.ensureDirs(p);
    logger.init(p, {});
    const written = [];
    const realWrite = process.stdout.write;
    process.stdout.write = (s) => { written.push(String(s)); return true; };
    try {
      logger.raw('网页地址 http://127.0.0.1:1/?token=abc123');
    } finally {
      process.stdout.write = realWrite;
    }
    assert.ok(written.join('').includes('token=abc123'), '应当写到 stdout');
    const logText = fs.existsSync(p.logCli) ? fs.readFileSync(p.logCli, 'utf8') : '';
    assert.ok(!logText.includes('token=abc123'), '令牌不该进日志文件');
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

  await t('system 子进程 stderr 被收走，不外泄到终端', () => {
    // execFileSync 默认把子进程 stderr 继承给父进程，PowerShell 的进度信息
    // 会直接喷到终端上，把命令自己的输出糊掉
    const r = system.runSync('cmd.exe', ['/d', '/c', 'echo boom 1>&2']);
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.stderr.trim(), 'boom', 'stderr 应被捕获而不是继承');
    assert.strictEqual(r.stdout.trim(), '');
  });

  await t('proxy.on 静默模式：交给上层统一输出', async () => {
    const store = {};
    await withModules({
      '../src/process': { status: () => ({ running: true, pid: 1 }) },
    }, PROC_DEPENDENTS, async () => {
      withRegistry(store, (px) => {
        const p = paths.createPaths(path.join(TMP, 'proxy-silent'));
        paths.ensureDirs(p);
        const cfg = config.load(p);
        const out = [];
        const fakeLogger = {
          info: (m) => out.push(m), ok: (m) => out.push(m), warn: (m) => out.push(m),
          err: () => {}, debug: () => {}, json: () => {},
          maskText: (s) => s, maskUrl: (s) => s,
        };
        const ctx = { p, cfg, logger: fakeLogger, migration: { instanceId: 'silent-test' } };
        px.on(ctx);
        assert.strictEqual(out.filter((m) => /系统代理已开启/.test(m)).length, 1,
          '普通模式自己打印一次');
        out.length = 0;
        px.on(ctx, { silent: true });
        assert.strictEqual(out.filter((m) => /系统代理已开启/.test(m)).length, 0,
          '静默模式不打印，交给上层编排');
        assert.strictEqual(px.current().enabled, true);
      }, ['../src/proxy']);
    });
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
    for (const n of ['select', 'connect', 'disconnect', 'web']) {
      assert.ok(names.includes(n), '缺少命令 ' + n);
    }
    assert.ok(optNames('disconnect').includes('--force'), 'disconnect 缺少 --force');
    const webOpts = optNames('web');
    assert.ok(webOpts.includes('--port'), 'web 缺少 --port');
    assert.ok(webOpts.includes('--no-open'), 'web 缺少 --no-open');
  });

  await t('postinstall：优先用随包内核，没有才回落联网下载', async () => {
    const crypto = require('crypto');
    const pi = require('../scripts/postinstall');
    const root = path.join(TMP, 'npm-pkg');
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    const stubExe = path.join(root, 'assets', 'mihomo-metactl.exe');
    fs.writeFileSync(stubExe, 'stub kernel');
    const stubSha = crypto.createHash('sha256').update(fs.readFileSync(stubExe)).digest('hex');
    fs.writeFileSync(path.join(root, 'assets', 'kernel.json'),
      JSON.stringify({ tag: 'v-test', exeSha256: stubSha }));

    const found = pi.bundledKernel(root);
    assert.ok(found, '有 assets/ 时应找到随包内核');
    assert.ok(found.exe.endsWith(path.join('assets', 'mihomo-metactl.exe')));
    assert.ok(found.meta.endsWith(path.join('assets', 'kernel.json')));
    assert.strictEqual(pi.bundledKernel(path.join(TMP, 'no-assets-here')), null,
      '没有 assets/ 时应回落联网下载');

    // 走通 postinstall 的落盘路径：随包内核 -> 运行态
    const p = paths.createPaths(path.join(TMP, 'npm-runtime'));
    paths.ensureDirs(p);
    const ctx = { p, cfg: config.load(p), logger, migration: { instanceId: 'test' } };
    const info = await kernel.installBundled(ctx, found.exe, found.meta);
    assert.strictEqual(info.installedFrom, 'bundle');
    assert.ok(fs.existsSync(p.mihomoExe));
  });

  await t('kernel status 显示内核来源', () => {
    const p = paths.createPaths(path.join(TMP, 'kernel-status'));
    paths.ensureDirs(p);
    fs.writeFileSync(p.mihomoExe, 'stub');
    fs.writeFileSync(p.kernelJson, JSON.stringify({
      tag: 'v-test', arch: 'x64', installedFrom: 'bundle', exeSha256: 'a'.repeat(64),
    }));
    const d = require('../src/commands/kernel').describe({ p });
    assert.strictEqual(d.installed, true);
    assert.strictEqual(d.installedFrom, 'bundle');
    assert.ok(d.exeSha256.endsWith('...'));
  });

  await t('uninstall 安装方式判定与卸载计划', () => {
    const u = require('../src/uninstall');
    const program = require('../src/cli').build();
    assert.ok(program.commands.map((c) => c.name()).includes('uninstall'), '缺少 uninstall 命令');
    const uninstallOpts = program.commands.find((c) => c.name() === 'uninstall').options.map((o) => o.long);
    assert.deepStrictEqual(uninstallOpts.filter((o) => o !== '--home' && o !== '--json'
      && o !== '--quiet' && o !== '--verbose' && o !== '--help'), ['--purge'],
    'uninstall 只应保留 --purge 一个选项');

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
    assert.strictEqual(p.restoreProxy, true, '卸载前应恢复代理备份原值');
    assert.strictEqual(p.removeKernel, true, '内核默认不保留');
    assert.strictEqual(p.purgeData, false, '默认保留订阅快照与配置');
    assert.strictEqual(p.launcherDir, path.join(bundleRoot, 'bin'));

    p = u.plan(bundleCtx, { purge: true });
    assert.strictEqual(p.purgeData, true, '--purge 才删订阅快照与配置');

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
      proxy: { changed: true, restored: true, reason: 'restored', mode: 'restored' },
      kernelRemoved: true,
      pathEntry: { removed: true },
      program: { removed: true },
      dataPurged: true, notes: [],
    };
    const text = u.summary(out).join('\n');
    assert.ok(text.includes('卸载完成'), text);
    assert.ok(text.includes('已删除'), text);
    assert.ok(text.includes('恢复到开启前的原值'), text);
    const foreign = u.summary(Object.assign({}, out, {
      proxy: { changed: false, restored: false, reason: 'foreign-proxy' },
      pathEntry: { removed: false },
      program: { removed: false, reason: 'source-mode' },
      dataPurged: false,
      notes: ['提示信息'],
    })).join('\n');
    assert.ok(foreign.includes('未改动'), foreign);
    assert.ok(foreign.includes('源码目录未删除'), foreign);
    assert.ok(foreign.includes('订阅快照与配置: 保留在'), foreign);
  });

  await t('uninstall 程序目录：改名让位并由后台进程删除', async () => {
    const u = require('../src/uninstall');
    const dir = path.join(TMP, 'program-dir');
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'bin', 'app.exe'), 'stub');
    const r = u.removeProgramDir(dir);
    assert.strictEqual(r.removed, true);
    assert.strictEqual(r.renamed, true, '应先改名让位，而不是原地删除');
    assert.strictEqual(fs.existsSync(dir), false, '原目录应已消失');
    assert.ok(r.target.includes('.uninstalled-'), r.target);
    assert.strictEqual(r.scheduled, true, '应启动后台清理');
    // 后台进程在父进程退出后把改名的目录删掉
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && fs.existsSync(r.target)) {
      await new Promise((res) => setTimeout(res, 300));
    }
    assert.strictEqual(fs.existsSync(r.target), false, '后台进程应把残留目录删掉');
  });

  await t('uninstall 默认删内核、保留订阅快照与配置', async () => {
    const store = {};
    await withRegistry(store, async () => {
      const u = require('../src/uninstall');
      const home = path.join(TMP, 'keep-data-home');
      const p = paths.createPaths(home);
      paths.ensureDirs(p);
      fs.writeFileSync(p.mihomoExe, 'stub kernel');
      fs.writeFileSync(p.profileYaml, 'proxies: []');
      fs.writeFileSync(p.configYaml, 'mixed-port: 17890');
      const ctx = {
        programRoot: path.join(TMP, 'project'),
        root: home, p, cfg: config.load(p), logger, migration: { instanceId: 'test' },
      };
      const out = await u.run(ctx, {});
      assert.strictEqual(out.mode, 'source');
      assert.strictEqual(out.kernelRemoved, true, '内核默认应被删除');
      assert.strictEqual(fs.existsSync(p.mihomoExe), false, '内核 exe 应被删除');
      assert.strictEqual(out.dataPurged, false, '默认不删订阅快照与配置');
      assert.strictEqual(fs.existsSync(p.profileYaml), true, '订阅快照应保留');
      assert.strictEqual(fs.existsSync(p.configYaml), true, '配置应保留');
    }, ['../src/uninstall']);
  });

  await t('uninstall 内核在运行则拒绝并提示先关闭', async () => {
    const store = {};
    await withRegistry(store, async () => {
      // 伪造「内核正在运行」：真实 tasklist 会认出那不是 mihomo.exe
      const procPath = require.resolve('../src/process');
      const realProc = require('../src/process');
      require.cache[procPath] = {
        id: procPath, filename: procPath, loaded: true,
        exports: Object.assign({}, realProc, {
          status: () => ({ running: true, pid: 4242 }),
        }),
      };
      const u = require('../src/uninstall');
      const home = path.join(TMP, 'running-home');
      const p = paths.createPaths(home);
      paths.ensureDirs(p);
      fs.writeFileSync(p.mihomoExe, 'stub kernel');
      const ctx = {
        programRoot: path.join(TMP, 'project'),
        root: home, p, cfg: config.load(p), logger, migration: { instanceId: 'test' },
      };
      try {
        await assert.rejects(
          () => u.run(ctx, {}),
          (e) => e && e.code === 'E_KERNEL_RUNNING' && /metactl stop/.test(e.hint || '')
        );
        assert.strictEqual(fs.existsSync(p.mihomoExe), true, '拒绝卸载时不该动内核文件');
      } finally {
        delete require.cache[procPath];
      }
    }, ['../src/uninstall']);
  });

  await t('uninstall 清数据后不留残留（写日志不得重建目录）', async () => {
    const store = {};
    await withRegistry(store, async () => {
      const u = require('../src/uninstall');
      const home = path.join(TMP, 'purge-home');
      const p = paths.createPaths(home);
      paths.ensureDirs(p);
      fs.writeFileSync(p.logCli, 'old log\n');
      const ctx = {
        programRoot: path.join(TMP, 'project'),
        root: home,
        p,
        cfg: config.load(p),
        logger,
        migration: { instanceId: 'test' },
      };
      const out = await u.run(ctx, { purge: true });
      assert.strictEqual(out.mode, 'source');
      assert.strictEqual(out.dataPurged, true);
      assert.strictEqual(out.program.reason, 'source-mode', '源码目录不该被删除');
      assert.strictEqual(fs.existsSync(p.runtime), false,
        '运行态目录应被彻底删除：清理后再写日志会把它重建出来');
    }, ['../src/uninstall']);
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

  await t('select 切换线路：列组 / 列候选 / 切换并记住', async () => {
    const calls = [];
    const proxies = {
      '节点选择': { type: 'Selector', now: '自动选择', all: ['自动选择', '香港 1', '香港 2'] },
      '自动选择': { type: 'URLTest', now: '香港 1', all: ['香港 1', '香港 2'] },
      '香港 1': { type: 'Vmess' },
      '香港 2': { type: 'Vmess' },
    };
    const p = paths.createPaths(path.join(TMP, 'select'));
    paths.ensureDirs(p);
    const ctx = { p, cfg: config.load(p), logger: quietLogger, migration: { instanceId: 'x' } };
    const fakeProc = {
      status: () => ({ running: true, pid: 1 }),
      controllerRequest: async (c, apiPath) => {
        calls.push(['GET', apiPath]);
        if (apiPath === '/proxies') return { status: 200, data: { proxies } };
        const m = /^\/proxies\/([^/]+)$/.exec(apiPath);
        if (m) return { status: 200, data: { now: proxies[decodeURIComponent(m[1])].now } };
        return { status: 200, data: {} };
      },
      controllerPut: async (c, apiPath, body) => {
        calls.push(['PUT', apiPath, body]);
        const name = decodeURIComponent(apiPath.replace(/^\/proxies\//, ''));
        proxies[name].now = body.name;
        return { status: 204 };
      },
    };
    await withModules({ '../src/process': fakeProc }, PROC_DEPENDENTS, async () => {
      const select = require('../src/commands/select');
      const out1 = await select.run(ctx, [], {});
      assert.strictEqual(out1.groups.length, 2, '两个代理组');
      assert.strictEqual(out1.groups.filter((g) => g.switchable).length, 1, '只有 Selector 组可切');

      const out2 = await select.run(ctx, ['节点选择'], {});
      assert.deepStrictEqual(out2.group.candidates, ['自动选择', '香港 1', '香港 2']);

      const out3 = await select.run(ctx, ['节点选择', '香港 2'], {});
      assert.strictEqual(out3.selected.now, '香港 2');
      assert.strictEqual(out3.selected.confirmed, true);

      const puts = calls.filter((c) => c[0] === 'PUT');
      assert.strictEqual(puts.length, 1);
      assert.strictEqual(puts[0][1], '/proxies/' + encodeURIComponent('节点选择'));
      assert.deepStrictEqual(puts[0][2], { name: '香港 2' });

      // 选择不落盘：内核重启后回到订阅里的默认线路
      assert.strictEqual(fs.existsSync(path.join(p.stateDir, 'selection.json')), false,
        '切换不应留下任何持久化痕迹');
    });
  });

  await t('select 边界：组不存在 / 节点不在组里 / 组不可切 / 内核未运行', async () => {
    const proxies = {
      '主组': { type: 'Selector', now: 'A', all: ['A', 'B'] },
      '自动组': { type: 'URLTest', now: 'A', all: ['A', 'B'] },
    };
    const p = paths.createPaths(path.join(TMP, 'select-bad'));
    paths.ensureDirs(p);
    const ctx = { p, cfg: config.load(p), logger: quietLogger, migration: { instanceId: 'x' } };
    const fakeProc = {
      status: () => ({ running: true, pid: 1 }),
      controllerRequest: async (c, apiPath) => {
        if (apiPath === '/proxies') return { status: 200, data: { proxies } };
        return { status: 200, data: {} };
      },
      controllerPut: async () => ({ status: 204 }),
    };
    await withModules({ '../src/process': fakeProc }, PROC_DEPENDENTS, async () => {
      const select = require('../src/commands/select');
      await assert.rejects(() => select.run(ctx, ['没有这个组'], {}),
        (e) => e && e.code === 'E_SELECT_BAD_GROUP');
      await assert.rejects(() => select.run(ctx, ['主组', 'C'], {}),
        (e) => e && e.code === 'E_SELECT_BAD_NODE');
      await assert.rejects(() => select.run(ctx, ['自动组', 'B'], {}),
        (e) => e && e.code === 'E_SELECT_NOT_SWITCHABLE');
    });

    await withModules({
      '../src/process': { status: () => ({ running: false, reason: 'no-pid' }) },
    }, PROC_DEPENDENTS, async () => {
      const select = require('../src/commands/select');
      await assert.rejects(() => select.run(ctx, [], {}),
        (e) => e && e.code === 'E_SELECT_NO_KERNEL');
    });
  });

  await t('connect / disconnect：先内核后代理、先代理后内核', async () => {
    const p = paths.createPaths(path.join(TMP, 'connect'));
    paths.ensureDirs(p);
    fs.writeFileSync(p.mihomoExe, 'stub kernel');
    fs.writeFileSync(p.configYaml, 'mixed-port: 17890');
    const ctx = { p, cfg: config.load(p), logger: quietLogger, migration: { instanceId: 'x' } };
    const order = [];
    let running = false;
    const fakeProc = {
      status: () => ({ running, pid: 777 }),
      start: async () => { running = true; order.push('start'); return { pid: 777, startedAt: 'now', version: 'v-test' }; },
      stop: async () => { running = false; order.push('stop'); return { stopped: true, pid: 777 }; },
      controllerPut: async () => ({ status: 204 }),
    };
    const fakeProxy = {
      on: () => { order.push('proxy-on'); return { server: '127.0.0.1:17890', refreshed: true }; },
      repair: () => { order.push('proxy-off'); return { changed: true, mode: 'restored', reason: 'stale-proxy' }; },
      current: () => ({ enabled: true, server: '127.0.0.1:17890' }),
      isOurServer: (v, cfg) => String(v) === config.proxyServer(cfg),
    };
    await withModules({ '../src/process': fakeProc, '../src/proxy': fakeProxy }, PROC_DEPENDENTS, async () => {
      const connect = require('../src/commands/connect');
      const disconnect = require('../src/commands/disconnect');

      const r = await connect.run(ctx, [], {});
      assert.strictEqual(r.connected, true);
      assert.strictEqual(r.kernel.started, true);
      assert.deepStrictEqual(order, ['start', 'proxy-on'], '必须先起内核再开代理');

      // 内核已在跑时直接复用，不当成错误
      order.length = 0;
      const again = await connect.run(ctx, [], {});
      assert.strictEqual(again.kernel.reused, true);
      assert.deepStrictEqual(order, ['proxy-on'], '已在跑就不该再 start');

      order.length = 0;
      const d = await disconnect.run(ctx, [], {});
      assert.strictEqual(d.connected, false);
      assert.strictEqual(d.proxy.restored, true);
      assert.deepStrictEqual(order, ['proxy-off', 'stop'], '必须先关代理再停内核');
    });
  });

  await t('connect / disconnect 失败时不留下半吊子状态', async () => {
    const p = paths.createPaths(path.join(TMP, 'connect-fail'));
    paths.ensureDirs(p);
    fs.writeFileSync(p.mihomoExe, 'stub kernel');
    fs.writeFileSync(p.configYaml, 'mixed-port: 17890');
    const ctx = { p, cfg: config.load(p), logger: quietLogger, migration: { instanceId: 'x' } };
    const order = [];
    let running = false;
    const fakeProc = {
      status: () => ({ running, pid: 777 }),
      start: async () => { running = true; order.push('start'); return { pid: 777, startedAt: 'now', version: null }; },
      stop: async () => { running = false; order.push('stop'); return { stopped: true, pid: 777 }; },
      controllerPut: async () => ({ status: 204 }),
    };
    const badProxy = {
      on: () => { order.push('proxy-on'); throw new errors.AppError('E_PROXY_SET_FAILED', '写入失败', 'hint'); },
      repair: () => { order.push('proxy-off'); throw new errors.AppError('E_REG_FAILED', '写入失败', 'hint'); },
      current: () => ({ enabled: true, server: '127.0.0.1:17890' }),
      isOurServer: (v, cfg) => String(v) === config.proxyServer(cfg),
    };
    await withModules({ '../src/process': fakeProc, '../src/proxy': badProxy }, PROC_DEPENDENTS, async () => {
      const connect = require('../src/commands/connect');
      const disconnect = require('../src/commands/disconnect');

      // 代理没开成：把刚起的内核收回去
      await assert.rejects(() => connect.run(ctx, [], {}), (e) => e && e.code === 'E_PROXY_SET_FAILED');
      assert.ok(order.includes('stop'), '代理没开成就该把内核收回去');
      assert.strictEqual(running, false);

      // 代理没解除：内核保持运行，否则代理悬空会断网
      order.length = 0;
      running = true;
      await assert.rejects(() => disconnect.run(ctx, [], {}), (e) => e && e.code === 'E_REG_FAILED');
      assert.ok(!order.includes('stop'), '代理没解除就不该停内核');
      assert.strictEqual(running, true);
    });
  });

  await t('web：令牌校验、状态接口与切换接口', async () => {
    const p = paths.createPaths(path.join(TMP, 'web'));
    paths.ensureDirs(p);
    const ctx = { p, cfg: config.load(p), logger: quietLogger, migration: { instanceId: 'x' } };
    const proxies = { '主组': { type: 'Selector', now: 'A', all: ['A', 'B'] } };
    const fakeProc = {
      status: () => ({ running: true, pid: 1 }),
      controllerRequest: async (c, apiPath) => {
        if (apiPath === '/proxies') return { status: 200, data: { proxies } };
        if (apiPath === '/version') return { status: 200, data: { version: 'v-test' } };
        if (apiPath === '/configs') return { status: 200, data: { mode: 'rule' } };
        const m = /^\/proxies\/([^/]+)$/.exec(apiPath);
        if (m) return { status: 200, data: { now: proxies[decodeURIComponent(m[1])].now } };
        return { status: 200, data: {} };
      },
      controllerPut: async (c, apiPath, body) => {
        const name = decodeURIComponent(apiPath.replace(/^\/proxies\//, ''));
        proxies[name].now = body.name;
        return { status: 204 };
      },
    };
    const fakeProxy = { current: () => ({ enabled: true, server: '127.0.0.1:17890' }) };
    await withModules({ '../src/process': fakeProc, '../src/proxy': fakeProxy }, PROC_DEPENDENTS, async () => {
      const web = require('../src/web');
      const token = 'test-token-123';
      const server = nodeHttp.createServer(web.makeHandler(ctx, token));
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const port = server.address().port;
      const call = (method, path, obj, headers) => new Promise((resolve) => {
        const data = obj === undefined ? null : JSON.stringify(obj);
        const h = Object.assign({}, headers || {});
        if (data !== null) {
          h['Content-Type'] = 'application/json';
          h['Content-Length'] = Buffer.byteLength(data);
        }
        const req = nodeHttp.request({ host: '127.0.0.1', port, path, method, headers: h }, (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
        });
        req.on('error', () => resolve({ status: 0, body: '' }));
        if (data !== null) req.write(data);
        req.end();
      });
      const auth = { 'x-metactl-token': token };
      try {
        const page = await call('GET', '/');
        assert.strictEqual(page.status, 200);
        assert.ok(page.body.includes('metactl'), '应返回操作页面');

        // 没有令牌一律拒绝：防止本机上的网页越权调用
        const noToken = await call('GET', '/api/status');
        assert.strictEqual(noToken.status, 403);

        // 带 ?token= 打开页面会种下 Cookie，之后直接访问根路径也能用
        const withToken = await call('GET', '/?token=' + token);
        assert.strictEqual(withToken.status, 200);
        const cookie = String(withToken.headers['set-cookie'] || '');
        assert.ok(cookie.includes('metactl_token='), '应下发带令牌的 Cookie');
        const jar = cookie.split(';')[0];
        const viaCookie = await call('GET', '/api/status', undefined, { cookie: jar });
        assert.strictEqual(viaCookie.status, 200, 'Cookie 里的令牌应能通过校验');
        const stillNoToken = await call('GET', '/api/status');
        assert.strictEqual(stillNoToken.status, 403, '没有令牌仍然要拒绝');

        const st = await call('GET', '/api/status', undefined, auth);
        assert.strictEqual(st.status, 200);
        const sj = JSON.parse(st.body);
        assert.strictEqual(sj.ok, true);
        assert.strictEqual(sj.running, true);
        assert.strictEqual(sj.groups.length, 1);
        assert.deepStrictEqual(sj.groups[0].candidates, ['A', 'B']);

        const sel = await call('POST', '/api/select', { group: '主组', node: 'B' }, auth);
        const selj = JSON.parse(sel.body);
        assert.strictEqual(selj.ok, true);
        assert.strictEqual(selj.selected.now, 'B');

        const bad = await call('POST', '/api/select', {}, auth);
        const badj = JSON.parse(bad.body);
        assert.strictEqual(badj.ok, false);
        assert.strictEqual(badj.error.code, 'E_USAGE');
      } finally {
        server.close();
      }
    });
  });

  await t('web 端口被占用时报可读错误', async () => {
    const srv = net.createServer();
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const p = paths.createPaths(path.join(TMP, 'web-busy'));
    paths.ensureDirs(p);
    const ctx = { p, cfg: config.load(p), logger: quietLogger, migration: { instanceId: 'x' } };
    try {
      const web = require('../src/web');
      await assert.rejects(() => web.startServer(ctx, { port }),
        (e) => e && e.code === 'E_WEB_PORT_IN_USE');
    } finally {
      await new Promise((r) => srv.close(r));
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
