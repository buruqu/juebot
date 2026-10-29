# Code 异常会话与交互归档（dev.5）

2026-10-29。仅独立候选的受管理 Host 库接口，未接真实 Host 或 QQ，未新增网页、QQ 命令或 Agent 工具。维护能力不能从请求正文中的 `reviewer`、`approved` 或管理员登记推导。

## 异常会话的处理

活跃任务仍按 dev.4 答复原 SDK 等待。重启、超时或执行异常后，原等待不能重建。本轮增加“人工检查后弃用旧任务和会话，下一条明确新消息进入新会话”的路径；不是从断点继续，也不自动复制旧输入。

1. 受管理 Host 先关闭 Code 新任务入口，并等当前执行及异步尾部结束。OFF 本身不会取消正在运行的任务。
2. Host 调用 `channel.inspectRecovery({taskId, reviewer})`，获得 `expectedStateRevision` 和 `session.revision/sessionId/phase`，检查原 DSH 会话和已经发生的工具副作用。
3. 明确人工放弃后，调用 `channel.abandonSession({taskId, expectedStateRevision, expectedSessionRevision, reviewer, reason})`。理由不能为空，最多512字符。
4. 同一 SQLite 事务保留旧 session/attempt 完整快照和审阅记录，将原任务标为 stopped，将会话映射轮转至下一代 fresh。旧 task、事件 ID 和执行尝试都保留，不能重放。
5. 恢复动作不启用 Code，不调用模型，不创建实际 SDK 会话，也不发送消息。人工重新开启后，新的 QQ 消息才创建新的 DSH session；后续已完成的新任务可继续该新 session。

构造通道须由可信 Host 注入 `authorizeCodeMaintenance(reviewer)` 与 `verifyCodeSessionStopped({sessionId, taskId, mappingRevision})`。两者必须同步明确返回 true，缺失、抛错、Promise 或 false 均拒绝。后者必须来自实际 Host 对对应 session 已停止及尾部已排空的证明，不能把字符串 session ID、用户自报、仅队列空或 `whenIdle` 当作证明。

前后复查当前完整管理员授权、原私聊、账号、工作区、人格和版本；Code 必须 OFF，桥无活跃/排队任务、无 running 任务及 pending 人工交互。已有结果的任务走独立结果审阅，不在此弃用。权限、版本、工作区或状态改变，以及写入失败，整批事务回滚。失败 close 的 owner 仍保持关闭；本接口不能绕过正式 Host 重开应用的要求。

## 人工归档交互

`channel.archiveInteractions({ids:[{id,revision}], reviewer, reason})` 每次最多32条。仅任务已 completed/stopped、没有待投递结果、交互已终结，并且原 notice 为 confirmed/failed/cancelled 时可归档。queued、sending、held、unknown 和缺少 notice 一律拒绝，不修改投递状态或解除账户锁。

整批先核对 ID、版本、原任务、账号、正文和 notice，再在同一事务中保存完整冷记录、人工理由、时间和 SHA-256 收据，移出热 records 并建立索引。任一失败全部回滚，没有定时清理或删除历史。

- `channel.listArchivedInteractions({reviewer, offset?, limit?})`：有界元信息，默认20条、最多100条。
- `channel.readArchivedInteraction({id, reviewer})`：重新核对当前同源权限后读取完整私域记录。
- 原 broker `get(id)` 可回读冷热记录；`list()` 只列热记录。旧答复的事件去重和任务回复来源继续保留，归档不使旧审批再次有效。
- 冷档仍在同一候选 SQLite 内，是容量分层，不是独立备份、导出或物理删除。记录哈希用于一致性核对，不是防篡改签名。

热交互最多64条，归档索引最多4096条，回复事件去重最多4096条，热状态继续受7 MiB约束。Code任务仍累计64条，QQ入站仍2048条，Outbox和StateStore也有原有上限；本轮未解决所有长期容量问题，不承诺无限运行。任务、入站和Outbox归档及数据保留期限需要后续分别完成。

## 验收边界

