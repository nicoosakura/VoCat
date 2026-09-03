'use strict';

// VoCat 桌面控制端 · 预加载脚本（仅用于设置窗口）
//
// 安全基线：contextIsolation + sandbox，渲染进程只能通过本桥接访问主进程
// 暴露的最小能力面。日志/密码/会话材料一律不出主进程边界。

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vocat', {
  platform: process.platform,
  linuxOnlyCapabilities: ['dji_qmi_repair', 'udev', 'uevent_hotplug'],

  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveHost: (host) => ipcRenderer.invoke('settings:save-host', host),
  deleteHost: (hostId) => ipcRenderer.invoke('settings:delete-host', hostId),
  setDefaultHost: (hostId) => ipcRenderer.invoke('settings:set-default-host', hostId),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('settings:set-auto-launch', enabled),
  setCloseToTray: (enabled) => ipcRenderer.invoke('settings:set-close-to-tray', enabled),
  probeHost: (host) => ipcRenderer.invoke('settings:probe-host', host),
});