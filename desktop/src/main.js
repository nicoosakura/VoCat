'use strict';

// VoCat 桌面控制端 · 主进程
//
// 职责边界：本文件是唯一接触操作系统能力（托盘、通知、钥匙串、自启、
// 子进程、单实例）的地方。渲染进程只加载 VoCat Web 界面（远程主机地址
// 或本地一体服务的回环地址），不做任何改造成业务改造。

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, safeStorage, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { NotificationBridge } = require('./notify-bridge');
const updater = require('./updater');

const APP_NAME = 'VoCat Desktop';
// 默认服务端口：与 Go 服务端 config 默认一致（参考 internal/config/config.go）。
const DEFAULT_PORT = 7575;
// 本地一体服务的探活路径。服务端 /api/health* 或根路径均可，只需能区分
// "服务已就绪"与"还在启动"。
const READY_PATH = '/api/health';

// ---------------------------------------------------------------------------
// 单实例锁：同一时刻只允许一个桌面端进程，避免多个实例重复拉起本地服务
// 或重复写主机配置。
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// ---------------------------------------------------------------------------
// 平台能力常量：注入给设置窗口与（将来）Web 界面做能力降级展示（PRD D9）。
// Linux 专属能力（DJI QMI 绑定修复、udev、uevent 热插拔）在 mac/win 上不可用。
// ---------------------------------------------------------------------------
const PLATFORM = process.platform; // 'darwin' | 'win32' | 'linux'
const LINUX_ONLY_CAPABILITIES = ['dji_qmi_repair', 'udev', 'uevent_hotplug'];

// ---------------------------------------------------------------------------
// 持久化状态
// ---------------------------------------------------------------------------
let mainWindow = null;
let tray = null;
let settingsWindow = null;
let localService = null; // 本地一体模式的内嵌服务子进程
let lastLocalHost = null; // 崩溃自愈：记录最后一次拉起的本地主机配置
let lastRestartAt = 0;    // 崩溃自愈：上次自动重启时间戳（60s 限流）
// 检查更新/下载更新防重入
let updateInFlight = false;
// 窗口位置记忆（PRD D1）：防抖保存定时器
let boundsSaveTimer = null;

const userDataDir = app.getPath('userData');
const settingsPath = path.join(userDataDir, 'settings.json');

const DEFAULT_SETTINGS = {
  hosts: [], // { id, name, protocol, address, port, mode, credential, useCredential }
  defaultHostId: '',
  autoLaunch: false,
  closeToTray: true,
  notificationsEnabled: true, // PRD D6：桌面通知桥接总开关
  windowBounds: null,          // PRD D1：窗口位置与大小跨会话记忆
};

// 通知桥接（PRD D6）：消费服务端事件流并转为系统通知。
let notificationBridge = new NotificationBridge({
  notify: notify,
  focusAndNavigate: focusAndNavigate,
});

function ensureSettings() {
  if (!fs.existsSync(settingsPath)) {
    fs.writeFileSync(settingsPath, JSON.stringify(DEFAULT_SETTINGS, null, 2), 'utf8');
  }
}

