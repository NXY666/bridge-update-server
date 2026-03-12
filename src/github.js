import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import cron from 'node-cron';
import {GithubClient} from './utils/github.js';
import {syncApk} from './cache.js';
import {discoverPeers} from './mdns.js';

const OWNER = 'NXY666';
const REPO = 'bridge-app';
const CACHE_DIR = join(tmpdir(), 'bridge-updater');
const VERSION_FILE = join(CACHE_DIR, 'version.json');

let versionInfo = null;

let nextPollTime = 0;

async function loadVersionCache() {
	try {
		const data = await readFile(VERSION_FILE, 'utf8');
		return JSON.parse(data);
	} catch {
		return null;
	}
}

async function saveVersionCache(info) {
	await mkdir(join(tmpdir(), 'bridge-updater'), {recursive: true});
	await writeFile(VERSION_FILE, JSON.stringify(info, null, 2));
}

// 根据速率限制状态计算并更新下次可发请求时间
function scheduleNextPoll(client) {
	const now = Date.now();
	const remaining = client.rateLimitRemaining;
	const reset = client.rateLimitReset;
	if (remaining <= 0) {
		nextPollTime = reset * 1000 + 1000;
		return;
	}
	if (reset > 0) {
		const msUntilReset = Math.max(0, reset * 1000 - now);
		const intervalMs = Math.floor(msUntilReset / remaining);
		nextPollTime = now + intervalMs;
		console.log('[GitHub]', '下次轮询时间', 'remaining=', remaining, 'intervalMs=', intervalMs, 'nextPollAt=', new Date(nextPollTime).toString());
	} else {
		nextPollTime = now + 60 * 60 * 1000;
	}
}

// 解析 Release 中的 Bridge APK 和 metadata 资源，返回版本信息
async function parseRelease(release) {
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

async function poll(client) {
	try {
		console.debug('[GitHub]', '正在获取最新版本信息...');
		const release = await client.getLatestRelease(OWNER, REPO);
		scheduleNextPoll(client);
		const info = await parseRelease(release);
		if (info) {
			versionInfo = info;
			await saveVersionCache(info);
			await syncApk(info, discoverPeers);
			console.log('[GitHub]', '版本信息已更新', 'version=', info.versionName, 'code=', info.versionCode);
		}
	} catch (err) {
		scheduleNextPoll(client);
		if (err.response?.headers?.['x-ratelimit-remaining'] === '0') {
			const reset = parseInt(err.response.headers['x-ratelimit-reset'], 10);
			console.warn('[GitHub]', '触发速率限制', 'resetAt=', new Date(reset * 1000).toISOString());
		} else {
			console.warn('[GitHub]', '轮询失败', 'error=', err.message);
		}
	}
}

export async function startGithubPolling(token) {
	const client = new GithubClient();
	if (token) {
		const valid = await client.setToken(token);
		if (!valid) {
			console.warn('[GitHub]', 'Token 无效');
		}
	}

	const cached = await loadVersionCache();
	if (cached) {
		versionInfo = cached;
		await syncApk(cached, discoverPeers);
		console.log('[Poll]', '已加载缓存版本信息', 'version=', cached.versionName, 'code=', cached.versionCode, 'cachedAt=', new Date(cached.cachedAt).toString());
	}

	cron.schedule('* * * * *', async () => {
		if (Date.now() < nextPollTime) {
			return;
		}
		await poll(client);
	});

	await poll(client);
}

export function getVersionInfo() {
	return versionInfo;
}
