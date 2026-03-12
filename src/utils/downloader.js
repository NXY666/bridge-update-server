import {createReadStream, createWriteStream} from 'node:fs';
import {mkdir, unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';

/**
 * 服务器返回错误时抛出的异常，表示不可重试的下载失败。
 */
export class FatalDownloadError extends Error {
	/**
	 * @param {string} message 错误信息
	 */
	constructor(message) {
		super(message);
		this.name = 'FatalDownloadError';
	}
}

// 并发下载参数
const TARGET_SPEED_KBPS = 2048; // 目标总下载速度（KB/s）
const MAX_THREADS = 32;         // 最大并发线程数
const PROBE_SIZE = 512 * 1024;  // 探测块大小：512KB

/**
 * 单线程全量下载文件。
 * @param {string} url 下载地址
 * @param {string} destPath 目标文件路径
 * @returns {Promise<void>}
 */
export async function downloadFile(url, destPath) {
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

/**
 * 下载指定字节范围到文件。
 * @param {string} url 下载地址
 * @param {number} start 起始字节（含）
 * @param {number} end 结束字节（含）
 * @param {string} chunkPath 分块文件路径
 * @returns {Promise<void>}
 */
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

/**
 * 按顺序将多个分块文件合并写入目标路径。
 * @param {string[]} chunkPaths 分块文件路径列表
 * @param {string} destPath 目标文件路径
 * @returns {Promise<void>}
 */
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

/**
 * 自适应并发分块下载：先探测单线程速度，再计算最优线程数并发下载。
 * @param {string} url 下载地址
 * @param {string} destPath 目标文件路径
 * @returns {Promise<void>}
 */
export async function parallelDownloadFile(url, destPath) {
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
		return downloadFile(url, destPath);
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
	console.log('[Downloader]', '探测速度', 'speed=', probeSpeedKBps.toFixed(1), 'KB/s', 'threads=', optimalThreads);

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
