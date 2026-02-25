#!/usr/bin/env node

import { startServer } from '../src/server.js';

const args = process.argv.slice(2);

function getArg(name, defaultValue) {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return defaultValue;
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
    '  --port <number>       HTTP 端口 (默认: 51145)',
    '  --mdns-host <string>  mDNS 广播的 host 覆盖值',
    '  --mdns-port <number>  mDNS 广播的 port 覆盖值',
    '  --mdns-path <string>  API 路径前缀 (默认: "")',
    '  --help, -h            显示帮助信息',
    ''
  ].join('\n'));
  process.exit(0);
}

const port = parseInt(getArg('--port', '51145'), 10);
const mdnsHost = getArg('--mdns-host', '') || '';
const mdnsPort = parseInt(getArg('--mdns-port', '0'), 10) || 0;
const mdnsPath = (getArg('--mdns-path', '') || '').replace(/^\/+/, '').replace(/\/+$/, '');
const normalizedPath = mdnsPath ? '/' + mdnsPath : '';

startServer({ port, mdnsHost, mdnsPort, mdnsPath: normalizedPath });
