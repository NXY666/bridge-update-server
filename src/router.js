import { Router } from 'express';
import { getVersionInfo, getApkUrl } from './github.js';
import { hasCachedApk, getCachedApkStream, getCachedApkSize, verifyCachedApk, triggerRebuild } from './cache.js';

// 创建REST API路由
export function createRouter(mdnsPath, discoverPeers) {
  const router = Router();

  // 获取最新版本信息
  router.get('/version', async (req, res) => {
    const info = getVersionInfo();
    if (!info) {
      return res.status(503).json({
        state: false,
        message: '版本信息尚未获取'
      });
    }

    let downloadUrl;
    if (hasCachedApk()) {
      const proto = req.get('X-Forwarded-Proto') || req.protocol || 'http';
      const host = req.get('X-Forwarded-Host') || req.get('Host');
      downloadUrl = `${proto}://${host}${mdnsPath}/download`;
    } else {
      downloadUrl = info.apkUrl;
    }

    res.json({
      state: true,
      data: {
        versionName: info.versionName,
        versionCode: info.versionCode,
        downloadUrl,
        sha256: info.sha256
      }
    });
  });

  // 下载APK
  router.get('/download', async (req, res) => {
    if (hasCachedApk()) {
      const valid = await verifyCachedApk();
      if (valid) {
        const size = await getCachedApkSize();
        res.set('Content-Type', 'application/vnd.android.package-archive');
        if (size > 0) res.set('Content-Length', String(size));
        getCachedApkStream().pipe(res);
        return;
      }
      console.warn('[Router]', '缓存SHA256验证失败，重建缓存');
      triggerRebuild(discoverPeers);
    }
    const apkUrl = getApkUrl();
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