本轮以真实 SQLite、实际 CodeTasks/Dispatcher/broker/executor 和合成外部 SDK 验证。真实 Host 维护身份、旧 session 停止证明、认证 HTTP、原生界面、真实 QQ/B站、费用与平台投递均未验证。缺少正式 DSH 管理工具，继续停在部署前；不改 profile、链接、HMR 或既有 maibot-bridge。

## 可选官方 QQ 社交组合与入站保留（后续本地开发）

`createQQOfficialCodeChannel` 继续只订阅 Host 已认证的同一个 SDK，不创建账号或登录。新增可选 `onSocial(envelope,{signal})`、`directSocialEnabled(key)`、`groupSocialEnabled(key)` 与同步 `routeDirect(metadata)`；默认两个社交开关均关闭，沿用原来私聊 Code 行为。自定义路由只接收冻结的身份/账号/会话元信息，不把正文交给路由分类模型。

精确 `/开启code`、`/关闭code`、`/code审批` 与 `/code答复` 优先进入原 Code 鉴权及控制链。组合通道中，同源管理员在 Code ON 时的普通私聊继续进入 Code；Code OFF 且 Host 明确启用私聊社交后，普通文字才走社交。错误、未知或异步路由不回退到另一条链。群聊 Code 命令仍拒绝。

每条入站持久保存 `route: code|social` 并纳入指纹。同一事件不能随后从 Code 改投社交。Host 可将 `channel.acceptSocialAttestation(envelope,identity)` 接至 runtime 的可信 `acceptIngress`，并将 `onSocial` 接到原 runtime.receive；它只认可已保存的完整、同身份、当前绑定且获准社交的 envelope，Code 来源无法取得社交证明。出站 `resolveReplyContext` 支持社会私聊和群聊，并继续按原始事件时间检查 5 分钟窗口。

只有可信原始 QQ 字段 `raw.message_reference.message_id` 明确给出被引用消息时，社交 envelope 才增加可选 `replyTo`。正文中的“引用某消息”等文字不会生成引用。Code 继续拒绝引用输入，媒体/合并/markdown 等边界不变；原生反馈仍要求 runtime 能将该真实引用匹配到自己的出站对象。

入站库增加 Host-only 显式接口：

- `inspectIngress({ids:[eventId],reviewer})` 返回容量 CAS `expectedRevision` 和各事件 `id/revision/phase/route`。
- `archiveIngress({ids:[{id,revision}],expectedRevision,reviewer,reason})` 每批最多32条，仅完整结束的 `completed` 入站可归档。
- `listArchivedIngress({reviewer,offset?,limit?})` 默认20条、最多100条元信息；`readArchivedIngress({eventId,reviewer})` 重新授权后回读完整原持久证明与审阅记录。

构造时须另行注入可信同步 `authorizeIngressMaintenance(proof)`，proof 含动作、账号、审阅人、理由/时间及该批元信息。它必须明确返回 true，缺失、Promise、false、抛错均拒绝；不能从 QQ/HTTP 正文获得此函数或维护能力。组合通道另外要求 Code OFF、桥及交互安静、当前人格一致，并调用既有 `authorizeCodeMaintenance`。输入在回调前复制，批次及来源前后 CAS 复核，撤权、SQLite 失败或任意单条不合格均整体回滚。

归档在同库保存原热记录的完整冷副本、审计和 SHA-256；原事件行变为永久指纹墓碑，source ID 映射保留，出站证明仍可穿透冷热读取。只减少热容量计数，不删除旧事件/来源去重，不重新路由、不补发。`processing`、`unknown`、没有结束证明的旧版记录均拒绝归档；卸载等待已接纳社交尾部后才允许释放数据库，迟到认证不能落库。热上限2048、冷索引上限4096仍是明确边界，到上限拒绝新归档，不承诺无限运行，也不将冷归档当独立备份。

本节只说明本地接口与实际 SQLite/合成 SDK 验证范围；没有真实平台账号、模型、发送或正式 Host 部署验收。
