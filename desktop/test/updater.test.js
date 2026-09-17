'use strict';

// 更新模块纯逻辑测试：版本比较、Release 解析、资源匹配、检查更新分支。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  semverCompare,
  normalizeVersion,
  pickAsset,
  parseRelease,
  checkForUpdates,
  assetKeywords,
  resolveRepo,
  DEFAULT_REPO,
  assertTrustedAssetUrl,
  safeAssetFilename,
  sha256File,
  parseChecksums,
} = require('../src/updater');

test('assertTrustedAssetUrl 拒绝非 GitHub 来源与明文协议', () => {
  assert.throws(() => assertTrustedAssetUrl('http://evil.example.com/steal.exe'), /HTTPS|可信来源/);
  assert.throws(() => assertTrustedAssetUrl('https://evil.example.com/steal.exe'), /可信来源/);
  assert.throws(() => assertTrustedAssetUrl('file:///etc/passwd'), /HTTPS/);
  assert.throws(() => assertTrustedAssetUrl('not-a-url'), /下载地址无效/);
  // GitHub 仓库直链与 CDN 直链均放行。
  assert.doesNotThrow(() =>
    assertTrustedAssetUrl('https://github.com/nicoosakura/VoCat/releases/download/v0.2.0/VoCat-0.2.0-win-x64.exe'));
  assert.doesNotThrow(() =>
    assertTrustedAssetUrl('https://objects.githubusercontent.com/abc/def?token=xyz'));
});

test('safeAssetFilename 只保留 basename，杜绝路径穿越', () => {
  assert.strictEqual(safeAssetFilename('VoCat-0.2.0-win-x64.exe'), 'VoCat-0.2.0-win-x64.exe');
  assert.strictEqual(safeAssetFilename('../../etc/passwd'), 'passwd');
  assert.strictEqual(safeAssetFilename('.\\..\\C:\\evil.exe'), 'evil.exe');
  assert.throws(() => safeAssetFilename(''), /文件名无效/);
  assert.throws(() => safeAssetFilename('..'), /文件名无效/);
});

test('resolveRepo 优先取 VOCAT_REPO，非法值回退默认仓库', () => {
  const original = process.env.VOCAT_REPO;
  try {
    delete process.env.VOCAT_REPO;
    assert.strictEqual(resolveRepo(), DEFAULT_REPO);
    process.env.VOCAT_REPO = 'nicoosakura/VoCat';
    assert.strictEqual(resolveRepo(), 'nicoosakura/VoCat');
    process.env.VOCAT_REPO = '  含空格/绝对非法  ';
    assert.strictEqual(resolveRepo(), DEFAULT_REPO);
    process.env.VOCAT_REPO = '';
    assert.strictEqual(resolveRepo(), DEFAULT_REPO);
  } finally {
    if (original === undefined) delete process.env.VOCAT_REPO;
    else process.env.VOCAT_REPO = original;
  }
});

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

test('checkForUpdates 解析 SHA256SUMS 资产并附带 checksumUrl', async () => {
  const result = await checkForUpdates({
    platform: 'darwin',
    arch: 'arm64',
    currentVersion: '0.1.0',
    httpGet: fakeHttpGet(200, {
      tag_name: 'v0.2.0',
      html_url: 'https://github.com/MengMengCode/VoCat/releases/tag/v0.2.0',
      body: '',
      assets: [
        { name: 'VoCat-0.2.0-mac-arm64.dmg', size: 100, browser_download_url: 'https://x/mac.dmg' },
        { name: 'SHA256SUMS', size: 20, browser_download_url: 'https://x/SHA256SUMS' },
      ],
    }),
  });
  assert.strictEqual(result.updateAvailable, true);
  assert.strictEqual(result.asset.checksumUrl, 'https://x/SHA256SUMS');
});

test('checkForUpdates 无 SHA256SUMS 时 checksumUrl 为 null', async () => {
  const result = await checkForUpdates({
    platform: 'darwin',
    arch: 'arm64',
    currentVersion: '0.1.0',
    httpGet: fakeHttpGet(200, latestJson),
  });
  assert.strictEqual(result.asset.checksumUrl, null);
});

test('parseChecksums 提取目标文件校验值并忽略杂项', () => {
  const body = [
    '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08  vocat-linux-amd64',
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 *VoCat-0.2.0-win-x64.exe',
    '',
    'not a checksum line',
  ].join('\n');
  assert.strictEqual(
    parseChecksums(body, 'VoCat-0.2.0-win-x64.exe'),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  // 目标不存在返回 null；非法输入返回 null。
  assert.strictEqual(parseChecksums(body, 'missing.exe'), null);
  assert.strictEqual(parseChecksums(null, 'x'), null);
  assert.strictEqual(parseChecksums('', 'x'), null);
});

test('sha256File 正确计算文件哈希', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vocat-updater-'));
  const file = path.join(dir, 'payload.txt');
  fs.writeFileSync(file, 'hello');
  const hex = await sha256File(file);
  // sha256("hello") 的已知值。
  assert.strictEqual(hex, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  fs.rmSync(dir, { recursive: true, force: true });
});