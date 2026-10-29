# QQ 官方被动文本 transport：2026-10-28

这是尚未接入真实账号的独立协议实现。没有安装依赖，没有使用真实凭据、登录、调用腾讯发送接口、修改活 bundle 或候选包。离线测试使用真实 SQLite 和 synthetic fetch；协议核实只读取公开官方文档。采用开发前检查、grill-me 和 prove-it 的边界/证据要求；本模块没有界面变化。

## 当前官方来源

- [接口调用与鉴权](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/api-use.html)：当前统一基座是 `https://api.bot.qq.com`，取凭证为 `POST /app/getAppAccessToken`，JSON 字段 `appId`、`clientSecret`；响应 `access_token`、`expires_in`，消息请求头为 `Authorization: QQBot <access_token>`。旧文章里的 `bots.qq.com`/`api.sgroup.qq.com` 不用于本实现。
- [发送群聊消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)：`POST /v2/groups/{group_openid}/messages`；本实现只发送 `msg_type:0`、`content`、`msg_id`、`msg_seq`。被动回复窗口五分钟、每条五次，重复 msg_id+msg_seq 会失败；成功响应的 `id` 是真实消息 ID。
- [发送单聊消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)：`POST /v2/users/{user_openid}/messages`，字段与文本被动回复一致，每条最多四次。**同页存在期限冲突**：页首六十分钟，msg_id 字段五分钟。本实现保守采用五分钟、四次，不声称六十分钟窗口已经验证。

api-use 页面由网页读取工具读取成功；两个自动生成的发送页面由 Firecrawl scrape 读取官方 URL 成功（HTTP200）。文档不是实账号运行证据。官方文本的字段/示例已独立转写为薄实现，没有复制 SDK 代码。

## 接口和信任边界

`new QQOfficialTextTransport({appId,issuer,account,getCredentials,resolveReplyContext,stateStore,fetchImpl?,now?,timeoutMs?})`，然后明确调用 `send(delivery,signal?)`，返回 `{status:'confirmed'|'failed'|'unknown',receipt:string|null}`。导入和构造不联网、不调用 callback、不创建后台任务。

`account` 必须严格等于 `JSON.stringify(['qq-official',issuer,appId])`。Delivery 的 canonical conversation 必须是既有八元组，connector/issuer/accountId/kind/remoteId 与此应用、resolver 和目标一致。拒绝裸 QQ 号/OpenID、个人 QQ、creation；接受 social/repetition/code-result 仅表示可由可信 resolver 证明为合法被动文本回复。忽略 payload 内的 endpoint、路由和授权声称。

可信 Host 必须注入 `resolveReplyContext(delivery,{signal})`：从已认证的 connector 原始事件记录及权限检查获得 `{authorized:true,deliveryId,body,appId,issuer,account,conversation,kind,targetOpenId,messageId,eventType,eventTimestamp}`。全部与发送快照精确匹配。群只接受 `GROUP_AT_MESSAGE_CREATE`，单聊只接受 `C2C_MESSAGE_CREATE`；`messageId` 必须来自事件 d.id，eventTimestamp 是原始平台事件时间而非重放/摄入时间。resolver 还必须确认该 delivery/body 的发言授权，不能只是把客户端字段回显为 true。

本模块**没有 webhook 签名验证或接收器**。HTTP 客户端不能注入 resolver、fetchImpl、credential callback 或 StateStore；将任意客户端对象当作可信证明属于错误集成。账号接入、当前表达/绑定权限及撤权检查仍由 Host/统一 dispatcher/connector 负责，不能通过直接暴露 send 绕过。transport在token返回后再次调用resolver，要求重新确认当前暂停、身份、绑定及授权，并逐一匹配原证明的全部关键字段（包括eventTimestamp、messageId、目标、account和body）；随后同步复查期限并直接调用消息HTTP，不再插入额外异步调度。resolver必须每次查询当前状态，不能返回缓存授权。

`getCredentials({appId,issuer,account,signal})` 返回 `{clientSecret}`。凭据/令牌只在单次调用内使用，不写 SQLite/日志/错误回执。没有 token 自动刷新、重试或后台缓存。生产 URL 固定官方 TLS；没有自定义 base URL；fetch 设 `redirect:'error'`。fetchImpl 是可信 Host 测试接缝，不是远端配置项。

## 持久化、失败和界限

注入的 `stateStore` 必须是持久、同步原子事务 + revision CAS 的 StateStore（现有 SqliteStateStore 可直接使用），构造只核对接口，不创建/迁移数据库。使用两个哈希键：每个 account+kind+targetOpenId+messageId 的序号，以及每个 account+deliveryId 的结果。序号与 unknown 占位同事务写入后才进入网络。失败、超时、取消也消耗序号；同 delivery 重启/并发再次调用不会外发。跨 persona/bot 的同一 QQ 目标事件共用次数限制，不能通过切换本地身份重置。SQLite 在容量达到上限时拒绝发送，需要受控保留/归档设计，禁止删除尚未判明结果的键来重试。

超时默认十五秒，最多二十五秒，覆盖 resolver、凭据、token、发送、响应读取；传递 AbortSignal，响应体上限64KiB，文本本地上限16KiB。没有自动分片或自动补发。平台仍可能有更严字符/频率限制。`confirmed` 必须来自成功 HTTP 响应的非空 id；网络异常、5xx、重定向、不完整/无ID/超大响应在提交后为 unknown。已明确的4xx平台错误为 failed。token失败时不进入消息 endpoint。unknown 需人工/平台证据核对，不等于可重新投递；禁止用新 deliveryId 自动绕过去重。

## 验证

`node --experimental-strip-types --test next/agent-v1/test/qq-official-transport.test.mjs` → 39通过，0失败。覆盖官方请求字段与目标、group/direct次数限制、跨persona限制、并发重复、真实SQLite落盘重开去重、失败不复用seq、目标/身份/授权不符、过期、token失败、响应ID、超时取消、响应体限制和 unknown。新增token等待期间撤权/替换事件与身份路由12种关键字段、二次resolver等待期间过期共13项反例，先在原实现复现13项失败（原行为仍发送并confirmed），修复后全部通过且消息HTTP调用数为零。

未验证：真实腾讯账号权限、真实事件签名/connector接入、公网联通与白名单、实平台频控/字符上限、当前DSH自动回复插件的禁用与唯一发送owner。此实现不能视为正式账号已经接通，更不支持 QQ空间、个人QQ协议或主动群发。
