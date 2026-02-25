import express from 'express';
import {createServer} from 'node:http';
import {createRouter} from './router.js';
import {onPollComplete, startGithubPolling} from './github.js';
import {syncApk} from './cache.js';
import {discoverPeers, startMdns} from './mdns.js';

export async function startServer(options) {
	const {port, mdnsHost, mdnsPort, mdnsPath} = options;

	const app = express();
	const server = createServer(app);

	// 挂载路由
	const router = createRouter(mdnsPath, discoverPeers);
	if (mdnsPath) {
		app.use(mdnsPath, router);
	} else {
		app.use(router);
	}

	// 每次轮询成功后同步APK
	onPollComplete(() => syncApk(discoverPeers));

	// 启动GitHub轮询
	await startGithubPolling();

	// 启动HTTP服务
	server.listen(port, () => {
		console.log('[Server]', '服务已启动', 'port=', port);
	});

	// 启动mDNS广播
	await startMdns(port, mdnsHost, mdnsPort, mdnsPath);

	return server;
}