function loadSettings() {
  ensureSettings();
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return { ...DEFAULT_SETTINGS, ...raw };
  } catch (err) {
    console.error('[vocat-desktop] settings.json 不可解析，使用默认值:', err.message);
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(patch) {
  const settings = { ...loadSettings(), ...patch };
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// 凭证密文存储
//
// macOS 走 Keychain（SafeStorage 底层）、Windows 走 DPAPI（与 Credential
// Manager 同源的用户级加密）。两者在已登录会话里一致可用；不可用时回退
// base64（不加密）并显著提示，保证功能不因钥匙串策略而完全不可用。
// ---------------------------------------------------------------------------
function isCredentialStorageUsable() {
  return safeStorage.isEncryptionAvailable();
}

function encryptSecret(plain) {
  if (!isCredentialStorageUsable()) return Buffer.from(plain, 'utf8').toString('base64');
  return safeStorage.encryptString(plain).toString('base64');
}

function decryptSecret(encoded) {
  try {
    if (!isCredentialStorageUsable()) return Buffer.from(encoded, 'base64').toString('utf8');
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// 主机配置
// ---------------------------------------------------------------------------
function normalizeHost(input) {
  const protocol = String(input.protocol || 'http').toLowerCase() === 'https' ? 'https' : 'http';
  const port = Number.parseInt(String(input.port || DEFAULT_PORT), 10);
  const address = String(input.address || '').trim();
  const name = String(input.name || '').trim() || address;
  const mode = input.mode === 'local' ? 'local' : 'remote';
  const plainCredential = typeof input.credential === 'string' ? input.credential : '';
  return {
    id: String(input.id || `host-${Date.now().toString(36)}`),
    name,
    protocol,
    address,
    port: Number.isFinite(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT,
    mode,
    // 凭证只存密文；空串表示远程模式走 Web 登录、本地模式走一次性随机口令。
    credential: plainCredential ? encryptSecret(plainCredential) : '',
    useCredential: !!plainCredential,
  };
}

function hostBaseUrl(host) {
  return `${host.protocol}://${host.address}:${host.port}`;
}

function findHost(settings, hostId) {
  return settings.hosts.find((host) => host.id === hostId) || null;
}

function resolveDefaultTarget(settings) {
  const host = findHost(settings, settings.defaultHostId) || settings.hosts[0] || null;
  if (!host) return null;
  if (host.mode === 'local') return { host, url: `http://127.0.0.1:${host.port}` };
  return { host, url: hostBaseUrl(host) };
}

// ---------------------------------------------------------------------------
// 连通性探活：对目标主机做一次 HTTP GET，用于"添加主机"时的验证与托盘
// 状态的在线/离线判断。只做只读探测，不发送任何认证材料。
// ---------------------------------------------------------------------------
function probeHost(host, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const url = new URL(READY_PATH, hostBaseUrl(host));
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      response.resume();
      resolve({ ok: response.statusCode >= 200 && response.statusCode < 500 });
    });
    request.on('timeout', () => {
      request.destroy();
      resolve({ ok: false, error: 'timeout' });
    });
    request.on('error', (err) => resolve({ ok: false, error: err.code || err.message }));
  });
}

// ---------------------------------------------------------------------------
// 本地一体服务：拉起内嵌 Go 服务二进制，绑定回环随机端口，探活通过后
// 进入可用态。崩溃后允许自动拉起一次并弹通知，一分钟内不重复拉起。
// ---------------------------------------------------------------------------
function bundledServicePath() {
  if (PLATFORM === 'darwin') {
    const root = path.join(process.resourcesPath, 'services');
    return path.join(root, `darwin-${process.arch}`, 'vocat');
  }
  if (PLATFORM === 'win32') {
    return path.join(process.resourcesPath, 'services', 'win32-x64', 'vocat.exe');
  }
  return path.join(process.resourcesPath, 'services', 'linux-x64', 'vocat');
}

function freePort(from = 20000, to = 39999) {
  return new Promise((resolve) => {
    const candidate = from + Math.floor(Math.random() * (to - from));
    const server = http.createServer();
    server.listen(candidate, '127.0.0.1', () => server.close(() => resolve(candidate)));
    server.on('error', () => resolve(freePort(from, to)));
  });
}

async function startLocalService(host) {
  if (localService && !localService.killed) {
    return { ok: true, url: `http://127.0.0.1:${host.port ?? DEFAULT_PORT}`, alreadyRunning: true };
  }
  const binary = bundledServicePath();
  if (!fs.existsSync(binary)) {
    return { ok: false, error: '内嵌服务二进制缺失，请先运行 npm run build:go' };
  }
  const port = host.port || (await freePort());
  // PRD 第二期：为本地一体模式生成一次性随机口令。服务端以该口令武装
  // 本地会话签发（60s 有效、单次使用），主进程随后换取会话并注入默认
  // session，渲染进程打开页面即为已登录状态，轮询请求共享同一登录态。
  const localSecret = crypto.randomBytes(24).toString('base64url');
  lastLocalHost = host;
  const service = spawn(binary, ['--address', `127.0.0.1:${port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, VOCAT_LOCAL_ISSUE_SECRET: localSecret },
  });
  localService = service;
  service.stdout.on('data', (chunk) => console.log('[vocat-service]', String(chunk).trimEnd()));
  service.stderr.on('data', (chunk) => console.error('[vocat-service]', String(chunk).trimEnd()));
  service.on('exit', (code, signal) => {
    console.log(`[vocat-desktop] 本地服务退出 code=${code} signal=${signal}`);
    localService = null;
    if (app.isQuiting || service.killed) {
      return;
    }
    // 崩溃自愈（PRD 第二期 AC4）：非主动退出时自动重启一次，60s 限流
    // 防循环崩溃风暴。
    const now = Date.now();
    if (now - lastRestartAt > 60000 && lastLocalHost) {
      lastRestartAt = now;
      notify('本地服务已重启', '服务进程异常退出，正在自动重启…');
      void startLocalService(lastLocalHost).then((result) => {
        if (result.ok) {
          // 服务回到同一回环端口，主窗口若正指向本地服务则自动刷新登录态。
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.loadURL(result.url).catch(() => {});
          }
        } else {
          notify('本地服务自动重启失败', result.error || '未知错误', '/');
        }
      });
    } else {
      notify('本地服务已停止', '服务进程异常退出，点击查看详情', '/');
    }
  });

  // 最多等 20s，探活通过才算启动成功。
  const deadline = Date.now() + 20000;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const probe = await probeHost({ protocol: 'http', address: '127.0.0.1', port });
    if (probe.ok) {
      service.logged = true;
      const baseUrl = `http://127.0.0.1:${port}`;
      // 登录态注入必须在 loadURL 之前完成，保证渲染进程首屏即免密。
      notificationBridge.injectLocalSessionLocally(baseUrl, localSecret);
      return { ok: true, url: baseUrl };
    }
    if (Date.now() > deadline) {
      stopLocalService();
      return { ok: false, error: '内嵌服务启动超时（20s）' };
    }
  }
}

function stopLocalService() {
  if (localService && !localService.killed) {
    localService.kill();
  }
  localService = null;
}

// ---------------------------------------------------------------------------
// 通知：macOS 走 Notification Center（经 Electron Notification API），
// Windows 走系统 Toast。应用完全退出后自然不再产生任何通知。
// route 为可选 Web 路由（如 /sms、/devices），点击通知时聚焦窗口并跳转。
// ---------------------------------------------------------------------------
function notify(title, body, route) {
  const { Notification } = require('electron');
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body, silent: false });
  notification.on('click', () => focusAndNavigate(route));
  notification.show();
}

