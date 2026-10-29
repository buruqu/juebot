# 官方 QQ SDK 入站薄桥（2026-10-28，离线候选）

本轮只读核对官方公开源码，新增 `next/agent-v1/host/qq-official-ingress.js` 和独立离线测试。没有安装 Tencent/SnowLuma、启动 WS/webhook/token/login、发送真实消息、使用真实账号或修改活 bundle。此模块复用现有 SDK 的事件订阅，不实现第二套网关。

## 固定来源与实际事件

- 腾讯插件固定 [d998f72fb4ab5492eaab3c5e1cc9de1d7901e8a9/package.json](https://github.com/tencent-connect/dsh-qqbot/blob/d998f72fb4ab5492eaab3c5e1cc9de1d7901e8a9/package.json) 为 0.5.3，依赖 `@tencent-connect/qqbot-nodejs:^1.0.5`。这是范围依赖，不能假定运行时必定安装1.0.5；实际部署必须核对解析版本。
- [该提交 bootstrap.ts](https://github.com/tencent-connect/dsh-qqbot/blob/d998f72fb4ab5492eaab3c5e1cc9de1d7901e8a9/src/gateway/bootstrap.ts) 在函数内 `new QQBot`，注册 `bot.on('message', async (mCtx) => ...)` 并内部启动生命周期；未导出 `ctx.qqbot` 公共service。不能凭猜测调用不存在的service，也不能另装一份插件造成双回复。父Host必须获得已认证 SDK 的受控引用，并安排唯一出站owner。
- 读取 npm1.0.5 元数据得到 SDK gitHead **429a0f1b798f3b0fcef3679e207dbc0469a1df2d**；核对该提交的 [QQBot.ts](https://github.com/tencent-connect/qqbot-nodejs/blob/429a0f1b798f3b0fcef3679e207dbc0469a1df2d/src/QQBot.ts)、[event-dispatcher.ts](https://github.com/tencent-connect/qqbot-nodejs/blob/429a0f1b798f3b0fcef3679e207dbc0469a1df2d/src/protocol/gateway/event-dispatcher.ts)、[protocol/types.ts](https://github.com/tencent-connect/qqbot-nodejs/blob/429a0f1b798f3b0fcef3679e207dbc0469a1df2d/src/protocol/types.ts) 和 [middleware/types.ts](https://github.com/tencent-connect/qqbot-nodejs/blob/429a0f1b798f3b0fcef3679e207dbc0469a1df2d/src/middleware/types.ts)。公开 GitHub API 返回的 base64 正文经UTF-8解码只读核实，没有复制 SDK 实现。
- SDK 的准确签名是 `bot.on('message',(ctx,msg))`，`ctx.bot === bot`、`ctx.message === msg`，`ctx.replyTarget` 与 `msg.replyTarget`同引用。`msg`带 `rawEventType/kind/senderId/messageId/timestamp/raw/replyTarget`；`raw`保留原平台对象。中间件可能修改消息、清理正文、合并输入，不能把上层 envelope 或 `receivedAt`冒充原平台正文/时间。
- C2C 原事件是 `C2C_MESSAGE_CREATE`：`raw.author.user_openid`；群只接 `GROUP_AT_MESSAGE_CREATE`：`raw.author.member_openid`、`raw.group_openid`。普通 `GROUP_MESSAGE_CREATE`、频道、互动与guild DM不进入当前被动文本桥。
- SDK `QQBot.emit`对每个listener执行 `await`并 `try/catch`，所以本桥返回的reject由SDK接住，不创建脱离SDK的reject promise。`on/off`只注册与移除该listener，本桥从不 `start/stop` SDK。

## Host 接线合同

`createQQOfficialIngress({appId,issuer,botId,personaId,stateStore,authenticateEvent,resolveBinding,authorizeReply,getAdminGrant,codeTasks,onSocial,groupSocialEnabled?,now?,authTimeoutMs?})`，缺必需配置直接拒绝。构造不订阅；明确 `subscribeSDK(sdk)` 才挂监听，返回只off本listener的disposer。共享SDK的连接和其他listener归原owner管理。

`issuer`来自Host已验证的平台/发行方配置，不从OpenID、昵称、QQ号、HTTP payload或SDK可改的logging accountId推断。canonical account为 `JSON.stringify(['qq-official',issuer,appId])`；外部actor为 `JSON.stringify(['qq-official',issuer,appId,'user',senderOpenId])`。OpenID不冒充数字QQ，也不自动获得管理员或PersonLink。

- `authenticateEvent({sdk,context,message,appId,issuer,account,signal})`：可信Host每次核对实际SDK来源、已认证transport、选定应用和当前身份，返回 `{authenticated:true,appId,issuer,account,actorKind:'human',self:false}`。这个callback必须由认证适配器闭包实现；接口形状本身不是签名校验。不能从HTTP用户字段回显这些布尔值。认证回调只读自己的可信认证来源、返回证明，不得持有或写juebot数据库/runtime；默认10秒、`authTimeoutMs`限定1..10000毫秒，timeout/unsubscribe abort会立即取消本桥等待，晚到证明不进入领域。本桥仅在SDK listener内铸造私有WeakMap令牌，再调用 `receive(token)`；HTTP构造JSON无法取得令牌。SDK对象引用和constructor/options不能作为HTTP参数暴露。
- `resolveBinding(identity)`：同步返回 `{key,bindingRevision}`，key严格等于八元组conversation。改变persona/bot/账号/target/profile对应绑定版本时拒绝旧证明。Host须以当前实际binding为准，不能永远固定返回同一revision。
- `getAdminGrant()`：同步返回外部已证明的CodeAuthorization，至少 `verified:true,adminActor,account:appId,conversationKey`；若提供status必须为verified，pending-proof不升级。不能用设置页登记的数字QQ代替官方OpenID证明。CodeTasks仍独立检查模型/预算/沙盒/工具约束和Code开关。
- `codeTasks`需结构契约 `{admit(input,now),get(taskId),control?(command,now),respondInteraction?(input),getInteraction?(requestId),replyEventId?(taskId)}`，可由父桥包装admit后串行执行/入Outbox。依照已确认D007，原始纯文本全文精确等于 `/开启code` 或 `/关闭code` 时，经同样的可信私聊管理员/当前绑定/持久事件去重后直接调用control，优先于模型FIFO；不创建Code任务、不进入social，缺control返回NOT_CONFIGURED而非回退模型。普通私聊纯文本不额外要求Code前缀，原样入Code；未证明管理员、Code OFF、入站异常均不回退社交/学习。群控制命令拒绝。当前不为开关命令另加确认回复或新的发信路径，操作结果仅由可信调用者返回值和本地状态表达。
- `onSocial(envelope)`只接已允许的群；`groupSocialEnabled(key)`默认false。群得到原时间和canonical身份的runtime Envelope。`acceptIngress(envelope,identity)`供BotRuntime二次核对持久证明和当前binding。
- `authorizeReply(delivery,proof,{signal})`必须每次查询当前暂停、账号/绑定、内容与出站权限，精确批准该delivery/body；不可缓存true。`resolveReplyContext(delivery,{signal})`从Code任务原 `input.eventId`、该任务已成功验证答复的新事件（`replyEventId(taskId)`）或群rawSources查已认证事件，精确绑定原事件ID、原时间、原target和账号；前后核对binding/admin/group开关，供既有transport在token前后各调用一次。主动发送与不带原事件的idle-topic不能从这里获得被动回复凭据。

close顺序：先disposer同步off与标记不活跃、取消认证等待，再 `await ingress.idle()`等待已经进入onSocial/Code的promise落定，最后父Host关闭CodeBridge及数据库。认证源忽略abort也不会阻塞idle或让迟到证明写库。通用onSocial可能在内部稍后写runtime，必须真正drain，不能盲目race取消就释放SQLite；当前官方Code组合关闭所有群social。SDK handler结果供可信Host读取；不要把含Code任务的完整结果广播为公共日志。

## 拒绝、留存与测试边界

过滤非human、self、原始author.bot与已知senderIsBot；拒绝id/sender/target/timestamp映射不一致、未来或超过保守五分钟的事件，以及附件、quoted msg_elements、引用、非纯文本message_type、markdown/media/forward等组合。C2C规范化正文与原文不等时拒绝，避免合并/伪装输入进入Code；已知CQ/文件/媒体标签也拒绝，不下载附件。

以account+原始messageId持久去重。记录包含canonical绑定、原始timestamp字符串/毫秒、原target/eventType和正文；相同ID不同证明冲突，重启后仍拒绝重复。每账号最多2048事件（每条正文最多16000字符）；满额拒新，不删除旧证明来重试。正文属于原会话的本地受限事实，不能自动进入跨平台学习；存储保留/清理与operator恢复要单独设计。已经持久消费但admit失败的事件不会自动重试；安全优先于自动补任务，需Host人工恢复。没有真实密钥/令牌落盘。

`node --experimental-strip-types --test next/agent-v1/test/qq-official-ingress.test.mjs` 当前 **45通过，0失败**。使用真实SQLite、真实CodeTasks和离线合成SDK事件/fetch，覆盖私聊隔离、群默认关闭、管理员证明/Code OFF、混合媒体/quote/merge拒绝、重放/冲突/真实SQLite重开、原始证明生成、transport token等待后撤权、SDK unsubscribe、认证超时取消、idle排空、原始全文控制命令/重复幂等/非管理员和群拒绝/缺control不进模型，以及明确审批/答复grammar、畸形保留前缀不进模型、源事件时间和答案结构。

`node --experimental-strip-types --test next/agent-v1/test/qq-official-code-channel.test.mjs` 当前 **16通过，0失败**。复用 `test/support/dsh-code-sdk.mjs`合成DSH服务契约，运行真实SQLite、BotRuntime、CodeTasks、DispatchCoordinator、组合channel、互动broker和新DSH executor，完成合成SDK私聊→原文转交DSH→只提取最终公开正文→统一Outbox→显式离线transport确认；同时验证dedupe/无social学习/无自动send、默认OFF经QQ精确命令开启、active中QQ关闭命令不等model、重复同状态命令零写入且当前grant仍由CodeTasks复核、非admin及群命令拒绝、OFF继续running而queuedheld、profile改后拒旧target、close取消inflight reply/auth等待、真实库释放后的迟到结果零store访问、一个application只有一个channel owner且close后重建不自动Code ON/订阅。dev.4新增单次工具审批和问题答案继续同一Agent/原生Promise（只create/submit一次）、notice真实走统一dispatcher和离线transport、OFF仍可回答running任务、旧revision/错kind/非法选项/跨task与body伪造拒绝、关闭等待后不replay、认证等待期间已被回答的notice二次拒发、新source原事件时间与五分钟过期。该测试不是正式DSH Host或腾讯账号验收。

## dev.4 QQ 人工互动（2026-10-29）

两种保留命令分别为 `/code审批 <requestId> <revision> 允许|拒绝` 和 `/code答复 <requestId> <revision> <JSON>`。JSON形状为 `{"answers":[{"id":"问题ID","selected":["选项标签"],"custom":"可选文字"}]}`，按真实SDK问题ID和label逐一匹配，不能猜测普通聊天为审批。header使用ASCII单空格、正整数revision、opaque ID；以保留literal前缀开头但格式不合要求时拒绝，不送模型。审批“允许”仅映射 `allowed-once`，不扩大工具或会话权限。

答复旁路模型FIFO，经同一SDK认证、原始纯文本、当前管理员/私聊绑定与持久消息去重后才交给broker；broker另查请求/任务/授权/期限与当前等待中的SDK continuation。Code OFF只关新输入，仍可回答原running任务。请求正文通过新的统一Outbox `code-interaction`入队，精确绑定 `{taskId,requestId,requestRevision}`和不可变text，沿原管理员私聊发送；不创建旁路sender。resolver在await出站授权后再次核对请求仍pending、正文与修订未变及reply source未变化，防止过时问题/审批发出。

成功消费答复时broker保留独立sourceHistory并更新仅该任务的replyEventId，原task.input不改。随后notice/final只能使用该task确切原管理员/账号/会话的已认证source证明；普通聊天、新任务或开关命令不能给另一个任务刷新窗口。五分钟从选定source的原平台timestamp计算，不能改写为摄入或执行时间。过期/unknown不自动主动发送、改delivery ID或重投。题目、选项、工具参数和答案仅在Code域与原私聊流转，不写social/learning。

未验证：真正SDK实例/已安装版本与插件扩展引用、真实腾讯登录/权限/网络/平台事件、真实DSH执行环境、正式HTTP认证与浏览器、既有插件自动回复禁用。此模块本身不证明SDK已可信、账号已连接或真实开发任务已通过QQ执行，也不将SnowLuma个人QQ事件冒充官方事件。


追加关闭故障验证：组合16项包括SQLite query_only下close返回可等待的受控失败、完整排空后才关库、failed owner不能重建，以及Code读故障没有detached rejection。
