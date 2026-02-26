import {createReadStream, createWriteStream, existsSync} from 'node:fs';
import {mkdir, rename, stat, unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';
import {getVersionInfo} from './github.js';

const CACHE_DIR = join(tmpdir(), 'bridge-updater', 'apk');
const APK_FILENAME = 'latest-app.apk';
let downloading = false;

// 获取已缓存APK的文件路径
export function getCachedApkPath() {
	const filePath = join(CACHE_DIR, APK_FILENAME);
	return existsSync(filePath) ? filePath : null;
}

// 获取APK文件流
export function getCachedApkStream() {
	const filePath = getCachedApkPath();
	if (!filePath) {
		return null;
	}
	return createReadStream(filePath);
}

// 获取APK文件大小
export async function getCachedApkSize() {
	const filePath = getCachedApkPath();
	if (!filePath) {
		return 0;
	}
	const s = await stat(filePath);
	return s.size;
}

function computeSha256(filePath) {
	return new Promise((resolve, reject) => {
		const hash = createHash('sha256');
		const stream = createReadStream(filePath);
		stream.on('data', chunk => hash.update(chunk));
		stream.on('end', () => resolve(hash.digest('hex')));
		stream.on('error', reject);
	});
}

async function downloadFromUrl(url, destPath) {
	const res = await fetch(url, {
		headers: {'User-Agent': 'bridge-update-server'}
	});
	if (!res.ok) {
		throw new Error('下载失败: ' + res.status);
	}
	await mkdir(join(destPath, '..'), {recursive: true});
	const fileStream = createWriteStream(destPath);
	await pipeline(Readable.fromWeb(res.body), fileStream);
}

// 强制重新下载APK并替换本地缓存
export async function triggerRebuild(discoverPeers) {
	const info = getVersionInfo();
	if (!info || downloading) {
		return;
	}

	downloading = true;
	const tempPath = join(CACHE_DIR, APK_FILENAME + '.tmp');
	const finalPath = join(CACHE_DIR, APK_FILENAME);

	try {
		await mkdir(CACHE_DIR, {recursive: true});
		await unlink(finalPath).catch(() => {});
		let downloaded = false;

		// 优先从局域网peer下载
		if (discoverPeers) {
			try {
				const peers = await discoverPeers();
				for (const peer of peers) {
					try {
						const peerVersionRes = await fetch(peer.versionUrl, {
							signal: AbortSignal.timeout(5000)
						});
						if (!peerVersionRes.ok) {
							continue;
						}

						const peerVersion = await peerVersionRes.json();
						if (!peerVersion.state || peerVersion.data?.versionCode !== info.versionCode) {
							continue;
						}

						console.log('[Cache]', '从局域网peer下载', 'peer=', peer.downloadUrl);
						await downloadFromUrl(peer.downloadUrl, tempPath);
						downloaded = true;
						break;
					} catch {
						// peer不可用，继续尝试下一个
					}
				}
			} catch {
				// peer发现失败
			}
		}

		// 从GitHub下载
		if (!downloaded) {
			console.log('[Cache]', '从GitHub下载', 'url=', info.apkUrl);
			await downloadFromUrl(info.apkUrl, tempPath);
		}

		// 验证SHA256
		if (info.sha256) {
			const actual = await computeSha256(tempPath);
			if (actual !== info.sha256) {
				console.warn('[Cache]', 'SHA256验证失败', 'expected=', info.sha256, 'actual=', actual);
				await unlink(tempPath).catch(() => {});
				return;
			}
			console.log('[Cache]', 'SHA256验证成功');
		}

		await rename(tempPath, finalPath);
		console.log('[Cache]', 'APK缓存完成');
	} catch (err) {
		console.warn('[Cache]', '下载失败', 'error=', err.message);
		await unlink(tempPath).catch(() => {});
	} finally {
		downloading = false;
	}
}

// 确保APK缓存可用。返回true表示已就绪，false表示正在同步中
export async function syncApk(discoverPeers) {
	const info = getVersionInfo();
	if (!info || downloading) {
		return false;
	}

	const filePath = getCachedApkPath();
	if (!filePath) {
		triggerRebuild(discoverPeers);
		return false;
	}

	if (info.sha256) {
		const actual = await computeSha256(filePath);
		if (actual !== info.sha256) {
			console.warn('[Cache]', 'SHA256不匹配', 'expected=', info.sha256, 'actual=', actual);
			triggerRebuild(discoverPeers);
			return false;
		}
	}
	return true;
}
