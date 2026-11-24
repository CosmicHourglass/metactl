'use strict';

// 开启本地网页操作端：一条命令起一个只监听本机的小服务，
// 浏览器打开后就能看状态、切节点、连接与断开。

const web = require('../web');

async function run(ctx, args, opts) {
  const { logger } = ctx;
  const s = await web.startServer(ctx, { port: opts.port });
  logger.json({ url: s.url, port: s.port, host: s.host });
  // 地址里带令牌，不能落进日志文件
  logger.raw(`  OK  网页控制台已启动: ${s.url}`);
  logger.info('服务只监听本机回环地址；按 Ctrl+C 停止');

  if (opts.open !== false) {
    if (!web.openBrowser(s.url)) {
      logger.warn('没能自动打开浏览器，请手动访问上面的地址');
    }
  }

  // 阻塞到进程结束：Ctrl+C 时优雅关掉服务
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const shutdown = () => {
      logger.info('正在停止网页服务…');
      try { s.server.close(); } catch (_) { /* ignore */ }
      setTimeout(finish, 500).unref();
      s.server.closeAllConnections && s.server.closeAllConnections();
      finish();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    s.server.on('close', finish);
  });

  return { url: s.url, port: s.port, stopped: true };
}

module.exports = { run };
