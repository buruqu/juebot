# DSH Code 桥实际契约核对（2026-10-28；dev.4 续接于 2026-10-29）

本轮从本机 `D:\dsh\resources\app.asar` 只读解析公开依赖代码，确认 `@deepseek-ai/dsh-agent` 及相关组件版本 `0.2.1-rc.3`。未读取 profile、凭据或正式数据库；未创建真实 Agent、调用模型、执行 DSH 工具或连接 QQ。临时源码摘取仅在本次聊天 work 目录，没有复制进发布包。

实际读取字节的 SHA-256（源码摘取后原样计算，非网络最新版本声明）：

| 包内文件 | SHA-256 |
| --- | --- |
| dsh-agent-loop/lib/index.js | `CF57E3ECD487AC5C2553455AAA5CEF2C6FB41E6BD61BE5AA455675D1D7193033` |
| dsh-tools/lib/types/index.js | `D8CF8E1400E1B923684324546E46D6408BEC140002430150B34099AE95A365C8` |
| dsh-sandbox-policy/lib/index.js | `772CA58F0F786D6CB4D839DEB621634C31097C13228D81B14E3F3153D0524924` |
| dsh-session/lib/index.js | `2F5DD07CB5C744A29ABBB8003A8A4CEFD9E582C6E2538074CA299A0DDD02A3BF` |
| dsh-user-approval/lib/index.js | `6A5AD1BA3C3DC3ABBBAE52E6C8C4463970EE0C1C8988CEBB0D5CF2ACD17EE90B` |
| dsh-user-questions/lib/index.js | `E1C51AFAC2E31BE8593C6426976E5F31DBE2A709B85AE1EA43ED406146F54265` |

Code 的实现方向是“可信 QQ 私聊请求 → 现有 DSH 专用 Agent/session → 最终文本 → juebot Outbox”。`dsh-code-executor.js` 是执行端口，不是另一个 Agent loop、工具执行器或操作系统沙箱。

## 本机源码依据

下列路径均位于 app.asar 内公开 `@deepseek-ai` 依赖包的 `lib` 下：

| 组件及位置 | 核实的契约 | 本桥处理 |
| --- | --- | --- |
| dsh-agent-loop/index.js 1893、1963 | `agents.create({sessionId,meta,agentOptions,setup,signal})`；恢复参数为 `resumeSessionId`；setup 在发布前执行，参数为 `(agentCtx,agent)`，结果为 `{agent,dispose}` | 先安装 scoped hooks，再提交任务；只恢复本 StateStore 登记且上次正常清理的专用会话 |
| dsh-agent-loop/index.js 806、870；dsh-user-questions/typert.host.js 的 Agent、MessageBase、UserMessage | `followup` 输入必须含 id、role、content、source；`status` 是 `idle` / `running` 字符串；`whenIdle` 只等待空闲 | 使用确定性消息 ID；空闲后必须有对应 user/message 和 turn/end completed，以及无中断、无待执行工具的最终 assistant 文本 |
| dsh-session/index.js 1575；typert.host.js 的 SessionEventMap | `session/event` 回调是 `(session,event)`；event 包含 type、seq、data | 仅记录当前会话、提交之后的必要事件，返回 text，不返回 reasoning。没有新增使用已弃用的 snapshotEvents 同步读取接口 |
| dsh-agent-loop/index.js 1191、1228–1294 | `agent/request(payload,next)` 可以修改提议配置；prepareCall 解析后的 config 被写入 request/header；之后、流请求之前检查 signal | 提议配置及实际 request/header 双重校验 provider/model/maxTokens；外层 middleware 改路由时同步 cancel，阻止后续请求 |
| dsh-agent-loop/index.js 1130–1146 | 失败 attempt 后调用 agent/request-error，返回 retry 可继续请求 | assistant/attempt 或 request-error 立即 cancel，不调用下游重试中间件；普通多步工具任务仍可继续，模型步数上限另行限制 |
| dsh-tools/types/index.js 499–546、867–900 | restrict 仅在 scoped context 可用，且只掩蔽继承工具；guard 是单向拒绝；run_code 是保留 PTC 入口，不能写入 restrict 名单 | restrict 与 guard 同时使用；包括 run_code 在内的每个实际入口都必须获 trusted grant 显式允许并通过 gateTool。仅传入 restrict 时过滤保留名，嵌套能力照常逐个检查 |
| dsh-sandbox-policy/index.js 138–148 | resolve({session}) 根据实际会话 override/default 及 header.cwd 解析 mode、workspaceRoot、sessionId | 不传伪造 mode override；核对现存真实目录、会话 cwd、实际 policy root，拒绝 danger-full-access；每个模型/工具步骤重新检查 |
| dsh-user-approval/index.js 128–185；dsh-user-questions/index.js 679–686 | 审批有 approval/asked、approval/request；问题使用 user-questions/request waterfall | 未配置 interactions 时转 needs-review；配置后等待可信 broker 人工答复，继续原等待调用，不创建新 Agent 或重放请求 |
| dsh-tools/types/index.js 775–835、884–900、1069–1125 | pre-execute 获得已冻结 arguments 的 ToolExecution；approval/request 只携带 toolName/callId/reason/displayReason/signal；tools/result 表示该执行已结束 | 具体输入只能从当前 ToolExecution 捕获；同一个调用的输入、工具、请求详情在等待前后及最终 guard 重查；结束的执行不能再次获得审批 |

