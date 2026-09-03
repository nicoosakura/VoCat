'use strict';

// 更新模块纯逻辑测试：版本比较、Release 解析、资源匹配、检查更新分支。

const test = require('node:test');
const assert = require('node:assert');

const {
  semverCompare,
  normalizeVersion,
  pickAsset,
  parseRelease,
  checkForUpdates,
  assetKeywords,
} = require('../src/updater');

test('normalizeVersion 处理 v 前缀与不足三段', () => {
  assert.deepStrictEqual(normalizeVersion('v1.2.3'), [1, 2, 3]);
  assert.deepStrictEqual(normalizeVersion('1.2'), [1, 2, 0]);
  assert.deepStrictEqual(normalizeVersion('2'), [2, 0, 0]);
  assert.deepStrictEqual(normalizeVersion(''), [0, 0, 0]);
  assert.deepStrictEqual(normalizeVersion('v1.2.3.4-rc1'), [1, 2, 3]);
});

test('semverCompare 大小比较', () => {
  assert.strictEqual(semverCompare('1.2.3', '1.2.3'), 0);
  assert.strictEqual(semverCompare('0.1.0', 'v0.1.0'), 0);
  assert.strictEqual(semverCompare('1.2.4', '1.2.3'), 1);
  assert.strictEqual(semverCompare('1.2.0', '1.10.0'), -1);
  assert.strictEqual(semverCompare('2.0.0', '1.9.9'), 1);
});

test('assetKeywords 平台架构关键词', () => {
  assert.strictEqual(assetKeywords('darwin', 'arm64'), 'mac-arm64');
  assert.strictEqual(assetKeywords('darwin', 'x64'), 'mac-x64');
  assert.strictEqual(assetKeywords('win32', 'x64'), 'win-x64');
  assert.strictEqual(assetKeywords('win32', 'arm64'), 'win-arm64');
  assert.strictEqual(assetKeywords('linux', 'x64'), '');
});

test('pickAsset 精确匹配与平台降级', () => {
  const release = {
    assets: [
      { name: 'VoCat-0.2.0-win-x64.exe', browser_download_url: 'u1' },
      { name: 'VoCat-0.2.0-mac-arm64.dmg', browser_download_url: 'u2' },
      { name: 'VoCat-0.2.0-mac-x64.dmg', browser_download_url: 'u3' },
    ],
  };
  const m1 = pickAsset(release, 'win32', 'x64');
  assert.strictEqual(m1.name, 'VoCat-0.2.0-win-x64.exe');
  const m2 = pickAsset(release, 'darwin', 'arm64');
  assert.strictEqual(m2.name, 'VoCat-0.2.0-mac-arm64.dmg');

  // win-arm64 无精确匹配 → 平台降级到 win 下的任一资源。
  const m3 = pickAsset(release, 'win32', 'arm64');
  assert.ok(m3.name.includes('win'), `should fall back to win asset, got ${m3.name}`);

  assert.strictEqual(pickAsset({ assets: [] }, 'darwin', 'x64'), null);
  assert.strictEqual(pickAsset(null, 'darwin', 'x64'), null);
});

test('parseRelease 归一化 GitHub 响应', () => {
  const parsed = parseRelease({
    tag_name: 'v0.2.0',
    html_url: 'https://github.com/MengMengCode/VoCat/releases/tag/v0.2.0',
    body: 'fix: 通知桥接去重',
    published_at: '2026-09-01T00:00:00Z',
    assets: [
      { name: 'VoCat-0.2.0-mac-x64.dmg', size: 12345, browser_download_url: 'https://x/dmg' },
      { name: 'bad' },
    ],
  });
  assert.strictEqual(parsed.versionNumber, '0.2.0');
  assert.strictEqual(parsed.assets.length, 1);
  assert.strictEqual(parsed.assets[0].name, 'VoCat-0.2.0-mac-x64.dmg');
  assert.strictEqual(parsed.assets[0].size, 12345);
  assert.strictEqual(parsed.notes, 'fix: 通知桥接去重');

  assert.strictEqual(parseRelease(null), null);
  assert.strictEqual(parseRelease({}), null);
});

function fakeHttpGet(statusCode, body) {
  return async () => ({ statusCode, body: typeof body === 'string' ? body : JSON.stringify(body), headers: {} });
}

const latestJson = {
  tag_name: 'v0.2.0',
  html_url: 'https://github.com/MengMengCode/VoCat/releases/tag/v0.2.0',
  body: 'notes',
  assets: [
    { name: 'VoCat-0.2.0-win-x64.exe', size: 100, browser_download_url: 'https://x/win.exe' },
    { name: 'VoCat-0.2.0-mac-arm64.dmg', size: 100, browser_download_url: 'https://x/mac-arm64.dmg' },
  ],
};

test('checkForUpdates 有更新且匹配到安装包', async () => {
  const result = await checkForUpdates({
    repo: 'MengMengCode/VoCat',
    platform: 'darwin',
    arch: 'arm64',
    currentVersion: '0.1.0',
    httpGet: fakeHttpGet(200, latestJson),
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.updateAvailable, true);
  assert.strictEqual(result.assetAvailable, true);
  assert.strictEqual(result.version, '0.2.0');
  assert.strictEqual(result.asset.name, 'VoCat-0.2.0-mac-arm64.dmg');
});

test('checkForUpdates 当前已是最新', async () => {
  const result = await checkForUpdates({
    platform: 'darwin',
    arch: 'x64',
    currentVersion: '0.2.0',
    httpGet: fakeHttpGet(200, latestJson),
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.updateAvailable, false);
  assert.strictEqual(result.asset, null);
});

test('checkForUpdates 版本更高但无当前平台资源', async () => {
  const result = await checkForUpdates({
    platform: 'linux',
    arch: 'x64',
    currentVersion: '0.1.0',
    httpGet: fakeHttpGet(200, latestJson),
  });
  assert.strictEqual(result.updateAvailable, true);
  assert.strictEqual(result.assetAvailable, false);
  assert.strictEqual(result.asset, null);
});

test('checkForUpdates 网络与服务端异常分支', async () => {
  const notFound = await checkForUpdates({ currentVersion: '0.1.0', httpGet: fakeHttpGet(404, {}) });
  assert.strictEqual(notFound.ok, true);
  assert.strictEqual(notFound.updateAvailable, false);
  assert.strictEqual(notFound.reason, 'no_release');

  const limited = await checkForUpdates({ currentVersion: '0.1.0', httpGet: fakeHttpGet(403, {}) });
  assert.strictEqual(limited.ok, false);
  assert.strictEqual(limited.retryable, true);

  const failure = await checkForUpdates({
    currentVersion: '0.1.0',
    httpGet: async () => {
      throw new Error('network down');
    },
  });
  assert.strictEqual(failure.ok, false);
  assert.ok(failure.error.includes('无法访问'));
});