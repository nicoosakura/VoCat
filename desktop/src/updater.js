'use strict';

// VoCat 桌面端 · 更新模块（PRD D8）
//
// 检查更新：查询 GitHub Releases 最新版（与服务端 internal/update 同一仓库
// MengMengCode/VoCat），按当前平台/架构匹配安装包资源。
// 安装引导：下载安装包到系统下载目录并交由系统安装（macOS .dmg / Windows NSIS）。
//
// 说明：真正的无感静默安装依赖代码签名 + 公证（macOS）与安装器自动化，属于
// 第三期 P2 的后续增强；当前版本以"检查 + 下载引导"提供安全、可审计的更新路径。
// 纯逻辑（版本比较、资源匹配、发布解析）保持无 Electron 依赖以便单测。

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const GITHUB_API = 'https://api.github.com';
const DEFAULT_REPO = 'MengMengCode/VoCat';
const MAX_NOTES_LENGTH = 2000;

// ---------------------------------------------------------------------------
// 版本号比较（纯函数）
// ---------------------------------------------------------------------------

function normalizeVersion(raw) {
  const cleaned = String(raw || '').trim().replace(/^v/i, '');
  const parts = cleaned.split('.');
  const numbers = [];
  for (const part of parts) {
    const value = Number.parseInt(part, 10);
    numbers.push(Number.isFinite(value) ? value : 0);
    if (numbers.length === 3) break;
  }
  while (numbers.length < 3) numbers.push(0);
  return numbers;
}

// semverCompare 返回 -1（a<b）、0、1（a>b）。
function semverCompare(a, b) {
  const left = normalizeVersion(a);
  const right = normalizeVersion(b);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Release 资源匹配（纯函数）
// ---------------------------------------------------------------------------

// 平台/架构 → asset 关键词。与 electron-builder artifactName 模板
// "VoCat-${version}-${os}-${arch}.${ext}" 保持一致（os=mac/win，arch=x64/arm64）。
// 非 darwin/win32 平台返回空串表示无对应安装包。
function assetKeywords(platform, arch) {
  let osWord;
  if (platform === 'darwin') osWord = 'mac';
  else if (platform === 'win32' || platform === 'win') osWord = 'win';
  else return '';
  const archWord = arch === 'arm64' ? 'arm64' : 'x64';
  return `${osWord}-${archWord}`;
}

// pickAsset 在发布资源中选择当前平台可安装的安装包。优先精确匹配
// 平台+架构，其次按平台降级（例如同一安装包同时覆盖两种架构）。
function pickAsset(release, platform, arch) {
  const assets = release && Array.isArray(release.assets) ? release.assets : [];
  const keyword = assetKeywords(platform, arch);
  if (!keyword) return null;
  const osWord = keyword.split('-')[0];
  const exact = assets.find((asset) => (asset && asset.name || '').includes(keyword));
  if (exact) return exact;
  return assets.find((asset) => (asset && asset.name || '').includes(osWord)) || null;
}

// parseRelease 校验并归一化 GitHub releases/latest 响应。
function parseRelease(json) {
  if (!json || typeof json !== 'object' || !json.tag_name) return null;
  const assets = Array.isArray(json.assets) ? json.assets : [];
  return {
    version: json.tag_name,
    versionNumber: normalizeVersion(json.tag_name).join('.'),
    url: String(json.html_url || `${GITHUB_API}/repos/${DEFAULT_REPO}/releases/latest`),
    notes: String(json.body || '').slice(0, MAX_NOTES_LENGTH),
    publishedAt: String(json.published_at || ''),
    assets: assets
      .filter((asset) => asset && asset.name && asset.browser_download_url)
      .map((asset) => ({
        name: asset.name,
        size: Number(asset.size) || 0,
        url: asset.browser_download_url,
      })),
  };
}

// ---------------------------------------------------------------------------
// 网络请求（可注入 httpGet 便于单测）
// ---------------------------------------------------------------------------

function defaultHttpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          statusCode: response.statusCode || 0,
          headers: response.headers || {},
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    request.on('error', reject);
    request.setTimeout(15000, () => {
      request.destroy(new Error('update check timed out'));
    });
  });
}

// checkForUpdates 查询最新发布并返回是否可更新。
async function checkForUpdates(options) {
  const {
    repo = DEFAULT_REPO,
    platform = process.platform,
    arch = process.arch,
    currentVersion,
    httpGet = defaultHttpGet,
  } = options;
  const url = `${GITHUB_API}/repos/${repo}/releases/latest`;
  let response;
  try {
    response = await httpGet(url, {
      'User-Agent': 'vocat-desktop-updater/1',
      Accept: 'application/vnd.github+json',
    });
  } catch (err) {
    return { ok: false, error: `无法访问更新服务：${err.message}` };
  }
  if (response.statusCode === 404) {
    return { ok: true, updateAvailable: false, reason: 'no_release', currentVersion };
  }
  if (response.statusCode === 403 || response.statusCode === 429) {
    return { ok: false, error: '更新服务限流，请稍后重试', retryable: true };
  }
  if (response.statusCode !== 200) {
    return { ok: false, error: `更新服务返回 HTTP ${response.statusCode}` };
  }
  let release;
  try {
    release = parseRelease(JSON.parse(response.body));
  } catch (err) {
    return { ok: false, error: '更新服务响应无法解析' };
  }
  if (!release) {
    return { ok: true, updateAvailable: false, reason: 'no_release', currentVersion };
  }
  const current = normalizeVersion(currentVersion).join('.');
  const available = semverCompare(release.versionNumber, current) > 0;
  const asset = available ? pickAsset(release, platform, arch) : null;
  return {
    ok: true,
    updateAvailable: available,
    assetAvailable: Boolean(asset),
    version: release.versionNumber,
    notes: release.notes,
    asset: asset ? { ...asset, currentVersion: current } : null,
    currentVersion: current,
  };
}

// ---------------------------------------------------------------------------
// 下载安装包
// ---------------------------------------------------------------------------

function defaultDestDir() {
  return path.join(os.homedir(), 'Downloads');
}

// downloadAsset 把安装包流式下载到目标目录，返回完整文件路径。
async function downloadAsset(assetUrl, filename, destDir, onProgress) {
  const directory = destDir || defaultDestDir();
  fs.mkdirSync(directory, { recursive: true });
  const destination = path.join(directory, filename);
  return new Promise((resolve, reject) => {
    const request = https.get(assetUrl, { headers: { 'User-Agent': 'vocat-desktop-updater/1' } }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`下载失败：HTTP ${response.statusCode}`));
        return;
      }
      const total = Number(response.headers['content-length']) || 0;
      let received = 0;
      const stream = fs.createWriteStream(destination);
      response.on('data', (chunk) => {
        received += chunk.length;
        if (typeof onProgress === 'function' && total > 0) {
          onProgress(received, total);
        }
      });
      response.pipe(stream);
      stream.on('finish', () => {
        stream.close(() => resolve({ filePath: destination, bytes: received }));
      });
      stream.on('error', (err) => {
        fs.unlink(destination, () => {});
        reject(err);
      });
    });
    request.on('error', (err) => reject(err));
    request.setTimeout(120000, () => {
      request.destroy(new Error('下载超时'));
    });
  });
}

module.exports = {
  DEFAULT_REPO,
  assetKeywords,
  semverCompare,
  normalizeVersion,
  pickAsset,
  parseRelease,
  checkForUpdates,
  downloadAsset,
  defaultDestDir,
};