## 注入接口

```js
const executor = createDshCodeExecutor({
  ctx,                       // owning Cordis scope: inject agents,sandboxPolicy
  store,                     // 已打开的 juebot StateStore
  resolveWorkspace,          // (workspaceId) => 现存绝对目录字符串，同步可信映射
  model: { provider, model, maxTokens }, // 必须显式指定
  onInteraction,             // 可选，仅安全元信息；不是答复/审批接口
  interactions,              // dev.4 可选：可信人工交互 broker，见下文
  timeoutMs: 300000,
  cleanupTimeoutMs: 5000,
  maxModelCalls: 32,
  namespace: 'default'
});
// 交给已有 CodeTasks.execute，不能绕过可信 Host 授权：
await codeTasks.execute(taskId, executor, { signal });
```

工厂创建没有 I/O。执行时只读解析工作区路径，使用调用者提供的 StateStore 和 DSH 服务。授权来自 CodeTasks 的实时 `gateModel/gateTool`，配置布尔值不是管理员身份、预算或沙箱证明。

专用会话 ID 由管理员、来源会话、账号、工作区、逻辑 sessionId、授权修订、工具表与模型路由共同派生。持久记录每次尝试，拒绝重复任务和并发使用；异常、崩溃遗留或清理未完成的会话进入 needs-review，不自动重试或盲目恢复。授权修订或目标变化会产生新的专用会话，避免把旧的 Code 材料带到新身份/工作区。

`onInteraction` 仍是无 broker 时的安全通知，仅包含 kind、taskId、sessionId、state，以及 toolName 或 questionCount。原始异常、工具参数、模型推理不会写入此回调或 Code 状态错误文本。新的 `interactions` 端口仅传送需要人工查看的完整问题或具体工具输入，交由 broker 限定到原可信管理员私聊，不能混入普通社交记忆和日志。

## dev.4 人工答复续接

端口是 `interactions.request(payload,{signal,check})`：

