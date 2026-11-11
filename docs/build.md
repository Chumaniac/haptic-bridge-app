# 构建 Haptic Bridge 独立程序

macOS 桌面构建需要 macOS 13+ 与 Xcode Command Line Tools。当前实际分发目标是 Apple Silicon；没有声称已提供 Intel 或 Windows 桌面安装包。源码和安装包分开，程序包内含运行文件，私人数据保存在用户目录。

## 编译源码

前提：Node 24、npm。实体设备另需用户自行安装 Intiface Central；本版不捆绑它。

```sh
npm ci
npm run build
```

## 准备运行时

先完成上面的源码编译，再组装新运行目录：

```sh
python3 desktop/prepare_runtime.py --output /tmp/new-runtime
```

构建器复制当前 Node 24 可执行文件及其许可，并从 package-lock.json 安装生产依赖，不复制开发 node_modules。

## 打包与验证

```sh
python3 desktop/build_app.py --runtime /tmp/new-runtime --output /tmp/new-apps
```

两个输出目录必须不存在；构建不覆盖旧安装或数据。正式构建要求 Git 干净，运行清单绑定当前提交；本地未提交预览需显式 --preview。

程序包包含「帮助 → 使用指南」，可以离线查看操作步骤和存储位置。复制到新目录后，用最小运行环境启动，检查源码目录不在运行依赖内；桌面与390px窄屏分别核对。测试报告、模型效果和实体设备验收单独记录。

源码检查：

```sh
npm run check
npm test
npm run test:studio:browser
npm run test:studio:resources
```

本地构建仅作临时签名；没有 Apple 开发者签名/公证承诺。发布需附运行时版本、源码提交与 SHA-256 校验和，第三方许可随实际运行包一起保留。

如果 Node 安装方式没有在标准位置保存完整许可，可给 prepare_runtime.py 传入 --node-license /path/to/official/NODE-LICENSE.txt，文件必须对应实际运行时版本。
