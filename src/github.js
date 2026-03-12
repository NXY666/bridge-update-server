import {Octokit} from '@octokit/rest';
import cron from 'node-cron';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const OWNER = 'NXY666';
const REPO = 'bridge-app';
const CACHE_DIR = join(tmpdir(), 'bridge-updater');
const VERSION_FILE = join(CACHE_DIR, 'version.json');

let octokit = null;
let versionInfo = null;
let afterPollCallback = null;

// 速率限制状态
let rateLimitRemaining = Infinity;
let rateLimitReset = 0;
let nextPollTime = 0;

export async function initGithubClient(token) {
	octokit = new Octokit({auth: token || undefined});
	if (token) {
		const valid = await validateToken();
		if (!valid) {
			console.warn('[GitHub]', 'Token 无效，使用匿名访问。');
			octokit = new Octokit();
		}
	}
}

function updateRateLimitFromHeaders(headers) {
	const remaining = parseInt(headers['x-ratelimit-remaining'] ?? '', 10);
	const reset = parseInt(headers['x-ratelimit-reset'] ?? '', 10);
	if (!isNaN(remaining)) rateLimitRemaining = remaining;
	if (!isNaN(reset)) rateLimitReset = reset;
	scheduleNextPoll();
}

// 根据剩余配额和重置时间，计算下次轮询时间
function scheduleNextPoll() {
	const now = Date.now();
	if (rateLimitRemaining <= 0) {
		nextPollTime = rateLimitReset * 1000 + 1000;
		return;
	}
	if (rateLimitReset > 0) {
		const msUntilReset = Math.max(0, rateLimitReset * 1000 - now);
		const intervalMs = Math.floor(msUntilReset / rateLimitRemaining);
		nextPollTime = now + intervalMs;
		console.log('[GitHub]', '下次轮询时间', 'remaining=', rateLimitRemaining, 'intervalMs=', intervalMs, 'nextPollAt=', new Date(nextPollTime).toString());
	} else {
		nextPollTime = now + 60 * 60 * 1000;
	}
}

// 验证 Token 有效性，遇到速率限制时等待重置
async function validateToken() {
	while (true) {
		try {
			console.debug('[GitHub]', '正在验证 Token 有效性...');
			const {headers} = await octokit.rest.users.getAuthenticated();
			updateRateLimitFromHeaders(headers);
			return true;
		} catch (err) {
			if (err.response?.headers?.['x-ratelimit-remaining'] === '0') {
				const reset = parseInt(err.response.headers['x-ratelimit-reset'], 10);
				const waitMs = Math.max(reset * 1000 - Date.now() + 1000, 1000);
				console.warn('[GitHub]', '验证 Token 时触发速率限制，等待重置', 'waitMs=', waitMs);
				await new Promise(r => setTimeout(r, waitMs));
				continue;
			}
			if (err.status === 401) {
				return false;
			}
			throw err;
		}
	}
}

async function fetchLatestRelease() {
	const {data: release, headers} = await octokit.rest.repos.getLatestRelease({
		owner: OWNER,
		repo: REPO
	});
	updateRateLimitFromHeaders(headers);

	const apkAsset = release.assets.find(a => /^Bridge_v.*\.apk$/.test(a.name));
	if (!apkAsset) {
		console.warn('[GitHub]', '未找到APK资源');
		return null;
	}

	const metadataAsset = release.assets.find(a => a.name === 'metadata.json');
	if (!metadataAsset) {
		console.warn('[GitHub]', '未找到metadata.json资源');
		return null;
	}

	const metaRes = await fetch(metadataAsset.browser_download_url, {
		headers: {'User-Agent': 'bridge-update-server'}
	});
	if (!metaRes.ok) {
		console.warn('[GitHub]', '下载metadata.json失败', 'status=', metaRes.status);
		return null;
	}
	const metadata = await metaRes.json();

	const sha256 = apkAsset.digest ? apkAsset.digest.replace(/^sha256:/, '') : '';

	return {
		versionName: String(metadata.name),
		versionCode: Number(metadata.code),
		apkUrl: apkAsset.browser_download_url,
		apkFileName: apkAsset.name,
		sha256,
		size: apkAsset.size,
		cachedAt: Date.now()
	};
}

async function loadCachedVersion() {
	try {
		const data = await readFile(VERSION_FILE, 'utf8');
		return JSON.parse(data);
	} catch {
		return null;
	}
}

async function saveVersionCache(info) {
	await mkdir(CACHE_DIR, {recursive: true});
	await writeFile(VERSION_FILE, JSON.stringify(info, null, 2));
}

async function poll() {
	try {
		console.debug('[GitHub]', '正在获取最新版本信息...');
		const info = await fetchLatestRelease();
		if (info) {
			versionInfo = info;
			await saveVersionCache(info);
			console.log('[GitHub]', '版本信息已更新', 'version=', info.versionName, 'code=', info.versionCode);
			if (afterPollCallback) {
				afterPollCallback(info);
			}
		}
	} catch (err) {
		if (err.response?.headers?.['x-ratelimit-remaining'] === '0') {
			const reset = parseInt(err.response.headers['x-ratelimit-reset'], 10);
			rateLimitRemaining = 0;
			rateLimitReset = reset;
			nextPollTime = reset * 1000 + 1000;
			console.warn('[GitHub]', '触发速率限制', 'resetAt=', new Date(reset * 1000).toISOString());
		} else {
			console.warn('[GitHub]', '轮询失败', 'error=', err.message);
		}
	}
}

// 获取当前版本信息
export function getVersionInfo() {
	return versionInfo;
}

// 注册每次轮询成功后的回调
export function onPollComplete(cb) {
	afterPollCallback = cb;
}

// 启动GitHub轮询
export async function startGithubPolling() {
	console.debug('[Poll]', '正在启动...');

	// 验证init结果
	if (!octokit) {
		throw new Error('GitHub 客户端未初始化');
	} else {
		console.info('[GitHub]', '使用' + (octokit.auth ? '认证' : '匿名') + '访问 GitHub API');
	}

	const cached = await loadCachedVersion();
	if (cached) {
		versionInfo = cached;
		if (afterPollCallback) {
			afterPollCallback(cached);
		}
		console.log('[Poll]', '已加载缓存版本信息', 'version=', cached.versionName, 'code=', cached.versionCode, 'cachedAt=', new Date(cached.cachedAt).toString());
	}

	cron.schedule('* * * * *', async () => {
		if (Date.now() < nextPollTime) return;
		await poll();
	});

	if (nextPollTime <= Date.now()) {
		await poll();
	}
}