// 聚焦主窗口并按事件携带的路由跳转（PRD D6 交互逻辑）。
function focusAndNavigate(route) {
  showMainWindow();
  if (!route) return;
  const navigation = `(function () {
    if (window.location.pathname !== ${JSON.stringify(route)}) {
      history.pushState(null, '', ${JSON.stringify(route)});
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    }
  })()`;
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
    mainWindow.webContents.executeJavaScript(navigation).catch((err) => {
      // 页面仍在加载时导航失败可接受：通知点击已聚焦窗口。
      console.warn('[vocat-desktop] 通知路由跳转失败:', err.message);
    });
  }
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------
// 保存窗口位置/大小（防抖 400ms，PRD D1）。
function rememberWindowBounds() {
  if (boundsSaveTimer) return;
  boundsSaveTimer = setTimeout(() => {
    boundsSaveTimer = null;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const settings = loadSettings();
    if (settings.windowBounds && mainWindow.isMaximized()) return; // 最大化状态不覆盖记忆
    const bounds = mainWindow.getBounds();
    // 稀疏校验：尺寸非法或完全越出屏幕（显示器被拔除）时不记忆，回到默认布局。
    if (bounds.x < -10000 || bounds.y < -10000 || bounds.width < 400 || bounds.height < 300) return;
    saveSettings({ windowBounds: bounds });
  }, 400);
}

