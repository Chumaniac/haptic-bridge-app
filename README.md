# Haptic Bridge · 独立用户版

在本机编辑、预览并保存有明确时长与强度边界的触觉模式。

可视化时间线、版本冲突保护、显式启用和急停。输出控制与编辑分离，断连不会恢复启用。Studio 始终明确标注两个虚拟设备。

这是包含完整可构建源码的社区用户仓库，不依赖原私有仓库。旧仓库的提交历史、用户数据、模型缓存和内部验收记录不在这里。

## 开始使用

前提：Node 24、npm。实体设备另需用户自行安装 Intiface Central；本版不捆绑它。

```sh
git clone https://github.com/Chumaniac/haptic-bridge-app.git
cd haptic-bridge-app
npm ci
npm run build
HB_STUDIO_FILE="$HOME/Library/Application Support/HapticBridge/studio.json" npm run start:studio
```

浏览器只连接本机回环地址。桌面版下载与系统支持以 [Releases](https://github.com/Chumaniac/haptic-bridge-app/releases) 的实际资产为准；没有对应资产时从源码安装。桌面构建方式见 [构建说明](docs/build.md)。

## 用一次完整流程

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
