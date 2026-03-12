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

// 服务器返回错误时抛出此异常，不重试
class FatalDownloadError extends Error {
	constructor(message) {
		super(message);
		this.name = 'FatalDownloadError';
	}
}

// 并发下载参数
const TARGET_SPEED_KBPS = 2048; // 目标总下载速度（KB/s）
const MAX_THREADS = 32;         // 最大并发线程数
const PROBE_SIZE = 512 * 1024;  // 探测块大小：512KB

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

// 单线程全量下载
async function downloadFromUrl(url, destPath) {
	const res = await fetch(url, {
		headers: {'User-Agent': 'bridge-update-server'}
	});
	if (!res.ok) {
		throw new FatalDownloadError('下载失败: ' + res.status);
	}
	await mkdir(join(destPath, '..'), {recursive: true});
	const fileStream = createWriteStream(destPath);
	await pipeline(Readable.fromWeb(res.body), fileStream);
}

// 下载指定字节范围到文件
async function downloadChunkToFile(url, start, end, chunkPath) {
	const res = await fetch(url, {
		headers: {
			'User-Agent': 'bridge-update-server',
			'Range': `bytes=${start}-${end}`
		}
	});
	if (!res.ok) {
		throw new FatalDownloadError('分块下载失败: ' + res.status);
	}
	await mkdir(join(chunkPath, '..'), {recursive: true});
	const fileStream = createWriteStream(chunkPath);
	await pipeline(Readable.fromWeb(res.body), fileStream);
}

// 按顺序将多个分块文件合并写入目标路径
async function mergeChunks(chunkPaths, destPath) {
	await mkdir(join(destPath, '..'), {recursive: true});
	const writeStream = createWriteStream(destPath);
	for (const chunkPath of chunkPaths) {
		await new Promise((resolve, reject) => {
			const readStream = createReadStream(chunkPath);
			readStream.on('error', (err) => {
				readStream.destroy();
				reject(err);
			});
			readStream.on('end', resolve);
			readStream.pipe(writeStream, {end: false});
		});
	}
	await new Promise((resolve, reject) => {
		writeStream.end();
		writeStream.on('finish', resolve);
		writeStream.on('error', reject);
	});
}

// 自适应并发分块下载：先探测单线程速度，再计算最优线程数并发下载
async function parallelDownloadFromUrl(url, destPath) {
	await mkdir(join(destPath, '..'), {recursive: true});

	// 检查服务器是否支持Range请求
	const headRes = await fetch(url, {
		method: 'HEAD',
		headers: {'User-Agent': 'bridge-update-server'}
	});
	const contentLengthHeader = headRes.headers.get('content-length');
	const totalSize = contentLengthHeader != null ? parseInt(contentLengthHeader, 10) : -1;
	const hasValidTotalSize = Number.isFinite(totalSize) && totalSize > 0;
	const acceptsRanges = headRes.headers.get('accept-ranges') === 'bytes';

	if (!acceptsRanges || !hasValidTotalSize || totalSize <= PROBE_SIZE * 2) {
		// 不支持Range或文件过小，或者无法获取文件总大小，直接单线程下载
		return downloadFromUrl(url, destPath);
	}

	// 探测单线程速度
	const probeChunkPath = destPath + '.chunk_probe';
	const probeStart = Date.now();
	await downloadChunkToFile(url, 0, PROBE_SIZE - 1, probeChunkPath);
	const probeElapsedSec = (Date.now() - probeStart) / 1000;
	// 最低1KB/s，防止网速极慢或计时精度问题导致除以零或线程数异常
	const probeSpeedKBps = Math.max(PROBE_SIZE / 1024 / probeElapsedSec, 1);

	// 根据目标速度和单线程实测速度计算最优线程数
	const optimalThreads = Math.min(MAX_THREADS, Math.max(1, Math.ceil(TARGET_SPEED_KBPS / probeSpeedKBps)));
	console.log('[Cache]', '探测速度', 'speed=', probeSpeedKBps.toFixed(1), 'KB/s', 'threads=', optimalThreads);

	// 将剩余部分均分为optimalThreads个块并发下载
	const remaining = totalSize - PROBE_SIZE;
	const chunkSize = Math.ceil(remaining / optimalThreads);
	const chunkPaths = [probeChunkPath];
	const downloadTasks = [];

	for (let i = 0; i < optimalThreads; i++) {
		const start = PROBE_SIZE + i * chunkSize;
		const end = Math.min(start + chunkSize - 1, totalSize - 1);
		if (start >= totalSize) {
			break;
		}
		const chunkPath = destPath + '.chunk_' + i;
		chunkPaths.push(chunkPath);
		downloadTasks.push(downloadChunkToFile(url, start, end, chunkPath));
	}

	try {
		await Promise.all(downloadTasks);
		await mergeChunks(chunkPaths, destPath);
	} finally {
		for (const chunkPath of chunkPaths) {
			await unlink(chunkPath).catch(() => {});
		}
	}
}

// 强制重新下载APK并替换本地缓存，失败后立即重试直至成功
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

		let attempt = 0;
		while (true) {
			attempt++;
			let downloaded = false;

			try {
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

				// 从GitHub并发下载
				if (!downloaded) {
					console.log('[Cache]', '从GitHub下载', 'attempt=', attempt, 'url=', info.apkUrl);
					await parallelDownloadFromUrl(info.apkUrl, tempPath);
				}

				// 验证SHA256
				if (info.sha256) {
					const actual = await computeSha256(tempPath);
					if (actual !== info.sha256) {
						console.warn('[Cache]', 'SHA256验证失败', 'expected=', info.sha256, 'actual=', actual);
						await unlink(tempPath).catch(() => {});
						continue;
					}
					console.log('[Cache]', 'SHA256验证成功');
				}

				await rename(tempPath, finalPath);
				console.log('[Cache]', 'APK缓存完成', 'attempt=', attempt);
				break;
			} catch (err) {
				await unlink(tempPath).catch(() => {});
				if (err instanceof FatalDownloadError) {
					console.warn('[Cache]', '服务器返回错误，放弃下载', 'error=', err.message);
					return;
				}
				const delaySec = Math.min(Math.pow(2, attempt - 1), 8);
				console.warn('[Cache]', '下载失败，等待后重试', 'attempt=', attempt, 'delaySec=', delaySec, 'error=', err.message);
				await new Promise(r => setTimeout(r, delaySec * 1000));
			}
		}
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

	return true;
}
