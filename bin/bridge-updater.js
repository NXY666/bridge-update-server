#!/usr/bin/env node

import {startServer} from '../src/server.js';

const args = process.argv.slice(2);

function getArg(name, defaultValue) {
	const idx = args.indexOf(name);
	if (idx === -1 || idx + 1 >= args.length) {
		return defaultValue;
	}
	return args[idx + 1];
}

if (args.includes('--help') || args.includes('-h')) {
	console.log([
		'',
		'bridge-updater - Bridge App Update Server',
		'',
		'用法: bridge-updater [options]',
		'',
		'选项:',
		'  --port <number>        HTTP 端口 (默认: 51145)',
		'  --svr-proto <string>   服务对外的协议 (如 https)',
		'  --svr-host <string>    服务对外的域名或IP',
		'  --svr-port <number>    服务对外的端口',
		'  --svr-path <string>    服务对外的路径前缀',
		'  --help, -h             显示帮助信息',
		''
	].join('\n'));
	process.exit(0);
}

const port = parseInt(getArg('--port', '51145'), 10);
const svrProto = getArg('--svr-proto', '') || '';
const svrHost = getArg('--svr-host', '') || '';
const svrPort = parseInt(getArg('--svr-port', '0'), 10) || 0;
const svrPath = (getArg('--svr-path', '') || '').replace(/^\/+/, '').replace(/\/+$/, '');
const normalizedSvrPath = svrPath ? '/' + svrPath : '';

startServer({
	port,
	svrOptions: {
		proto: svrProto,
		host: svrHost,
		port: svrPort,
		path: normalizedSvrPath
	}
});
