import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const REPO = 'NXY666/bridge-app';
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const CACHE_DIR = join(tmpdir(), 'bridge-updater');
const VERSION_FILE = join(CACHE_DIR, 'version.json');
const POLL_INTERVAL = 60 * 60 * 1000;

let versionInfo = null;
let onChangeCallback = null;

async function fetchLatestRelease() {
	const res = await fetch(API_URL, {
		headers: {
			'Accept': 'application/vnd.github+json',
			'User-Agent': 'bridge-update-server'
		}
	});
	if (!res.ok) {
		console.warn('[GitHub]', '获取最新发布失败', 'status=', res.status);
		return null;
	}
	const release = await res.json();

	// 查找APK资源
	const apkAsset = release.assets.find(a => /^Bridge_v.*\.apk$/.test(a.name));
	if (!apkAsset) {
		console.warn('[GitHub]', '未找到APK资源');
		return null;
	}

	// 查找metadata.json资源
	const metadataAsset = release.assets.find(a => a.name === 'metadata.json');
	if (!metadataAsset) {
		console.warn('[GitHub]', '未找到metadata.json资源');
		return null;
	}

	// 下载metadata.json
	const metaRes = await fetch(metadataAsset.browser_download_url, {
		headers: {'User-Agent': 'bridge-update-server'}
	});
	if (!metaRes.ok) {
		console.warn('[GitHub]', '下载metadata.json失败', 'status=', metaRes.status);
		return null;
	}
	const metadata = await metaRes.json();

	// 从GitHub API的digest字段获取SHA256
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
		const parsed = JSON.parse(data);
		if (Date.now() - parsed.cachedAt < POLL_INTERVAL) {
			return parsed;
		}
	} catch {
		// 无可用缓存
	}
	return null;
}

async function saveVersionCache(info) {
	await mkdir(CACHE_DIR, {recursive: true});
	await writeFile(VERSION_FILE, JSON.stringify(info, null, 2));
}

async function poll() {
	try {
		const info = await fetchLatestRelease();
		if (info) {
			const prevCode = versionInfo?.versionCode;
			versionInfo = info;
			await saveVersionCache(info);
			console.log('[GitHub]', '版本信息已更新', 'version=', info.versionName, 'code=', info.versionCode);
			if (prevCode !== info.versionCode && onChangeCallback) {
				onChangeCallback(info);
			}
		}
	} catch (err) {
		console.warn('[GitHub]', '轮询失败', 'error=', err.message);
	}
}

// 获取当前版本信息
export function getVersionInfo() {
	return versionInfo;
}

// 获取APK的GitHub直链
export function getApkUrl() {
	return versionInfo?.apkUrl || '';
}

// 注册版本变更回调
export function onVersionChange(cb) {
	onChangeCallback = cb;
}

// 启动GitHub轮询
export async function startGithubPolling() {
	const cached = await loadCachedVersion();
	if (cached) {
		versionInfo = cached;

		// 等待缓存过期后再开始轮询
		setTimeout(async () => {
			await poll();
			setInterval(poll, POLL_INTERVAL);
		}, POLL_INTERVAL - (Date.now() - cached.cachedAt));

		console.log('[GitHub]', '使用缓存的版本信息', 'version=', cached.versionName);
	} else {
		await poll();
		setInterval(poll, POLL_INTERVAL);
	}
}
