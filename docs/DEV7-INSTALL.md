# 下载与安装 dev.7

1. 从 [v0.3.0-dev.7 Release](https://github.com/buruqu/juebot/releases/tag/v0.3.0-dev.7) 下载 [dsh-juebot-0.3.0-dev.7.tgz](https://github.com/buruqu/juebot/releases/download/v0.3.0-dev.7/dsh-juebot-0.3.0-dev.7.tgz)。GitHub Download ZIP 是源码工作区，不是安装包。
2. 核对大小203269字节、SHA-256 `007b7a0297fc9048d1562b5875947c109d97f6fa7ab798a17f649a76f7dca1ca`。
3. 通过兼容 DSH 的正式原生插件管理器导入 tgz 并应用至目标 profile。包声明 Node >=22.18.0，精确 peer 约束保持原样；版本声明不等于所有环境均已实测。
4. 查看 `juebot` 和 `juebot-setup` 面板，按环境完成配置和验收。包默认关闭 agent/storage，enabled false、initializeEmpty false、dataRoot null，不会自动启用平台、模型或正式数据库。

原 DSH 0.2.1-rc.3 连接依赖仍阻塞混合路由 GET；完整限制见 [验证报告](DEV7-VERIFICATION.md)。不要把包安装成功或 health 成功当作完整恢复。正式运行时连接修复需通过正式渠道采用，本发布不提供直接替换依赖模块的安装步骤。

需要回退时由正式管理器恢复历史 dev.6 原包，保留现有配置和数据库，不重新初始化。dev.6 仍包含已知数据面故障；回退不是修复后的可用性承诺。管理器要求扩大重启范围或降级受限时，应先确认影响，不改版本或链接绕过。
