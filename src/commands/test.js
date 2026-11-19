'use strict';

// 自检/验收命令：不联网、不启动进程，只校验当前 .runtime 是否完整可用。
const fs = require('fs');
const YAML = require('yaml');
const config = require('../config');
const validate = require('../validate');
const proc = require('../process');
const { fail } = require('../errors');

async function run(ctx) {
  const { p, cfg, logger } = ctx;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail: detail || '' });

  const hasExe = fs.existsSync(p.mihomoExe);
  add('内核文件', hasExe, hasExe ? p.mihomoExe : '缺少 mihomo.exe');
  const hasConfig = fs.existsSync(p.configYaml);
  add('生成配置', hasConfig, hasConfig ? p.configYaml : '缺少 config.yaml');
  const hasProfile = fs.existsSync(p.profileYaml);
  add('订阅快照', hasProfile, hasProfile ? p.profileYaml : '缺少 profile.yaml');

  let portsOk = false;
  let portsDetail = '';
  try { config.validatePorts(cfg); portsOk = true; }
  catch (e) { portsDetail = e.message; }
  add('端口配置', portsOk, portsOk ? '合法且互不重复' : portsDetail);

  const hasSecret = !!cfg.controllerSecret && cfg.controllerSecret.length >= 16;
  add('控制器密钥', hasSecret, hasSecret ? '已生成' : '缺失或过短');

  let doc = null;
  let yamlOk = false;
  let yamlDetail = '';
  if (hasConfig) {
    try {
      doc = YAML.parseDocument(fs.readFileSync(p.configYaml, 'utf8'),
        { uniqueKeys: false, logLevel: 'silent' });
      yamlOk = doc.errors.length === 0 && YAML.isMap(doc.contents);
      if (!yamlOk) yamlDetail = doc.errors.length ? doc.errors[0].message : '顶层不是映射';
    } catch (e) { yamlDetail = e.message; }
  } else { yamlDetail = '配置不存在'; }
  add('配置 YAML 语法', yamlOk, yamlOk ? '可解析' : yamlDetail);

  let obj = null;
  if (hasConfig) {
    try { obj = YAML.parse(fs.readFileSync(p.configYaml, 'utf8')); }
    catch (_) { obj = null; }
  }
  let keysOk = false;
  const keyIssues = [];
  if (doc && yamlOk) {
    const expect = {
      'mixed-port': cfg.ports.mixedPort,
      'socks-port': cfg.ports.socksPort,
      port: cfg.ports.port,
      'external-controller': cfg.ports.externalController,
      secret: cfg.controllerSecret,
    };
    for (const [k, v] of Object.entries(expect)) {
      if (String(doc.get(k)) !== String(v)) keyIssues.push(`${k} 不符`);
    }
    if (!obj || !obj.tun || obj.tun.enable !== false) keyIssues.push('tun.enable 未关闭');
    if (doc.get('external-controller-pipe') !== undefined) keyIssues.push('存在 external-controller-pipe');
    keysOk = keyIssues.length === 0;
  }
  add('顶层覆盖键', keysOk, keysOk ? '端口/控制器/secret/tun 均正确' : (keyIssues.join('; ') || '配置不可用'));

  let kernelTestOk = false;
  let kernelTestDetail = '已跳过（内核或配置缺失）';
  if (hasExe && hasConfig) {
    try { validate.validate(ctx, p.configYaml); kernelTestOk = true; kernelTestDetail = 'mihomo -t 通过'; }
    catch (e) { kernelTestDetail = e.message; }
  }
  add('内核 -t 校验', kernelTestOk, kernelTestDetail);

  const st = proc.status(ctx);
  let ctlOk = false;
  let ctlDetail = '内核未运行，跳过';
  if (st.running) {
    const r = await proc.controllerRequest(ctx, '/version', 1500);
    ctlOk = !!(r && r.status === 200);
    ctlDetail = ctlOk ? `可达 ${r.data && r.data.version ? r.data.version : ''}` : '不可达';
  }
  add('外部控制器', ctlOk || !st.running, ctlDetail);

  const failed = checks.filter((c) => !c.ok);
  const out = { ok: failed.length === 0, checks };
  logger.json(out);
  for (const c of checks) {
    const line = `${c.name}${c.detail ? ' - ' + c.detail : ''}`;
    if (c.ok) logger.ok(line);
    else logger.err(line);
  }
  if (failed.length) {
    fail('E_TEST_FAILED', `自检有 ${failed.length} 项未通过`,
      '配置问题请执行 metactl init；内核缺失请执行 npm install 或 metactl kernel install；详见 .runtime/logs/metactl.log');
  }
  logger.info('自检全部通过');
  return out;
}

module.exports = { run };