- `payload` 为 `{kind,taskId,sessionId,callId,approval?,questions?}`。其中 sessionId 是实际派生的 SDK 会话 ID，和授权的逻辑 sessionId 不是同一字符串；可信闭包 `check` 与实时 grant 共同绑定两者，broker 应分别冻结。
- 审批详情为 `{toolName,args,reason?,displayReason?}`，返回值只允许 `allowed-once` 或 `rejected`。不接受永久授权、会话授权或模糊布尔批准。approval/request 本身没有 args，因此必须先关联同 agent、callId 的活跃 ToolExecution；无法唯一关联就转 needs-review。
- 问题为 SDK 原结构 `{id,question,detail?,header?,options?:[{label,description?}],multiSelect?,intent?}`，其中 intent 只支持 SDK 的 plan-review 结构。结果为 `{answers:[{id,selected:string[],custom?}]}`；每题恰好一次，只能选择原 label，非多选最多一项，或者填写非空 custom。计划问题的同意不会放宽工具授权。
- 请求 JSON 总量最多 12000 字符，最多 8 题、每题 16 个选项。审批输入不能截断后让人批准；过长直接拒绝交互。
- 人工等待计入原 `timeoutMs`（默认共 5 分钟）。将 SDK 请求 signal 与任务 signal 合并，等待中每秒重查授权，答复到达后再核对原 task、同一 Agent、实际 session、模型配置、工作区实际路径及当前策略；审批还重新核对具体输入和工具门禁。
- 保持同一运行 Agent 和原 Promise，答复不调用 followup、resume 或重跑任务。拒绝单次工具调用可让原 Agent 得到拒绝结果后继续说明；允许后仍要通过单向工具 guard。SDK 的 approval/decided 必须和本次 broker 答复完全一致，外层插件不能将拒绝改成允许。
- OFF 只拒绝新任务，当前人工等待仍可以回答。卸载、撤权、总期限或 SDK 问题期限到期都会取消 pending；迟到答案不再交回 Agent。没有 broker 的默认行为保持 dev.3 的 needs-review。

SDK 审批服务在 request.signal 取消时返回 cancelled，缺少/异常 answerer 返回 unavailable，本身没有内置默认期限；askTimed 会用其 signal 管理问题期限。桥把这些请求纳入自身总期限，不把 SDK 的 pending/空闲当成功。`tools/result` 后不能拿旧调用重新申请批准；仍有未结束人工等待时也不能把任务标记完成。

OFF 是停止新任务，仍运行的任务沿用实时授权继续。卸载/取消/超时不同于 OFF：取消自有 Agent 并有界等待 dispose。晚到的 create/resume handle 仍清理，不再触碰可能已关闭的 StateStore；dispose 挂起时保持拒绝工具的 hooks，标记 needs-review，不声称进程已完全停止。

## 边界与验证

`read-only/workspace-write` 策略名称和路径匹配只证明本机 DSH 的请求策略，**不证明 Windows 上所有工具、网络和外部插件已经有操作系统级隔离**。Host 必须实际核验并签发匹配的可信 grant，且只允许已核验的能力。`danger-full-access` 一律不作为隔离沙箱接受。SDK/第三方模型适配器内部行为、网络重试与外部工具限制还需真实 Host 验收，不能由合成测试替代。

定向测试：`test/dsh-code-executor.test.mjs` 当前 **31/31 通过**；使用临时真实 SQLite 与 `test/support/dsh-code-sdk.mjs` 合成服务。覆盖多步最终结果、私密推理不回传、会话恢复与防重、身份/路由分隔、异常完成、工具/PTC 入口、实际策略/工作区、模型改路由/失败重试、并发及清理。dev.4 新增同 Agent 人工问题/单次审批/拒绝续接、具体输入及模型/问题防变更、永久批准拒绝、SDK 取消/超时/迟答、等待时撤权、外层审批改写、已结束调用重用、超长详情和未完成交互负例，以及真实 CodeTasks 的 OFF 人工等待继续。异常必须是本模块 WeakSet 标记的固定错误才能保留错误码；外部 SDK/broker 伪造 DSH_CODE 前缀携带秘密的负例确认原文不会进入持久状态。

真实 Host：未测。认证 HTTP：本模块未测。界面视觉：无界面修改、未测。QQ/B站平台业务：未连接、未测。没有部署、重启、登录、付费模型调用或发布。
