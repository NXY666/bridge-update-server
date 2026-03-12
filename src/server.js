import express from 'express';
import {createServer} from 'node:http';
import {createRouter} from './router.js';
import {startGithubPolling} from './github.js';
import {discoverPeers, startMdns} from './mdns.js';

export async function startServer(options) {
	const {port, githubToken, svrOptions} = options;

	const app = express();
	const server = createServer(app);

	// 挂载路由
	const router = createRouter(discoverPeers, svrOptions, port);
	app.use(router);

	// 启动GitHub轮询
	await startGithubPolling(githubToken);

	// 启动HTTP服务
	server.listen(port, () => {
		console.log('[Server]', '服务已启动', 'port=', port);
	});

	// 启动mDNS广播
	await startMdns(port, svrOptions);

	return server;
}
