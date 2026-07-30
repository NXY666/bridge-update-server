import {createReadStream, createWriteStream} from 'node:fs';
import {mkdir, unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {Readable, Transform} from 'node:stream';

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
const PROGRESS_INTERVAL_MS = 15 * 1000;
const MAX_RETRY_DELAY_SEC = 8;
const CHUNK_IDLE_TIMEOUT_MS = 30 * 1000;

function parseContentLength(res) {
	const contentLengthHeader = res.headers.get('content-length');
	const contentLength = contentLengthHeader != null ? parseInt(contentLengthHeader, 10) : -1;
	return Number.isFinite(contentLength) && contentLength > 0 ? contentLength : -1;
}

function createDownloadProgress(totalBytes = -1) {
	const chunkBytes = new Map();
	const retryingChunks = new Set();
	let currentTotalBytes = totalBytes;
	let transferredBytes = 0;
	let lastTransferredBytes = 0;
	let lastReportedAt = Date.now();

	const timer = setInterval(() => {
		const now = Date.now();
		const elapsedSec = Math.max((now - lastReportedAt) / 1000, 0.001);
		const downloadedBytes = Array.from(chunkBytes.values()).reduce((total, bytes) => total + bytes, 0);
		const speedKBps = (transferredBytes - lastTransferredBytes) / 1024 / elapsedSec;
		const hasTotalBytes = currentTotalBytes > 0;
		const percent = hasTotalBytes ? Math.min(downloadedBytes / currentTotalBytes * 100, 100).toFixed(1) + '%' : 'unknown';

		console.log('[Downloader]', '下载进度', 'downloadedBytes=', downloadedBytes, 'totalBytes=', hasTotalBytes ? currentTotalBytes : 'unknown', 'percent=', percent, 'speedKBps=', speedKBps.toFixed(1), 'retryingChunks=', retryingChunks.size);
		lastTransferredBytes = transferredBytes;
		lastReportedAt = now;
	}, PROGRESS_INTERVAL_MS);
	timer.unref();

	return {
		setTotalBytes(value) {
			currentTotalBytes = value;
		},
		addBytes(chunkId, bytes, attemptBytes) {
			transferredBytes += bytes;
			chunkBytes.set(chunkId, attemptBytes);
		},
		resetBytes(chunkId) {
			chunkBytes.set(chunkId, 0);
		},
		setRetrying(chunkId, retrying) {
			if (retrying) {
				retryingChunks.add(chunkId);
			} else {
				retryingChunks.delete(chunkId);
			}
		},
		stop() {
			clearInterval(timer);
		}
	};
}

function createProgressStream(progress, chunkId, onProgress) {
	let attemptBytes = 0;
	return new Transform({
		transform(chunk, encoding, callback) {
			attemptBytes += chunk.length;
			progress.addBytes(chunkId, chunk.length, attemptBytes);
			onProgress?.();
			callback(null, chunk);
		}
	});
}

function isRetryableNetworkError(err) {
	if (err?.name === 'AbortError') {
		return false;
	}
	if (err instanceof TypeError || err?.name === 'TimeoutError') {
		return true;
	}

	const code = err?.code;
	if (typeof code === 'string' && (
		code.startsWith('UND_ERR_') ||
		['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE'].includes(code)
	)) {
		return true;
	}

	return err?.cause ? isRetryableNetworkError(err.cause) : false;
}

function waitForRetry(delayMs, signal) {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, delayMs);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		signal.addEventListener('abort', onAbort, {once: true});
	});
}

/**
 * 单线程全量下载文件。
 * @param {string} url 下载地址
 * @param {string} destPath 目标文件路径
 * @returns {Promise<void>}
 */
export async function downloadFile(url, destPath) {
	const progress = createDownloadProgress();
	try {
		const res = await fetch(url, {
			headers: {'User-Agent': 'bridge-update-server'}
		});
		if (!res.ok) {
			throw new FatalDownloadError('下载失败: ' + res.status);
		}
		progress.setTotalBytes(parseContentLength(res));
		await mkdir(join(destPath, '..'), {recursive: true});
		const fileStream = createWriteStream(destPath);
		await pipeline(Readable.fromWeb(res.body), createProgressStream(progress, 'file'), fileStream);
	} finally {
		progress.stop();
	}
}

/**
 * 下载指定字节范围到文件。
 * @param {string} url 下载地址
 * @param {number} start 起始字节（含）
 * @param {number} end 结束字节（含）
 * @param {string} chunkPath 分块文件路径
 * @param {string} chunkId 分块标识
 * @param {ReturnType<typeof createDownloadProgress>} progress 下载进度
 * @param {AbortSignal} signal 取消信号
 * @returns {Promise<void>}
 */
