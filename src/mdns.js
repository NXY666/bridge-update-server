import ciao from '@homebridge/ciao';
import {Bonjour} from 'bonjour-service';
import {randomUUID} from 'node:crypto';

const SERVICE_NAME = 'Bridge Updater';
const SERVICE_TYPE = 'bridge-updater';

let bonjourInstance = null;
let ciaoResponder = null;
let publishedService = null;
const instanceId = randomUUID();

// 启动mDNS广播
export async function startMdns(port, mdnsHost, mdnsPort, mdnsPath) {
	bonjourInstance = new Bonjour();
	ciaoResponder = ciao.getResponder();

	const txt = {instance: instanceId};
	if (mdnsPath) {
		txt.path = mdnsPath;
	}
	if (mdnsHost) {
		txt.host = mdnsHost;
	}
	if (mdnsPort) {
		txt.port = String(mdnsPort);
	}

	publishedService = ciaoResponder.createService({
		name: SERVICE_NAME,
		type: SERVICE_TYPE,
		port,
		txt
	});
	await publishedService.advertise();

	console.log('[mDNS]', '服务已发布', 'type=', SERVICE_TYPE, 'port=', port);
}

// 扫描局域网内的其它update-server
export function discoverPeers() {
	return new Promise((resolve) => {
		if (!bonjourInstance) {
			resolve([]);
			return;
		}

		const peers = [];
		const browser = bonjourInstance.find({type: SERVICE_TYPE});

		browser.on('up', (service) => {
			// 过滤自身
			if (service.txt?.instance === instanceId) {
				return;
			}

			const txtPath = service.txt?.path || '';
			const txtHost = service.txt?.host;
			const txtPort = service.txt?.port;

			const host = txtHost || service.host;
			const port = txtPort ? parseInt(txtPort) : service.port;

			peers.push({
				name: service.name,
				host,
				port,
				versionUrl: `http://${host}:${port}${txtPath}/version`,
				downloadUrl: `http://${host}:${port}${txtPath}/download`
			});
		});

		setTimeout(() => {
			browser.stop();
			resolve(peers);
		}, 10000);
	});
}
