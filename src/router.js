import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import express, {Router} from 'express';
import {getVersionInfo} from './github.js';
import {getCachedApkSize, getCachedApkStream, hasCachedApk, syncApk} from './cache.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 创建REST API路由
export function createRouter(mdnsPath, discoverPeers) {
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

		let localUrl = null;
		if (hasCachedApk()) {
			const proto = req.get('X-Forwarded-Proto') || req.protocol || 'http';
			const host = req.get('X-Forwarded-Host') || req.get('Host');
			localUrl = `${proto}://${host}${mdnsPath}/download`;
		}

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