async function downloadChunkToFile(url, start, end, chunkPath, chunkId, progress, signal) {
	const requestController = new AbortController();
	let idleTimer = null;
	let idleTimedOut = false;
	const abortRequest = () => requestController.abort(signal.reason);
	const resetIdleTimer = () => {
		clearTimeout(idleTimer);
		idleTimer = setTimeout(() => {
			idleTimedOut = true;
			requestController.abort();
		}, CHUNK_IDLE_TIMEOUT_MS);
		idleTimer.unref();
	};

	if (signal.aborted) {
		abortRequest();
	} else {
		signal.addEventListener('abort', abortRequest, {once: true});
	}
	resetIdleTimer();

	try {
		const res = await fetch(url, {
			headers: {
				'User-Agent': 'bridge-update-server',
				'Range': `bytes=${start}-${end}`
			},
			signal: requestController.signal
		});
		if (!res.ok) {
			throw new FatalDownloadError('分块下载失败: ' + res.status);
		}
		await mkdir(join(chunkPath, '..'), {recursive: true});
		const fileStream = createWriteStream(chunkPath);
		await pipeline(Readable.fromWeb(res.body), createProgressStream(progress, chunkId, resetIdleTimer), fileStream, {signal: requestController.signal});
	} catch (err) {
		if (signal.aborted) {
			throw signal.reason || err;
		}
		if (idleTimedOut) {
			const timeoutSeconds = CHUNK_IDLE_TIMEOUT_MS / 1000;
			const timeoutError = new Error('分块下载持续 ' + timeoutSeconds + ' 秒未收到数据');
			timeoutError.code = 'ETIMEDOUT';
			throw timeoutError;
		}
		throw err;
	} finally {
		clearTimeout(idleTimer);
		signal.removeEventListener('abort', abortRequest);
	}
}

async function downloadChunkWithRetry(url, start, end, chunkPath, chunkId, progress, signal) {
	let attempt = 0;
	try {
		while (true) {
			signal.throwIfAborted();
			attempt++;
			await unlink(chunkPath).catch(() => {});
			const startedAt = Date.now();

			try {
				await downloadChunkToFile(url, start, end, chunkPath, chunkId, progress, signal);
				return Math.max(Date.now() - startedAt, 1);
			} catch (err) {
				await unlink(chunkPath).catch(() => {});
				if (err instanceof FatalDownloadError || signal.aborted || !isRetryableNetworkError(err)) {
					throw err;
				}

				const delaySec = Math.min(Math.pow(2, attempt - 1), MAX_RETRY_DELAY_SEC);
				progress.resetBytes(chunkId);
				progress.setRetrying(chunkId, true);
				console.warn('[Downloader]', '分块下载失败，等待后重试', 'chunk=', chunkId, 'attempt=', attempt, 'delaySec=', delaySec, 'error=', err.message);
				await waitForRetry(delaySec * 1000, signal);
			}
		}
	} finally {
		progress.setRetrying(chunkId, false);
	}
}

async function downloadChunks(url, chunks, progress, signalController) {
	let terminalError = null;
	const downloadTasks = chunks.map(chunk => downloadChunkWithRetry(
		url,
		chunk.start,
		chunk.end,
		chunk.path,
		chunk.id,
		progress,
		signalController.signal
	).catch(err => {
		if (!signalController.signal.aborted) {
			terminalError = err;
			signalController.abort(err);
		}
		throw err;
	}));

	const results = await Promise.allSettled(downloadTasks);
	if (terminalError) {
		throw terminalError;
	}
	const failedResult = results.find(result => result.status === 'rejected');
	if (failedResult) {
		throw failedResult.reason;
	}
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
	const totalSize = parseContentLength(headRes);
	const hasValidTotalSize = totalSize > 0;
	const acceptsRanges = headRes.headers.get('accept-ranges') === 'bytes';

	if (!acceptsRanges || !hasValidTotalSize || totalSize <= PROBE_SIZE * 2) {
		// 不支持Range或文件过小，或者无法获取文件总大小，直接单线程下载
		return downloadFile(url, destPath);
	}

	const probeChunkPath = destPath + '.chunk_probe';
	const chunkPaths = [probeChunkPath];
	const progress = createDownloadProgress(totalSize);
	const signalController = new AbortController();

	try {
		// 探测单线程速度并计算并发数
		const probeElapsedMs = await downloadChunkWithRetry(url, 0, PROBE_SIZE - 1, probeChunkPath, 'probe', progress, signalController.signal);
		const probeSpeedKBps = Math.max(PROBE_SIZE / 1024 / (probeElapsedMs / 1000), 1);
		const optimalThreads = Math.min(MAX_THREADS, Math.max(1, Math.ceil(TARGET_SPEED_KBPS / probeSpeedKBps)));
		console.log('[Downloader]', '探测速度', 'speed=', probeSpeedKBps.toFixed(1), 'KB/s', 'threads=', optimalThreads);

		// 将剩余内容分块，每个分块独立重试网络错误
		const remaining = totalSize - PROBE_SIZE;
		const chunkSize = Math.ceil(remaining / optimalThreads);
		const chunks = [];
		for (let i = 0; i < optimalThreads; i++) {
			const start = PROBE_SIZE + i * chunkSize;
			const end = Math.min(start + chunkSize - 1, totalSize - 1);
			if (start >= totalSize) {
				break;
			}
			const chunkPath = destPath + '.chunk_' + i;
			chunkPaths.push(chunkPath);
			chunks.push({id: String(i), start, end, path: chunkPath});
		}

		await downloadChunks(url, chunks, progress, signalController);
		await mergeChunks(chunkPaths, destPath);
	} finally {
		progress.stop();
		if (!signalController.signal.aborted) {
			signalController.abort();
		}
		for (const chunkPath of chunkPaths) {
			await unlink(chunkPath).catch(() => {});
		}
	}
}
