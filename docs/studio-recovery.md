# 模式库备份、迁移与显式恢复

Studio只保存模式和偏好，不保存会话、控制权、连接、启用、输出或播放。恢复文件不会启动设备或继续播放；当前验收仅虚拟设备。

## 数据位置与旧路径

原生.app入口使用 `~/Library/Application Support/HapticBridge/studio.json`。开发CLI默认仍用工作目录 `.local/studio.json`，可用绝对路径 `HB_STUDIO_FILE` 指定独立库。两个仓库属于同一产品，不要启动多个服务写同一配置。

源码链接的旧桌面入口曾把资料留在仓库 `.local`；若新目标尚不存在、声明的旧路径有文件，启动会拒绝把它当成空库。先正常退出所有实例，保留原件，再用下方工具验证并恢复到新的用户目录。程序不自动移动、清空或覆盖旧资料。原已使用Application Support的独立桌面版继续原位置。

## 保存语义

每次保存先保留上一有效修订为 `studio.json.previous`，带格式版本、规范化SHA-256和完整模式/偏好。只有一份上一修订，不是无限历史；首次保存前的回退点可能只是默认库，未保存草稿不在承诺中。快照与当前文件均有大小、schema、无链接和读取变化检查。

保存使用本机独占写标记并检查磁盘身份/修订，其他进程的变化不会被当成同一旧版本继续写。正常保存后释放标记；崩溃可能留下 `.write-lock`。此时保留文件和锁，退出全部实例并先核对，再从已验证的源恢复到一个新文件。不会通过自动删未知锁或重置配置“修好”。这不是任意同用户恶意进程的沙箱，也不是跨进程协同编辑协议。

若已经发布新文件而后续磁盘确认失败，会报告 `STORAGE_UNCONFIRMED`，内存修订与写入版本对齐；先重新读取核对，不能据失败提示重复保存。发布前失败保留原当前文件，旧恢复材料不自动删除。

## 恢复到新文件

在Node24源码环境先构建。输入可为有效 `.previous`、当前Persisted文件或导出的模式库；带校验的恢复文件必须先通过摘要，原始导出只有schema验证，不认证来源。

```sh
npm run build
npm run studio:recover -- \
  --source /absolute/private/studio.json.previous \
  --output /absolute/private/recovered-studio.json
HB_STUDIO_FILE=/absolute/private/recovered-studio.json npm run start:studio
```

输出文件必须不存在。恢复只创建新文件并返回修订、数量和摘要，不打印模式内容，不覆盖损坏原件，不拷贝锁。选择哪个回退点、是否切换和何时归档，由用户明确决定。锁存在但当前文件仍有效时，也可用当前文件作恢复源；不要为恢复而自动重放导入或播放。

独立macOS应用也包含相同编译入口，可使用其自带Node（将应用路径替换为实际位置）：

```sh
HB_RUNTIME_DIR="/Applications/Haptic Bridge.app/Contents/Resources/runtime"
"$HB_RUNTIME_DIR/bin/node" "$HB_RUNTIME_DIR/app/dist/src/studio/recovery.js" \
  --source /absolute/private/studio.json.previous \
  --output /absolute/private/recovered-studio.json
```

该入口属于本轮源码/后续重建制品，旧版下载不自动获得功能。备份含私人模式，禁止提交Issue或公开同步；使用独立加密备份。文件/目录同步改善中断恢复条件，但不保证介质损坏或断电零丢失；Windows目录同步和权限依赖平台能力。校验和不等于发行签名、Apple公证或硬件验收。
