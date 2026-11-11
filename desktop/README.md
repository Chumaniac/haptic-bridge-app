# Haptic Bridge macOS 应用

使用本机 Node 24 先运行 `npm run build`，从干净源码运行 `python3 desktop/build_app.py --output /a/new/output/directory`。双击“Haptic Bridge.app”打开独立 AppKit/WebKit 窗口，无需终端或普通浏览器页。上述不带 `--runtime` 的命令仅生成依赖源码的开发窗口。普通用户请下载本仓库 Releases 的完整程序，已嵌入 Node，无需源码或另装 Node。

窗口使用独立19005端口，完整桌面包固定保存模式库与偏好到 `~/Library/Application Support/HapticBridge/studio.json`；仅未指定 `HB_STUDIO_FILE` 的源码开发模式使用 `.local/studio.json`。现有18766预览不受影响。只有两个固定虚拟设备，不连接硬件、不扫描、不中途恢复启用或输出；获取控制、连接与播放都由用户明确操作。原来的会话、CSRF、同源检查和控制权规则保持有效。

固定浅珊瑚色侧栏提供设备、编辑、资料、偏好和记录入口。Command-S使用现有“保存模式”操作，未保存编辑关闭时确认；退出只停止应用自己启动的后台，触发原有停止和会话回收。模式库与偏好保留，设备输出与会话记录不持久化。

原生检查使用19015端口、独立临时工作目录和非持久 WebKit，不读取正式模式库。构建包不含用户模式、配置或诊断。采用本机临时签名，未作公证发行；软件模拟验收不代表物理硬件验收。

完整可移动程序的构建步骤、运行时闭包和许可要求见[构建说明](../docs/build.md)。
