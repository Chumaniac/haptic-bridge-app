# 第三方组件

依赖版本及完整性由package-lock.json锁定。分发时保留依赖自带LICENSE。

- @zendrex/buttplug.js 0.5.0 — MIT — https://github.com/Zendrex/buttplug.js 。实际运行的TypeScript v4客户端。
- Zod 4.6.7 — MIT — https://github.com/colinhacks/zod 。从4.4.3更新，避免GHSA-mrhx-c7xc-m3w5所列已知内存耗尽风险。https://github.com/advisories/GHSA-mrhx-c7xc-m3w5
- Emittery — MIT — https://github.com/sindresorhus/emittery 。客户端的传递依赖。
- TypeScript、Node类型、ws及其类型、Playwright为开发/验证依赖，各自许可保留于node_modules。
- Buttplug — BSD-3-Clause — https://github.com/buttplugio/buttplug 。公开协议与设备资料来源。
- Intiface Central — GPLv3/Commercial — https://github.com/intiface/intiface-central 。用户独立安装的连接程序，本项目未复制、修改或打包其完整应用。
- REA — MIT — https://github.com/morluto/rea 。本轮仅审阅公开工具说明，未作为依赖安装。
- Intiface Engine 5.0.4 — BSD-3-Clause — https://github.com/buttplugio/buttplug/releases/tag/intiface-engine-5.0.4 。用于项目隔离的真实组件互通，原生程序未纳入源码分发。
- buttplug Python 1.0.0 — BSD-3-Clause — https://github.com/buttplugio/buttplug-py 。项目隔离客户端与上游消息测试，依赖许可证保留在.tools虚拟环境。

## 独立用户版的运行包

源代码仓库本身不包含依赖可执行文件或用户数据。构建器在组装实际运行包时附带相关许可：

- Node.js 可执行文件的完整许可从实际所用的官方安装中提取为 bin/NODE-LICENSE.txt；生产 node_modules 内保留每个依赖的许可文件和 package.json。

模型、数据集、Intiface 应用不在运行包中。借鉴来源和未复制的实现见 docs/references.md。
