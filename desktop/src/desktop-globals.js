'use strict';

// VoCat 桌面端 · 平台能力注入（PRD D9）
//
// 主窗口加载的 VoCat Web 界面通过 window.__vocatDesktop 读取桌面端能力
// 矩阵，实现"平台不可用"项的降级展示（例如大疆 QMI 绑定修复、udev、
// uevent 热插拔在 macOS/Windows 上不可用，点击引导"请将模块接入 Linux
// 主机"）。原生 Web 部署（无桌面壳）时该常量不存在，界面保持全功能。
//
// 安全基线：本脚本只暴露只读常量，不开放任何 IPC/主进程能力；不注入
// 凭证、令牌或可执行回调。

const { contextBridge } = require('electron');

const platform = process.platform; // 'darwin' | 'win32' | 'linux'
const isLinux = platform === 'linux';

contextBridge.exposeInMainWorld('__vocatDesktop', {
  platform,
  // 与 docs/DJI_4G_FEATURES_PRD.md 的 F10 能力矩阵保持一致。
  linuxOnlyCapabilities: ['dji_qmi_repair', 'udev', 'uevent_hotplug', 'latency_probe'],
  capabilities: {
    djiQmiRepair: isLinux,
    udev: isLinux,
    ueventHotplug: isLinux,
    latencyProbe: isLinux,
  },
});