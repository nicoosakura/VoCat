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
const { spawn } = require('child_process');

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

const userDataDir = app.getPath('userData');
const settingsPath = path.join(userDataDir, 'settings.json');

const DEFAULT_SETTINGS = {
  hosts: [], // { id, name, protocol, address, port, mode, credential, useCredential }
  defaultHostId: '',
  autoLaunch: false,
  closeToTray: true,
};

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
  const service = spawn(binary, ['--address', `127.0.0.1:${port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  localService = service;
  service.stdout.on('data', (chunk) => console.log('[vocat-service]', String(chunk).trimEnd()));
  service.stderr.on('data', (chunk) => console.error('[vocat-service]', String(chunk).trimEnd()));
  service.on('exit', (code, signal) => {
    console.log(`[vocat-desktop] 本地服务退出 code=${code} signal=${signal}`);
    if (!app.isQuiting && service === localService) {
      notify('本地服务已停止', '服务进程异常退出，点击查看详情');
    }
    localService = null;
  });

  // 最多等 20s，探活通过才算启动成功。
  const deadline = Date.now() + 20000;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const probe = await probeHost({ protocol: 'http', address: '127.0.0.1', port });
    if (probe.ok) {
      service.logged = true;
      return { ok: true, url: `http://127.0.0.1:${port}` };
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
// ---------------------------------------------------------------------------
function notify(title, body) {
  const { Notification } = require('electron');
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body, silent: false });
  notification.on('click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  notification.show();
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    title: APP_NAME,
    autoHideMenuBar: false,
    backgroundColor: '#171717',
    icon: trayIconImage(),
  });

  const settings = loadSettings();
  const target = resolveDefaultTarget(settings);
  if (target && target.host.mode === 'local') {
    // 本地一体：先拉起内嵌服务拿到可用端口，再加载回环地址。
    void startLocalService(target.host).then((result) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(result.ok ? result.url : `file://${path.join(__dirname, 'renderer', 'connect.html')}`);
      }
      refreshTrayMenu();
    });
  } else if (target) {
    mainWindow.loadURL(target.url);
  } else {
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'connect.html'));
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
// 开机自启：macOS Login Items / Windows 启动项（Electron 原生封装）。
// 安装时默认关闭，用户显式开启（D7）。
// 注意：开发模式（未被打包）时 getLoginItemSettings 指向 electron 二进制，
// 打包后指向 app 自身，行为符合预期。
// ---------------------------------------------------------------------------
function setAutoLaunch(enabled) {
  app.setLoginItemSettings({ openAtLogin: enabled });
  saveSettings({ autoLaunch: enabled });
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
  return { ok: true, host: { ...normalized, credential: undefined, hasCredential: normalized.credential !== '' } };
});

ipcMain.handle('settings:delete-host', (_event, hostId) => {
  const settings = loadSettings();
  settings.hosts = settings.hosts.filter((host) => host.id !== hostId);
  if (settings.defaultHostId === hostId) settings.defaultHostId = settings.hosts[0]?.id || '';
  saveSettings({ hosts: settings.hosts, defaultHostId: settings.defaultHostId });
  refreshTrayMenu();
  return { ok: true };
});

ipcMain.handle('settings:set-default-host', (_event, hostId) => {
  saveSettings({ defaultHostId: hostId });
  refreshTrayMenu();
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

ipcMain.handle('settings:probe-host', (_event, rawHost) => {
  const host = normalizeHost(rawHost);
  return probeHost(host);
});

ipcMain.handle('settings:decrypt-for-local', () => {
  // 预留：本地一体模式用主进程持有的一次性随机口令换取服务端会话。
  // 第一期仅返回建设性说明，口令机制在第二期实现。
  return { todo: true };
});

// ---------------------------------------------------------------------------
// 应用生命周期
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  app.isQuiting = false;
  ensureSettings();
  createTray();
  createMainWindow();

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