function createMainWindow() {
  const remembered = loadSettings().windowBounds;
  const defaults = {
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
  };
  mainWindow = new BrowserWindow({
    ...defaults,
    ...(remembered ? { x: remembered.x, y: remembered.y, width: remembered.width, height: remembered.height } : {}),
    title: APP_NAME,
    autoHideMenuBar: false,
    backgroundColor: '#171717',
    icon: trayIconImage(),
    webPreferences: {
      // PRD D9：注入只读的平台能力常量（window.__vocatDesktop），
      // 供 VoCat Web 界面渲染"当前平台不可用"降级提示。
      preload: path.join(__dirname, 'desktop-globals.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // PRD D1：跨会话记忆窗口位置与大小（拖动/缩放期间防抖落盘）。
  mainWindow.on('resize', rememberWindowBounds);
  mainWindow.on('move', rememberWindowBounds);

  const settings = loadSettings();
  const target = resolveDefaultTarget(settings);
  if (target && target.host.mode === 'local') {
    // 本地一体：先拉起内嵌服务拿到可用端口，再加载回环地址。
    void startLocalService(target.host).then((result) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(result.ok ? result.url : `file://${path.join(__dirname, 'renderer', 'connect.html')}`);
      }
      restartBridgeForHost(target.host);
      refreshTrayMenu();
    });
  } else if (target) {
    mainWindow.loadURL(target.url);
    restartBridgeForHost(target.host);
  } else {
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'connect.html'));
    notificationBridge.stop();
  }

  // 窗口内打开外部链接一律走系统浏览器，避免远程页面在应用内弹新窗口。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('close', (event) => {
    if (!app.isQuiting && loadSettings().closeToTray) {
      // 关闭 = 最小化到托盘，符合 D1 交互逻辑。
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  mainWindow.show();
  mainWindow.focus();
}

// 设置窗口：原生 HTML 表单管理主机（连接管理 D2），凭据经主进程密文写入。
function createSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 720,
    height: 640,
    parent: mainWindow,
    modal: false,
    title: `${APP_NAME} · 设置`,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    backgroundColor: '#171717',
  });
  settingsWindow.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

// ---------------------------------------------------------------------------
// 托盘
// ---------------------------------------------------------------------------
// 用内联 SVG 生成品牌托盘图标（不带文字，主题无关的紫色方块 + V）。
function trayIconImage() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <rect width="32" height="32" rx="7" fill="#4B3FE3"/>
    <path d="M8 12 L16 22 L24 12 L24 9 L16 19 L8 9 Z" fill="#FFFFFF"/>
  </svg>`;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

function createTray() {
  const icon = trayIconImage();
  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);
  refreshTrayMenu();

  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.hide() : showMainWindow();
    } else {
      createMainWindow();
    }
  });
}

async function refreshTrayMenu() {
  if (!tray) return;
  const settings = loadSettings();
  const current = resolveDefaultTarget(settings);

  const hostItems = settings.hosts.map((host) => ({
    label: `${host.name || host.address}  (${host.mode === 'local' ? '本地' : host.protocol + '://' + host.address + ':' + host.port})`,
    type: 'radio',
    checked: current?.host?.id === host.id,
    click: () => switchToHost(host.id),
  }));

  let localServiceItem = [];
  const localHost = settings.hosts.find((host) => host.mode === 'local');
  if (localHost) {
    localServiceItem = [
      { type: 'separator' },
      {
        label: localService && !localService.killed ? '停止本地服务' : '启动本地服务',
        click: () => {
          if (localService && !localService.killed) {
            stopLocalService();
            notify('本地服务已停止', '已停止本机内嵌服务');
          } else {
            void startLocalService(localHost).then((result) => {
              if (result.ok) switchToHost(localHost.id);
              else notify('本地服务启动失败', result.error || '未知错误');
            });
          }
        },
      },
    ];
  }

  const menu = Menu.buildFromTemplate([
    { label: '打开工作台', click: () => showMainWindow() },
    { type: 'separator' },
    { label: '切换主机', enabled: hostItems.length > 0, submenu: hostItems },
    ...localServiceItem,
    { type: 'separator' },
    {
      label: '主机与设置…',
      click: () => createSettingsWindow(),
    },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: settings.autoLaunch,
      click: (item) => setAutoLaunch(item.checked),
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.isQuiting = true;
        stopLocalService();
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

function switchToHost(hostId) {
  const settings = loadSettings();
  const host = findHost(settings, hostId);
  if (!host) return;
  saveSettings({ defaultHostId: hostId });
  const open = () => {
    if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
    else mainWindow.loadURL(host.mode === 'local' ? `http://127.0.0.1:${host.port}` : hostBaseUrl(host));
    showMainWindow();
  };
  restartBridgeForHost(host);
  if (host.mode === 'local') {
    void startLocalService(host).then((result) => {
      if (result.ok) open();
      else notify('本地服务启动失败', result.error || '未知错误');
    });
  } else {
    open();
  }
  refreshTrayMenu();
}

