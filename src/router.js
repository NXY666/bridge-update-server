import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import express, {Router} from 'express';
import {getVersionInfo} from './github.js';
import {getCachedApkSize, getCachedApkStream, syncApk} from './cache.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 创建REST API路由
export function createRouter(discoverPeers, svrOptions = {}, serverPort = 0) {
	const router = Router();

	// 静态文件
	router.use(express.static(join(__dirname, '../public')));

	// 获取最新版本信息
	router.get('/version', (req, res) => {
		const info = getVersionInfo();
		if (!info) {
			return res.status(503).json({
				state: false,
				message: '版本信息尚未获取'
			});
		}

		const proto = svrOptions.proto
			|| req.get('X-Forwarded-Proto')
			|| req.protocol
			|| 'http';

		const fwdHost = req.get('X-Forwarded-Host') || '';
		const fwdHostName = fwdHost.split(':')[0];
		const fwdHostPort = fwdHost.split(':')[1] || '';
		const host = svrOptions.host || fwdHostName || req.hostname;

		const rawPort = svrOptions.port
			|| parseInt(req.get('X-Forwarded-Port') || fwdHostPort || '0', 10)
			|| serverPort;
		const isDefaultPort = (proto === 'https' && rawPort === 443)
			|| (proto === 'http' && rawPort === 80);
		const portStr = (!rawPort || isDefaultPort) ? '' : ':' + rawPort;

		const path = svrOptions.path
			|| req.get('X-Forwarded-Prefix')
			|| '';

		const localUrl = proto + '://' + host + portStr + path + '/download';

		res.json({
			state: true,
			data: {
				versionName: info.versionName,
				versionCode: info.versionCode,
				downUrl: {
					local: localUrl,
					github: info.apkUrl
				},
				sha256: info.sha256
			}
		});
		console.log('[Version]', '返回版本信息', 'localUrl=', localUrl, 'githubUrl=', info.apkUrl);
	});

	// 下载APK
	router.get('/download', async (req, res) => {
		const ready = await syncApk(discoverPeers);
		if (ready) {
			const size = await getCachedApkSize();
			const filename = 'Bridge_v' + getVersionInfo().versionName + '.apk';
			res.set('Content-Type', 'application/vnd.android.package-archive');
			res.set('Content-Disposition', 'attachment; filename="' + filename + '"');
			if (size > 0) {
				res.set('Content-Length', String(size));
			}
			getCachedApkStream().pipe(res);
			return;
		}
		const apkUrl = getVersionInfo()?.apkUrl;
		if (!apkUrl) {
			return res.status(503).json({
				state: false,
				message: 'APK尚未可用'
			});
		}
		res.redirect(302, apkUrl);
	});

	return router;
}
