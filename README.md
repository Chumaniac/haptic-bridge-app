<img src="browser/haptic.svg" width="56" height="56" alt="" />

# Haptic Bridge

[![Build](https://github.com/Chumaniac/haptic-bridge-app/actions/workflows/user-edition.yml/badge.svg?branch=main)](https://github.com/Chumaniac/haptic-bridge-app/actions/workflows/user-edition.yml) [![License](https://img.shields.io/badge/license-MIT-555)](LICENSE)

把触觉模式拆成强度和时长，先看波形，再决定如何播放。

[在线试用](https://chumaniac.github.io/haptic-bridge-app/) · [桌面下载](https://github.com/Chumaniac/haptic-bridge-app/releases)

浏览器编辑器可以调整四个阶段和周期数。预览、校验和计算都在当前页面完成。

## 核心功能

- 修改各阶段的强度与时长，按比例绘制阶梯波形。
- 比较单个周期与完整模式的时间，校验时长上限。
- 在本机 Studio 保存模式，用虚拟设备演练播放与停止。

## 本机快速开始

前提：Node 24、npm。实体设备另需用户自行安装 Intiface Central；本版不捆绑它。

```sh
git clone https://github.com/Chumaniac/haptic-bridge-app.git
cd haptic-bridge-app
npm ci
npm run build
HB_STUDIO_FILE="$HOME/Library/Application Support/HapticBridge/studio.json" npm run start:studio
```

浏览器只连接本机回环地址。桌面版下载与系统支持以 [Releases](https://github.com/Chumaniac/haptic-bridge-app/releases) 的实际资产为准；没有对应资产时从源码安装。桌面构建方式见 [构建说明](docs/build.md)。

## 操作步骤

编辑模式 → 连接虚拟设备 → 获取控制权并启用 → 播放/暂停/取消 → 保存或导出模式库

1. 启动 Studio，先在模式编辑器修改步骤、强度和时长；时间线按相对时长显示。保存与播放是独立操作。
2. 选择虚拟设备，获取控制权、连接并显式启用后才能播放。取消、急停、断连都应清除在途输出，重新连接后需要再次启用。
3. 保存模式，或导出模式库 JSON。导入先校验并预览，再确认替换；版本冲突时重新读取，不能用旧版本覆盖新编辑。

```sh
npm run start
# 原始 Console：仅显式连接 Intiface；不要把 Studio 虚拟设备当成硬件验收。
```

## 保存与边界

独立桌面版固定使用 ~/Library/Application Support/HapticBridge/studio.json。CLI 可用 HB_STUDIO_FILE 指定绝对路径；未指定时保留源码开发模式 .local/studio.json。控制权、启用状态、播放状态与会话不会落盘。

Studio 只有两个虚拟设备。原始 Console 提供单独的 Intiface 接口；真实设备能力、厂商授权、兑换码和远程接口不能由虚拟演示推定可用。模式库最多20个模式、每个64步、总时长10分钟；导入文件上限128 KiB。

- [完整使用说明](docs/user-guide.md)
- [隐私、备份与恢复](docs/privacy.md)
- [排错与环境检查](docs/troubleshooting.md)
- [已验证范围](docs/verification.md)
- [参考项目与许可](docs/references.md)

许可证见 [LICENSE](LICENSE)，第三方资料见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 常见问题

**网页会让设备振动吗？** 网页只绘制信号。完整本机控制台的设备连接和配置要求见[使用指南](docs/user-guide.md)。

[参与贡献](CONTRIBUTING.md)

## Android 波形参数

「导出 Android 波形参数」下载当前编辑值。JSON 内的 timings（毫秒）、amplitudes（0–255）和 repeat 可用于 Android API 26+ 的 VibrationEffect.createWaveform。有限周期已经展开，repeat 固定为 −1。此操作只生成文件。
