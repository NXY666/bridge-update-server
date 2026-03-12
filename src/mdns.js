import {MdnsService} from './utils/mdns.js';

const mdns = new MdnsService({
	serviceName: 'Bridge Updater',
	serviceType: 'bridge-updater'
});

// 启动mDNS广播
export async function startMdns(port, svrOptions = {}) {
	const txt = {};
	if (svrOptions.path) {
		txt.path = svrOptions.path;
	}
	if (svrOptions.host) {
		txt.host = svrOptions.host;
	}
	if (svrOptions.port) {
		txt.port = String(svrOptions.port);
	}
	await mdns.advertise(port, txt);
}

// 扫描局域网内的其它update-server
export function discoverPeers() {
	return mdns.discover(10000).then(services =>
		services.map(service => {
			const txtPath = service.txt?.path || '';
			const txtHost = service.txt?.host;
			const txtPort = service.txt?.port;

			const host = txtHost || service.host;
			const port = txtPort ? parseInt(txtPort) : service.port;

			return {
				name: service.name,
				host,
				port,
				versionUrl: `http://${host}:${port}${txtPath}/version`,
				downloadUrl: `http://${host}:${port}${txtPath}/download`
			};
		})
	);
}