// ---------------------------------------------------------------------------
// 通知桥管理（PRD D6）：跟随当前默认主机启动/切换/停止事件轮询。
// ---------------------------------------------------------------------------
function startBridgeForHost(host) {
  const settings = loadSettings();
  const enabled = settings.notificationsEnabled !== false;
  const target =
    host.mode === 'local'
      ? { baseUrl: `http://127.0.0.1:${host.port}`, local: true }
      : { baseUrl: hostBaseUrl(host), local: false };
  notificationBridge.start(target, enabled);
}

function restartBridgeForDefault() {
  const settings = loadSettings();
  const target = resolveDefaultTarget(settings);
  if (!target) {
    notificationBridge.stop();
    return;
  }
  startBridgeForHost(target.host);
}

// ---------------------------------------------------------------------------
// 开机自启：macOS Login Items / Windows 启动项（Electron 原生封装）。
// 安装时默认关闭，用户显式开启（D7）。
// 注意：开发模式（未被打包）时 getLoginItemSettings 指向 electron 二进制，
// 打包后指向 app 自身，行为符合预期。
// ---------------------------------------------------------------------------
function setAutoLaunch(enabled) {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    // 自启时以 --hidden 静默启动到托盘，不弹出主窗口（D7）。
    args: enabled ? ['--hidden'] : [],
  });
  saveSettings({ autoLaunch: enabled });
}

// 是否处于"开机自启"静默启动场景：Windows 看 --hidden 参数（自启项传入），
// macOS 走 Login Items 的 wasOpenedAtLogin。命中的时候只建托盘不建窗口。
function isSilentStartup() {
  if (PLATFORM === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin) return true;
  return process.argv.includes('--hidden');
}

// ---------------------------------------------------------------------------
// IPC：设置窗口 <-> 主进程
// ---------------------------------------------------------------------------
ipcMain.handle('settings:load', () => {
  const settings = loadSettings();
  return {
    ...settings,
    hosts: settings.hosts.map((host) => ({
      ...host,
      // 不回传明文凭证；仅回传"是否已存凭证"供 UI 显示。
      credential: undefined,
      hasCredential: host.credential !== '',
    })),
    platform: PLATFORM,
    version: app.getVersion(),
    linuxOnlyCapabilities: LINUX_ONLY_CAPABILITIES,
    credentialStorageUsable: isCredentialStorageUsable(),
  };
});

ipcMain.handle('settings:save-host', (_event, rawHost) => {
  const settings = loadSettings();
  const normalized = normalizeHost({ ...rawHost, id: rawHost.id });
  const index = settings.hosts.findIndex((host) => host.id === normalized.id);
  if (index >= 0) settings.hosts[index] = normalized;
  else settings.hosts.push(normalized);
  if (!settings.defaultHostId) settings.defaultHostId = normalized.id;
  saveSettings({ hosts: settings.hosts, defaultHostId: settings.defaultHostId });
  refreshTrayMenu();
  restartBridgeForDefault();
  return { ok: true, host: { ...normalized, credential: undefined, hasCredential: normalized.credential !== '' } };
});

ipcMain.handle('settings:delete-host', (_event, hostId) => {
  const settings = loadSettings();
  settings.hosts = settings.hosts.filter((host) => host.id !== hostId);
  if (settings.defaultHostId === hostId) settings.defaultHostId = settings.hosts[0]?.id || '';
  saveSettings({ hosts: settings.hosts, defaultHostId: settings.defaultHostId });
  refreshTrayMenu();
  restartBridgeForDefault();
  return { ok: true };
});

ipcMain.handle('settings:set-default-host', (_event, hostId) => {
  saveSettings({ defaultHostId: hostId });
  refreshTrayMenu();
  restartBridgeForDefault();
  return { ok: true };
});

ipcMain.handle('settings:set-auto-launch', (_event, enabled) => {
  setAutoLaunch(!!enabled);
  return { ok: true };
});

ipcMain.handle('settings:set-close-to-tray', (_event, enabled) => {
  saveSettings({ closeToTray: !!enabled });
  return { ok: true };
});

