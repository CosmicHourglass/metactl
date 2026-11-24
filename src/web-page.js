'use strict';

// 网页操作端的页面。单独放一个文件，避免服务端逻辑里塞一大坨 HTML。
// 纯内联：不引外部字体 / CDN，断网也能用。
// 注意不要出现盘符路径、其它客户端名、写死的端口与版本号字面量（禁词扫描会拦）。

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>metactl 控制台</title>
<style>
:root{
  --bg:#0f1115; --panel:#171a21; --panel2:#1e222b; --line:#2a2f3a;
  --fg:#e6e9ef; --dim:#98a1b3; --accent:#4f8cff; --ok:#3fb950; --warn:#d29922; --bad:#f85149;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
  font:14px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
header{display:flex;align-items:center;gap:12px;padding:14px 20px;
  border-bottom:1px solid var(--line);background:var(--panel)}
h1{font-size:16px;margin:0;font-weight:600;letter-spacing:.5px}
h2{font-size:13px;margin:22px 0 10px;color:var(--dim);font-weight:600;
  text-transform:none;letter-spacing:.5px}
main{max-width:980px;margin:0 auto;padding:20px}
.pill{margin-left:auto;font-size:12px;padding:4px 12px;border-radius:999px;
  background:var(--panel2);color:var(--dim);border:1px solid var(--line)}
.pill.on{color:var(--ok);border-color:#1d4429}
.pill.off{color:var(--bad);border-color:#4d2020}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.card .k{font-size:12px;color:var(--dim)}
.card .v{font-size:16px;margin-top:6px;word-break:break-all}
.card .v.good{color:var(--ok)} .card .v.bad{color:var(--bad)}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0 4px}
button{font:inherit;padding:8px 16px;border-radius:8px;border:1px solid var(--line);
  background:var(--panel2);color:var(--fg);cursor:pointer}
button:hover{border-color:#3a4250}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
button.primary:hover{filter:brightness(1.08)}
button:disabled{opacity:.5;cursor:not-allowed}
.groups{display:grid;gap:12px}
.g{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.g .head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.g .name{font-weight:600}
.g .type{font-size:11px;color:var(--dim);border:1px solid var(--line);
  border-radius:4px;padding:1px 6px}
.g .now{font-size:12px;color:var(--dim);margin-left:auto}
.g .now b{color:var(--accent);font-weight:600}
.g .row{display:flex;gap:10px;margin-top:12px}
select{flex:1;font:inherit;padding:7px 10px;border-radius:8px;
  border:1px solid var(--line);background:#11141a;color:var(--fg);min-width:0}
.tip{font-size:12px;color:var(--dim);margin-top:8px}
#toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);
  background:var(--panel2);border:1px solid var(--line);border-radius:8px;
  padding:10px 18px;opacity:0;transition:opacity .2s;pointer-events:none;max-width:90vw}
#toast.show{opacity:1}
#toast.err{border-color:#4d2020;color:#ffb4ae}
#toast.ok{border-color:#1d4429;color:#7ee787}
.banner{display:none;background:#3a1d1d;border:1px solid #4d2020;color:#ffb4ae;
  border-radius:8px;padding:12px 16px;margin-bottom:16px;font-size:13px}
.banner code{background:#000;padding:1px 5px;border-radius:4px;color:#ffb4ae}
</style>
</head>
<body>
<header>
  <h1>metactl 控制台</h1>
  <span id="pill" class="pill">读取中…</span>
</header>
<main>
  <div class="banner" id="banner">
    缺少访问令牌，所有操作都无法执行。请用 <code>metactl web</code> 输出的完整地址
    （末尾带 <code>?token=…</code>）打开本页；本页会记住令牌，刷新后仍可使用。
  </div>

  <section class="grid">
    <div class="card"><div class="k">内核</div><div class="v" id="v-kernel">-</div></div>
    <div class="card"><div class="k">系统代理</div><div class="v" id="v-proxy">-</div></div>
    <div class="card"><div class="k">分流模式</div><div class="v" id="v-mode">-</div></div>
    <div class="card"><div class="k">代理端口</div><div class="v" id="v-port">-</div></div>
  </section>

  <section class="actions">
    <button id="b-connect" class="primary">一键连接</button>
    <button id="b-disconnect">一键断开</button>
    <button id="b-start">启动内核</button>
    <button id="b-stop">停止内核</button>
    <button id="b-refresh">刷新</button>
  </section>

  <h2>策略组</h2>
  <section class="groups" id="groups"></section>
  <p class="tip" id="tip"></p>
</main>
<div id="toast"></div>
<script>
(function(){
  var TOKEN = '';
  try{
    var q = new URLSearchParams(location.search).get('token');
    TOKEN = q || sessionStorage.getItem('metactl_token') || '';
    if (TOKEN) sessionStorage.setItem('metactl_token', TOKEN);
  }catch(e){ TOKEN = ''; }

  // 没有令牌就明说，别让用户点了按钮才发现什么都没发生
  function needToken(){
    if (TOKEN) return true;
    document.getElementById('banner').style.display = 'block';
    var pill = document.getElementById('pill');
    pill.textContent = '缺少令牌';
    pill.className = 'pill off';
    var bs = document.querySelectorAll('button');
    for (var i = 0; i < bs.length; i++) bs[i].disabled = true;
    return false;
  }

  function api(path, body){
    var opt = { headers: { 'x-metactl-token': TOKEN } };
    if (body !== undefined){
      opt.method = 'POST';
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    return fetch(path, opt).then(function(r){ return r.json(); });
  }

  var toastTimer = null;
  function toast(msg, kind){
    var el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'show' + (kind ? ' ' + kind : '');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ el.className = ''; }, 3200);
  }

  function el(tag, cls, text){
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  function setText(id, text, cls){
    var e = document.getElementById(id);
    e.textContent = text;
    e.className = cls ? 'v ' + cls : 'v';
  }

  function renderGroups(groups){
    var box = document.getElementById('groups');
    box.textContent = '';
    if (!groups || !groups.length){
      box.appendChild(el('div', 'tip', '内核未运行，启动后这里会列出可切换的策略组。'));
      return;
    }
    groups.forEach(function(g){
      var card = el('div', 'g');
      var head = el('div', 'head');
      head.appendChild(el('span', 'name', g.name));
      head.appendChild(el('span', 'type', g.type));
      var now = el('span', 'now');
      now.appendChild(document.createTextNode('当前 '));
      now.appendChild(el('b', null, g.now || '(未选中)'));
      head.appendChild(now);
      card.appendChild(head);

      if (!g.switchable){
        card.appendChild(el('div', 'tip', '该组由内核自动挑选（延迟测速 / 故障转移），不能手动切换。'));
      } else {
        var row = el('div', 'row');
        var sel = document.createElement('select');
        (g.candidates || []).forEach(function(n){
          var o = document.createElement('option');
          o.value = n; o.textContent = n;
          if (n === g.now) o.selected = true;
          sel.appendChild(o);
        });
        var btn = el('button', null, '切换');
        btn.onclick = function(){
          btn.disabled = true;
          api('/api/select', { group: g.name, node: sel.value }).then(function(r){
            btn.disabled = false;
            if (r && r.ok){ toast(g.name + ' → ' + sel.value, 'ok'); refresh(); }
            else toast((r && r.error && r.error.message) || '切换失败', 'err');
          }).catch(function(e){ btn.disabled = false; toast(String(e), 'err'); });
        };
        row.appendChild(sel);
        row.appendChild(btn);
        card.appendChild(row);
      }
      box.appendChild(card);
    });
  }

  function refresh(){
    if (!needToken()) return Promise.resolve();
    return api('/api/status').then(function(s){
      if (!s || !s.ok){ toast((s && s.error && s.error.message) || '读取状态失败', 'err'); return; }
      var pill = document.getElementById('pill');
      var on = s.running && s.proxy && s.proxy.enabled;
      pill.textContent = on ? '已连接' : (s.running ? '内核运行中' : '未连接');
      pill.className = 'pill ' + (on ? 'on' : 'off');

      setText('v-kernel', s.running ? ('运行中 (PID ' + s.pid + ')' + (s.version ? ' · ' + s.version : '')) : '未运行',
        s.running ? 'good' : 'bad');
      setText('v-proxy', s.proxy && s.proxy.enabled ? ('已开启 → ' + s.proxy.server) : '未开启',
        s.proxy && s.proxy.enabled ? 'good' : '');
      setText('v-mode', s.mode || '-');
      setText('v-port', s.mixedPort || '-');
      renderGroups(s.groups);
      document.getElementById('tip').textContent =
        '切换只影响新建立的连接；已有的连接仍走原来的节点。';
    }).catch(function(e){ toast(String(e), 'err'); });
  }

  function action(path, body, label){
    if (!needToken()) return Promise.resolve();
    return api(path, body).then(function(r){
      if (r && r.ok){ toast(label + '成功', 'ok'); }
      else toast((r && r.error && (r.error.message + (r.error.hint ? '（' + r.error.hint + '）' : ''))) || label + '失败', 'err');
      refresh();
    }).catch(function(e){ toast(String(e), 'err'); });
  }

  document.getElementById('b-connect').onclick = function(){ action('/api/connect', {}, '连接'); };
  document.getElementById('b-disconnect').onclick = function(){ action('/api/disconnect', {}, '断开'); };
  document.getElementById('b-start').onclick = function(){ action('/api/start', {}, '启动内核'); };
  document.getElementById('b-stop').onclick = function(){ action('/api/stop', {}, '停止内核'); };
  document.getElementById('b-refresh').onclick = function(){ refresh(); };

  refresh();
  setInterval(refresh, 3000);
})();
</script>
</body>
</html>
`;

module.exports = { PAGE };
