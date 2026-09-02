# 大疆 4G 模块（一代）接入 VoCat 部署指南

适用范围：大疆 4G 模块一代（USB `2ca3:4006`，即 DJI Cellular 模块 / 4G 图传模块一代）。从 2026-09 起 VoCat 为该模块提供自动 USB 绑定修复、设备健康卡片与链路诊断。

## 1. 原理一句话

模块内是移远 Quectel EG25-G（QDC507，高通 MDM9x07）级别的调制解调器，本体没有可运行 VoCat 的用户态系统。VOcat 运行在模块接入的 Linux 主机（路由器 / NAS / 软路由）上，通过 USB 上的 AT 串口与 QMI 控制通道管理模块。社区常说的"刷机"其实只是改 USB 身份，本方案保持出厂 `2ca3:4006` 不变。

## 2. 接线

1. 给模块装入 nano-SIM 卡（不支持 eSIM，物理卡必须已取消 PIN）。
2. 模块通过 USB（官方线或 USB-A 转接头）接入宿主的 USB 口。
3. 上电后确认系统能看到设备：

   ```bash
   lsusb | grep -i 2ca3
   # Bus 001 Device 003: ID 2ca3:4006
   ```

## 3. 安装 VoCat

任意 Linux 发行版（Debian/Ubuntu 一键安装会自动装好 libqmi-utils）：

```bash
curl -fsSL https://raw.githubusercontent.com/MengMengCode/VoCat/master/scripts/install.sh | bash
```

OpenWrt / Kwrt 路由器的安装与部署同样由该脚本处理（procd 服务）。安装完成后访问 `http://<主机IP>:7575`，用首次生成的随机管理员密码登录。

## 4. 验证自动修复（自愈）

VoCat 启动时会执行一次发现；若模块的 AT/QMI 驱动绑定缺失（冷启动或重连后常见），服务会自动把 0-3 号接口绑回 `option`、4 号接口绑回 `qmi_wwan` 并唤醒 QMI，全程不写 NV、不改 USB 身份。可用下面的命令人工复核当前绑定：

```bash
for i in 0 1 2 3 4; do
  d=/sys/bus/usb/devices/*:1.$i
  [ -d $d ] && echo "1.$i -> $(basename $(readlink $d/driver))"
done
```

期望输出：`1.0-1.3 -> option`，`1.4 -> qmi_wwan`。若不一致，直接运行：

```bash
sudo vocat doctor --repair-dji-qmi
```

设备运行中若因 USBIP 重连等原因掉绑定，VoCat 每 60 秒巡检一次已配置模块的 /dev 节点，缺失即自动重扫并触发修复；热插拔事件（开机后新增 uevent 监听）也会触发同样流程。也可以随时在设备详情页的"DJI 4G 模块 USB 组态"卡片点"修复 DJI QMI 绑定"。

## 5. 添加设备

1. 顶部进入「设备管理」→「添加设备」。
2. 列表里应出现 `DJI 4G Module (Quectel EG25-G)`（若显示 "Android/Android"，仍可识别为该模块，身份已归一化）。
3. 若该行显示降级提示，点"修复 DJI QMI 绑定"，等待成功后再选中。
4. 选择设备类型「大疆 4G 模块（移远芯片）」，填 ID 与名称，保存。

## 6. 收短信 / 转发告警

SMS 不依赖数据连接：

1. 设备详情页确认 SIM 状态已同步。
2. 「设置」→「通知」配置 Telegram / Bark / Email / 企业微信等接收渠道。
3. 收到短信后，VoCat 会把每条短信作为独立通知转发。

## 7. 拨号上网（数据连接）

1. 设备详情页 → 网络设置，确认 APN 与运营商要求一致（物联网卡可能被运营商限速或拒绝，建议用普通上网卡）。
2. 打开"数据网络"开关。若 `wwan0` 仍为 DOWN，"DJI 4G 模块 USB 组态"卡片会显示拨号引导提示（该提示不依赖数据连接，SMS 照常工作）。
3. 验证链路：设备详情页 →「延迟诊断」，选择默认目标 `223.5.5.5:53`，观察 min/avg/max 与丢包。

## 8. 常见问题

| 现象 | 处理 |
| --- | --- |
| 添加设备列表里模块行显示"at_port_missing" | 先点行内"修复 DJI QMI 绑定"，或用 `sudo vocat doctor --repair-dji-qmi` 后再扫描 |
| 设备页健康卡片显示"组态异常" | 对照 §4 查看各接口驱动；`1.2` 缺 ttyUSB、`1.4` 缺 cdc-wdm 时修复按钮重跑一次即可 |
| qmicli 缺失 | 安装系统源里的 libqmi-utils（Debian/Ubuntu）或 qmi-utils（OpenWrt/Alpine）后重试 |
| 非 root 运行 | 修复需要 root：systemd/procd 服务默认以 root 运行；手动运行时用 sudo |
| 数据连不上 | 检查 APN、运营商漫游限制、信号强度（设备页可看 RSRP/RSRQ/SINR） |

## 9. 安全与红线

- 所有自动修复与健康检查均不写 NV 内存、不执行 `AT+QCFG="usbcfg"/"usbnet"` 改写，USB 身份保持出厂 `2ca3:4006`。
- 模块不支持 eSIM，卡片策略请基于物理 SIM 配置。
- 若宿主同时运行 ModemManager，修复可能与之竞争接口绑定；不推荐两者同时接管同一模块。

### 9.1 社区"彻底改装"路线与本方案的区别

社区教程（36kr / 搜狐等 2026-08 报道）普遍走两条"彻底改装"路线，**本方案均不采用**，原因如下：

| 社区路线 | 操作 | 后果 | 本方案为什么不做 |
| --- | --- | --- | --- |
| 切 usbnet | 电脑串口工具（如 LLCOM）连 `Quectel USB AT Port`，发 `AT+QCFG="usbnet",1` 后重启模块 | 模块以 `rndis/ecm` 形式枚举，Windows/macOS/iPad 免驱直认网卡 | 改写后 QMI 接口消失，VoCat 无法再走 QMI 控制通道；且属持久性 NV 改写，如需恢复要再发 `AT+QCFG="usbnet",0`，误操作有变砖风险 |
| 改 USB ID | 通过 AT/DFU 改写 VID:PID（如改成 2c7c:0125） | 摆脱大疆专有枚举，通用 Quectel 驱动直认 | 同样改变出厂身份且不可无痕回退；VoCat 的 `2ca3:4006` 自动修复依赖出厂 ID |

本方案保持模块出厂 `2ca3:4006` 不变，只在 Linux 宿主侧做 driver 绑定修复（0-3 → `option`，4 → `qmi_wwan`），Windows/macOS 用户如想直连 iPad/MacBook，仍可自行按社区路线改装，改装后 VoCat 的 DJI 模块功能不再适用，但模块本身作为普通 USB 网卡使用不受影响。