ipcMain.handle('settings:set-notifications-enabled', (_event, enabled) => {
  const next = enabled !== false;
  saveSettings({ notificationsEnabled: next });
  notificationBridge.setNotificationsEnabled(next);
  return { ok: true, enabled: next };
});

ipcMain.handle('settings:probe-host', (_event, rawHost) => {
  const host = normalizeHost(rawHost);
  return probeHost(host);
});

ipcMain.handle('settings:decrypt-for-local', () => {
  // 本地一体模式的免密会话由主进程在拉起服务时通过一次性随机口令完成，
  // 渲染进程无需接触任何密钥材料。
  return { implemented: true };
});

// ---------------------------------------------------------------------------
// 更新（PRD D8）：检查 GitHub Releases 最新版 → 下载安装包 → 系统安装引导。
// ---------------------------------------------------------------------------
ipcMain.handle('settings:check-update', async () => {
  if (updateInFlight) {
    return { ok: false, error: '已有更新操作进行中，请稍候', retryable: true };
  }
  updateInFlight = true;
  try {
    const result = await updater.checkForUpdates({
      currentVersion: app.getVersion(),
    });
    if (result.ok && result.updateAvailable && !result.assetAvailable) {
      result.notes = (result.notes || '') + '\n\n提示：当前平台暂无安装包，请访问 GitHub Releases 手动下载。';
      result.releaseUrl = `https://github.com/${updater.DEFAULT_REPO}/releases/latest`;
    }
    return result;
  } finally {
    updateInFlight = false;
  }
});

ipcMain.handle('settings:download-update', async (event, asset) => {
  if (!asset || typeof asset.url !== 'string' || typeof asset.name !== 'string') {
    return { ok: false, error: '无效的更新资源' };
  }
  if (updateInFlight) {
    return { ok: false, error: '已有更新操作进行中，请稍候', retryable: true };
  }
  updateInFlight = true;
  const report = (progress) => {
    if (event && event.sender && !event.sender.isDestroyed()) {
      event.sender.send('update:progress', progress);
    }
  };
  report({ phase: 'downloading', received: 0, total: Number(asset.size) || 0 });
  try {
    const result = await updater.downloadAsset(
      asset.url,
      asset.name,
      updater.defaultDestDir(),
      (received, total) => report({ phase: 'downloading', received, total }),
    );
    report({ phase: 'done', filePath: result.filePath });
    notify('更新下载完成', `安装包已保存到 ${result.filePath}\n即将打开安装程序`, null);
    // 打开安装包交给系统安装（macOS 挂载 dmg / Windows 启动 NSIS 安装器）。
    setTimeout(async () => {
      const error = await shell.openPath(result.filePath);
      if (error) shell.showItemInFolder(result.filePath);
    }, 800);
    return { ok: true, filePath: result.filePath };
  } catch (err) {
    report({ phase: 'failed', error: err.message });
    return { ok: false, error: err.message };
  } finally {
    updateInFlight = false;
  }
});

// ---------------------------------------------------------------------------
// 应用生命周期
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  app.isQuiting = false;
  ensureSettings();
  createTray();
  // 通知桥独立于窗口：开机自启静默场景下后台继续接收新短信/设备事件。
  restartBridgeForDefault();
  if (!isSilentStartup()) {
    createMainWindow();
  } else {
    console.log('[vocat-desktop] 开机自启：静默启动到托盘');
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    else showMainWindow();
  });
});

app.on('second-instance', () => {
  showMainWindow();
});

app.on('before-quit', () => {
  app.isQuiting = true;
  // 冲刷防抖中的窗口位置记忆，避免退出前最后一次移动丢失。
  if (boundsSaveTimer) {
    clearTimeout(boundsSaveTimer);
    boundsSaveTimer = null;
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isMaximized()) {
      saveSettings({ windowBounds: mainWindow.getBounds() });
    }
  }
  notificationBridge.stop();
  stopLocalService();
});

app.on('window-all-closed', () => {
  // 托盘常驻型应用：关闭全部窗口不退出（仅 macOS 惯例，Windows 同理适用
  // 因为我们有托盘；用户通过托盘菜单"退出"真正结束进程）。
  if (PLATFORM === 'darwin') {
    // 保持托盘常驻。
  }
});

// 安全加固：任何窗口（含远程页面）内打开外部链接一律走系统浏览器。
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
});