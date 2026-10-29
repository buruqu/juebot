# 0.3.0-dev.5 官方 QQ → DSH Code 接线

本候选继续已有项目，优先复用腾讯 QQ SDK 的已认证事件入口和本机 DSH Agent。它不创建或登录 QQ 客户端，不启动 SnowLuma，不安装任何上游插件，不自动发送结果或修改现有 maibot-bridge。

## 本轮实现

`@local/dsh-juebot/qq-official-code-channel` 导出 `createQQOfficialCodeChannel` 与所需 Cordis scope `inject=['agents','sandboxPolicy']`。这是供受管理 Host 集成的库入口，没有自动加载的 apply。既有原生 owner 面板仍不授予 QQ 管理员证明；仅在配置文件写 verified 不能启用该链。

组合顺序为：已有 QQ SDK 的 message(context,message) → 私有订阅令牌与可信认证回调 → 原始事件/账号/绑定验证 → 持久去重 → CodeTasks → 串行 DSH 专用会话 → 确定完成的公开回答 → 原管理员私聊 Outbox。没有复制 DSH 的模型或工具执行引擎。

私聊普通文字原样转发，无需 Code 前缀。精确全文 `/开启code`、`/关闭code` 是优先控制命令，只有已验证管理员的纯文本私聊可用；不进入模型队列，重复消息不重复执行。关闭只拒绝新任务并暂停排队任务，当前任务继续。卸载与关闭开关不同：卸载停止订阅、取消当前执行并等待状态写入排空，再允许 Host 关闭数据库。

官方 OpenID 的身份包含 connector、issuer、appId 和 openId，不复用数字 QQ 身份，也不放宽旧数字正则。引用、媒体、转发、bot/self、过期或相互矛盾的事件不能成为 Code 输入。私聊 Code 不进入社交账本、学习卡或群聊；本组合的群聊功能关闭。

## Host 必须提供的真实能力

- 已认证且账号一致的腾讯 SDK 实例及只读 `authenticateEvent`，仅绑定自己的 message listener；不伪造 ctx.qqbot 服务、不调用 SDK 登录或断开方法。
- 同一消息的业务入口必须由 Host 独占路由或明确仲裁。不能同时让原插件默认回复器与本桥各自执行一次；本桥不会擅自摘除他人监听或停用 maibot-bridge。腾讯插件的 SDK 实例当前是私有对象，真实受管理接线仍需正式集成，不能仅安装本包就假设可访问。
- 与应用 `ports.codeAuthorization` 同源的 `getAdminGrant`，包括可信管理员证明、原私聊、账号、工作区与会话标识、允许工具、已确认模型及可用预算。pending-proof 不可使用。
- `resolveBinding` 的当前 canonical key/bindingRevision，`resolveWorkspace` 的已确认工作区，以及每次出站都重新核验的 `authorizeReply`。认证源只返回证明，不能持有 juebot 数据库异步写权限。
- `application`、该应用的 `stateStore` 与受正确 Cordis 依赖作用域管理的 `ctx`。同一个 application 同时只允许一个 Code channel owner。

构造不订阅或调用模型。Host 显式调用 `start()` 才订阅已有 SDK。发送端仍由统一 Dispatcher 驱动，`QQOfficialTextTransport` 可使用该 channel 的 `resolveReplyContext`。`await channel.close()` 必须先于 `application.close()`；不以后台定时任务绕过此顺序。

认证回调最多等待 10 秒；关闭订阅可取消等待，迟到证明不能落库。出站证明等待最多 25 秒且受 caller/lifetime 取消信号约束，关闭后不能再次获准发送。普通 ingress 模块若单独启用群社交，onSocial 仍须真正结束才能释放数据库，不能用 Promise.race 冒充取消持久化写入。

## DSH 复用和状态边界

持久映射绑定管理员、原私聊、账号、工作区、逻辑会话、授权版本、工具列表及明确模型路由；已完成会话可 resume。同一个任务存在执行尝试记录后，不会自动重放。异常或重启的任务与会话保持 needs-review。

每次模型/工具动作复查授权及实际 sandboxPolicy、session.cwd；拒绝 danger-full-access，也不把 Windows workspace-write 描述成操作系统完整隔离。PTC `run_code` 必须明确列入授权，嵌套工具继续逐项检查。模型路由、输出上限、执行时限和每任务模型调用次数均有界；实际费用预算仍由可信 Host 配置与持续核验，不能把此模块当费用额度授权。

完成必须有本次提交的唯一用户输入、对应 turn/end completed 以及最后一条完整公开文本。whenIdle、工具调用、部分文本、失败、审批等待均不算完成。推理块不回 QQ，不写 juebot 的任务结果。dev.4通过[人工交互broker](CODE-INTERACTIONS.md)将具体问题/工具参数限于原私聊，等待明确答复后继续同一个SDK请求。没有broker、超时或重启没有原等待时才转needs-review；不自动同意，不伪装成已完成。

## 已知限制和下一步

- 本轮没有真实 QQ/DSH Host 接线、登录、真实模型调用或平台投递验收；原生默认入口保持禁用，SDK/管理员证明/权限/预算还需正式管理器集成。
- QQ 官方被动回复仍受原事件 5 分钟保守窗口约束，长任务结果过期后保留，不能自动改为主动消息或重发。结果最多 16000 字符，无自动拆分、文件回传或命令确认消息。
- 活跃任务提问/审批续接及异常人工弃用、新会话轮转、交互冷归档已本地实现；见[维护合同](CODE-MAINTENANCE.md)。原任务不能重放，任务/入站/Outbox归档及按钮、确认、文件回传仍待完成。
- 每账号最多保存 2048 个入站事件，达到上限拒绝新增；没有自动删去重证据。需后续受审计的保留/归档策略。
- SnowLuma 个人 QQ 仍保留为另一条路线，不与官方通道同时启用。B站复用 `Alterssss/dsh-bili-whale` 的读取和工具实现，下一阶段隔离原插件调度/人格；所有作品和评论仍经过最终人工审核，不把本轮 QQ 接线当 B站接通。

协议与 SDK 核对依据见 [QQ 入站研究](../../RESEARCH-QQ-INGRESS.md)、[DSH Code 研究](RESEARCH-DSH-CODE.md)。最新验证由项目 `VERIFICATION-AGENT-DEV5.md` 给出，历史807/758/695项不代表dev.5。

dev.5新增[Host维护能力](CODE-MAINTENANCE.md)，需要独立可信维护权限及原session停止证明。默认原生入口仍不注入此能力；无新HTTP/QQ维护命令，也无自动恢复或归档。
