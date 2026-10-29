# 0.3.0-dev.5 原生接线合同

> 2026-10-29 当前状态补充：dev.6 已正式安装，Host 装载/独立测试库初始化/组件重开已通过；真实 Desktop agent 数据面失败、setup 正常，整 Host 重启无效，见[现场 §11.6–11.7](../../VERIFICATION-LOCAL-ACCEPTANCE-DEV6.md)。dev.7 的 GET body mode/health/错误提示修复及单独的连接依赖补丁候选见[dev.7 报告](../../VERIFICATION-AGENT-DEV7.md)。混合 GET/POST 路由需要连接桥修复，仅安装 dev.7 不代表全页恢复；不手改活依赖，也不由本轮执行升级。下文未安装、未验和 dev.5 计数属于原合同编写时的历史状态。

本文件描述候选实现，不是启用、登录、调用模型或发布指令。默认 `disabled:true`、`enabled:false`、`initializeEmpty:false`、`dataRoot:null`、`localChat:false`、`dshModel.enabled:false`；没有改现有 profile。真实管理器、认证 HTTP 和浏览器仍须后续正式验收。

## DSH 模型与本地会话

`agent/host/entry.js` 导出 `dsh-entry.js`。父插件只声明 connection；仅显式模型开启时创建 `ctx.inject(['llm'], child => …)` 子作用域，服务出现/替换/移除时由 Cordis 重建或清理应用与路由。避免从未声明的父作用域读取 llm。包声明精确 peer `@deepseek-ai/dsh-llm@0.2.1-rc.3`，不捆绑第三方 SDK 源码。

`openDshApplication` 在 enabled 为 false 时不读模型设置、SDK 或目标数据目录。启用前需正式管理器配置已有独立目录、namespace 和是否明确初始化空库；路径确认流程始终不调用这个工厂。不得把设置确认动作当数据库初始化许可。

| 字段 | 合同 |
| --- | --- |
| `localChat` | 默认 false。true 仅注册当前 bot/persona 的 `local-test / dsh-owner / local-owner / direct / owner` 会话。 |
| `dshModel.enabled` | 默认 false。true 时其他模型字段必须完整且合法；不会选择宿主默认模型。 |
| `provider` / `model` | 显式非空注册名；不查找或持久化凭据，不自动换模型。 |
| `maxTokens` | 1–8192 的整数输出上限。 |
| `timeoutMs` | 1–60000 的整数；整个调用包含预留/SDK准备/读取/解析，超时传取消信号。 |
| `dailyUnits` | 正整数 UTC 日控制单位上限；需要用户确认数值，不预设费用额度。 |

全局 receive/save/learn/reply/proactive 权限仍默认 false，本地会话也须显式设置。Connection owner 只获得该本地流的读取/管理和人工审阅资格，不证明任意 QQ 身份；Code authorization 始终为空。身份切换立即更换本地会话权限，保留独立人格记录和同一预算账本。没有启动 runner、账号或后台主动模型循环。

原生模型使用本机 rc.3 `prepareCall`、精确 prepared.config 和 BlockAssembler，必须见到显式 stop；拒绝工具调用、不完整/过大流，推理块只计限额后丢弃，不写日志或后续提示。已准备路由必须是 `retryPolicy.mode=normal,maxRetries=0`，否则在 stream 前拒绝；不会修改宿主全局重试配置。这项检查不承诺约束任意第三方 middleware 的独立联网行为，实际路由仍需正式验收。

预算使用同一 StateStore 的 UTC 日账本，在调用前原子预留 `完整请求UTF-8字节数 + maxTokens`。这是控制单位，不是精确 token 估计或人民币费用上限。有效 usage 按实际 units 记账；已知超额也完整记录并阻止后续额度申请，未知/取消/失败保守保留预留，重开/换模型/切身份不会清零。同一日不同 SQLite 连接共享上限。旧日未结算项不会被自动删除或退款。

## 创作恢复与投递核对

- `POST /creation-recovery` 只接收作品 ID、预期 revision、recover/abandon 和必填理由，要求当前管理及人工审阅权限。恢复同一作品、重新取材料/规划/制作；原意愿过期、来源/身份/模型/材料版本变化时拒绝，不延长期限。完成后仍审最终作品；放弃为不可恢复终态，保留审计。
- `POST /reconcile` 只接收出站 ID 和队列预期 revision。查询函数由可信 Host 提供，必须给出同一账号、同一 deliveryId、正文及 payload 指纹的证据；UI 不能指定成功、传入证明或触发重发。无 provider、无确定证据或超时均保留 unknown。
- 核对及普通投递的 Outbox 结果、预算和作品/Code 结果投影共用 SQLite 事务；投影写入失败则整体回滚。确认发生过的 Code 投递可如实记账，不恢复任务执行或扩大被撤销的管理员权限。事件日志只记录可核对的状态，未知与后续确认分别保留，不存内部思维链。
- 工厂的 `ports.creative`（policy/materials/plan）、`ports.deliveryEvidence`、publicationAuthority 和真实媒体/平台端口仍需可信集成。默认原生本地入口没有这些外发权限；按钮和接口存在不代表真实平台恢复/核对已接通。

## QQ 官方协议模块

`QQOfficialTextTransport` 已实现官方被动群/单聊文本请求、应用命名空间验证、原始事件时间窗口、持久 msg_seq/去重和结果不明保留。每次获取令牌后重新查询当前授权与完整事件证明，发前再检查期限。构造不联网，没有自动重试、主动群发、个人 QQ 或 QQ空间支持。

dev.3已新增官方SDK事件订阅薄桥及Code组合库，见[Code接线与范围](CODE-CHANNEL-INTEGRATION.md)；仍未接入真实账号与正式认证来源。必须通过可信 resolver 证明当前权限、绑定、暂停及原始平台事件，不能从客户端请求回显授权。QQ官方和个人QQ仍由用户选择，不同时启用，不覆盖 maibot-bridge。协议来源与限制见 [RESEARCH-QQ-TRANSPORT.md](../../RESEARCH-QQ-TRANSPORT.md)。

## 验收边界

本机实际提取的 rc.3 BlockAssembler 与 Cordis 4.0.5 可在隔离进程验证流解析和依赖生命周期，但不等于正式 DSH Host。提取副本仅留 chat work，不打包、不发布。测试只使用合成 provider/connection/fetch 与隔离 SQLite；无真实或付费模型、无账号、无平台业务。

最新测试和包哈希由 [VERIFICATION-AGENT-DEV5.md](../../VERIFICATION-AGENT-DEV5.md)给出。正式安装、启动 owner/端口/认证、卸载恢复和原生视觉需要可用管理器；当前无管理工具，按用户要求停在部署前，不手改 profile、链接或 HMR。B站实际浏览/评论/上传、个人QQ、Code正式工作区/权限验收和异常会话恢复与数据保留/导出/删除仍未完成。


dev.4组合库新增[人工提问/单次审批续接](CODE-INTERACTIONS.md)。默认原生owner入口仍没有QQ权限，不能仅靠开启模型配置启用此库。

dev.5新增[Host维护能力](CODE-MAINTENANCE.md)，需要独立可信维护权限及原session停止证明。默认原生入口仍不注入此能力；无新HTTP/QQ维护命令，也无自动恢复或归档。
