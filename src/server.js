import express from 'express';
import { createServer } from 'node:http';
import { createRouter } from './router.js';
import { startGithubPolling, onVersionChange } from './github.js';
import { downloadApk } from './cache.js';
import { startMdns, discoverPeers } from './mdns.js';

export async function startServer(options) {
  const { port, mdnsHost, mdnsPort, mdnsPath } = options;

  const app = express();
  const server = createServer(app);

  // 挂载路由
  const router = createRouter(mdnsPath, () => discoverPeers(mdnsPath));
  if (mdnsPath) {
    app.use(mdnsPath, router);
  } else {
    app.use(router);
  }

  // 版本更新时触发缓存下载
  onVersionChange(() => {
    downloadApk(() => discoverPeers(mdnsPath));
  });

  // 启动GitHub轮询
  await startGithubPolling();

  // 后台启动APK缓存下载
  downloadApk(() => discoverPeers(mdnsPath));

  // 启动HTTP服务
  server.listen(port, () => {
    console.log('[Server]', '服务已启动', 'port=', port);
  });

  // 启动mDNS广播
  await startMdns(port, mdnsHost, mdnsPort, mdnsPath);

  return server;
}
