# VoCat 桌面控制端（macOS / Windows）

VoCat 的原生桌面控制端，覆盖**远程管理**与**本地一体**两种运行形态，完整复用现有 Web 功能。需求基线见 `docs/DESKTOP_APP_PRD.md`。

## 工程结构

```
desktop/
├── package.json            # Electron + electron-builder 工程
├── electron-builder.yml    # macOS(.dmg) / Windows(NSIS) 双平台打包
├── build/entitlements.mac.plist
├── src/
│   ├── main.js             # 主进程：单实例/窗口/托盘/主机配置/本地服务/通知/自启
│   ├── preload.js          # 设置窗口最小 IPC 桥接（安全基线）
│   └── renderer/           # 设置窗口原生 HTML 界面 + 无主机起始页
└── resources/services/     # 内嵌 Go 服务二进制（本地一体模式，交叉编译产物）
```

## 前置

- Node.js ≥ 20、npm ≥ 10
- Go ≥ 1.25（仅构建内嵌服务时需要）

## 开发运行

```bash
cd desktop
npm ci
npm start          # 启动 Electron（开发态）
```

首次运行给文件设置可执行权限（macOS/Windows 无此问题）：

```bash
chmod +x resources/services/*/vocat 2>/dev/null || true
```

## 内嵌服务交叉编译

```bash
npm run build:go   # darwin arm64 + amd64 + win32 x64 三份二进制
```

产物放入 `resources/services/{darwin-arm64,darwin-amd64,win32-x64}/`，随 electron-builder 一并入包（`extraResources`）。

## 双平台打包

```bash
npm run dist:mac    # .dmg（需 macOS 上执行；签名公证见下）
npm run dist:win    # NSIS .exe（可在任意平台交叉构建）
```

产物在 `desktop/release/`。

### macOS 签名与公证（正式分发必需）

1. 提供 Developer ID Application 证书，electron-builder 通过 `CSC_LINK` / `CSC_KEY_PASSWORD` 读取。
2. 公证：`electron-builder --mac --publish never` 时设置 `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`，electron-builder 会执行 notarytool 公证并 stapling。
3. CI（GitHub Actions）示例模板见仓库 `.github/`，第一期尚未接通，建议在 PRD 三期前就位。

### Windows 签名

提供 Authenticode 证书（`CSC_LINK` / `CSC_KEY_PASSWORD`），`nsis` 目标会自动签名；无证书时产物为未签名 exe，SmartScreen 会提示。

## 运行形态说明

- **远程管理**：设置中添加远程主机（协议/地址/端口/可选凭证），桌面端内嵌窗口加载该主机并走 Web 登录；凭证以系统钥匙串密文保存（macOS SafeStorage→Keychain，Windows→DPAPI）。
- **本地一体**：添加"本地一体"主机，主进程拉起内嵌 Go 服务（只监听 `127.0.0.1` 随机端口），探活通过后加载工作台。Linux 专属能力（DJI QMI 绑定修复、udev、uevent 热插拔）在 macOS/Windows 上按平台降级提示，界面不误导。
- **开机自启**：开启后登录时静默启动到托盘（不弹窗口），后台继续接收新短信/设备通知；点击托盘图标唤起工作台。主窗口位置与大小跨会话记忆。
- **桌面通知**：通知桥独立于窗口运行，新短信/设备掉线经系统通知推送，点击通知直达对应页面；设置中可整体关闭。

## 验证

```bash
npm run gen:icon   # 从 SVG 生成应用图标
npm run check      # node --check 全部 JS 文件
npm test           # 单测（通知桥接 + 更新模块）
```

## 构建流程

```bash
npm run gen:icon              # 生成应用图标
npm run build:go              # 交叉编译内嵌服务（darwin + win）
npm run dist:mac              # .dmg（需 macOS；签名公证见下）
npm run dist:win              # NSIS .exe（可在任意平台交叉构建）
```

## 已知边界

- 托盘图标为内联 SVG 生成的简单品牌图形；正式版应用图标由 `scripts/gen-icon.mjs` 从 `build/icon.svg` 栅格化生成，支持 macOS icns / Windows ico 自动转换。
- macOS 签名+公证与 Windows 代码签名证书需在 CI Secrets 中配置（`CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`），未配置时产出未签名包。