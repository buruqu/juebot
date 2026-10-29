# 应用级 Bili、创作、成长与维护接线

> 2026-10-29 当前状态：dev.6 已正式安装并完成 Host 侧生命周期验证；[最新现场 §11.6–11.7](../../VERIFICATION-LOCAL-ACCEPTANCE-DEV6.md)记录 agent 数据面全部失败而 setup 正常。dev.7 仅修复传输注册与诊断，不更改本页应用/平台合同；另有独立连接桥补丁候选，完整验收条件见[dev.7 报告](../../VERIFICATION-AGENT-DEV7.md)。后文“未安装/未有真实 Host”的文字描述原开发轮次，不覆盖最新现场事实。

2026-10-29，本地 dev.6 开发记录。以下实现属于独立候选，未安装、未操作真实平台或正式业务库；统一构建和最终包校验由主代理执行。

## 注入端口与生命周期

`openApplication(ctx,config,{principal},ports)` 沿用显式 enabled、受管目录、独立 SQLite owner/锁与默认暂停。新增能力不自动联网、不开账号、不查凭据、不启动 runner。

- `ports.bili={transport,authorizeRead,budget,authorizeMaterials,timeoutMs?}`：合同见 BILI-MATERIALS.md。服务按 namespace/bot/persona 分区，保存稳定快照。所有 HTTP 仅由显式 capture 发起。
- `ports.creative={policy,plan?,materials?}`：policy 明示账号和动作；plan 或既有模型 planCreation 负责本地方案。外部 materials 仅处理其负责的意愿来源。应用合并 Bili、获审摘要和外部投影，逐项检查来源、目标/用途、revision 与期限，不丢意愿证据。
- `ports.growthEvaluation.evaluate({scope,id,expectedRevision,principal,identityRevision})`：可信 Host 测试/证据提供方，返回 `{kind:'host-evidence',evidenceId,evaluation}`。缺此函数时 API 的 evaluatorConfigured=false，不能靠客户端自填 pass 评估。evaluation 仍由冻结 suite、模型/基线版本和 CAS 校验；应用保存独立 evidence 记录，结果只到 evaluated，不自动审核或激活。
- `ports.maintenance={authorize(proof),binding()}`：只供可信 Host 使用。两个回调均同步；Promise 不算许可。binding 必须返回 `{verified:true,code:当前app.code,profile:当前app.runtime.profile,interactions:实际channel broker,bridgeIdle:true}`。未知或不匹配即拒绝，不能由普通模型工具或 HTTP 参数自行构造绑定证明。

close 同步关闭准入并关闭 runtime，取消 Bili 在途读取，等待 runner、材料/创作/评测的已接纳操作退出，再释放 SQLite 与 owner 锁。预期取消不伪装成关闭失败。身份切换要求应用无在途操作；每次异步返回后都使用调用者权限、profile/revision、key binding 和领域授权复查，不能只在响应末尾拒绝输出。

## API 依赖与用户路径

应用注入以下 deps，principal 由 API 的可信身份入口提供：

- `biliSources.capture({id,expectedRevision,request},actor,beforeCommit?)`
- `biliSources.read(id,revision?,actor)`
- `biliSources.revoke({id,expectedRevision},actor)`
- `biliSources.learning({key,id,revision,itemId,proposalId},actor)`：只选一条，返回 pending，不自动批准。
- `prepareCreationIntention(key,topic,actor,beforeCommit?)`：调用 runtime 的有效经历评估，只生成真实 pending 意愿，不发送、不伪造 sources、不消费尝试。
- `prepareSummaryCreation(key,{memoryId,expectedMemoryRevision,expectedPolicyRevision,reason,expiresAt,includePrivate?,request},actor,beforeCommit?)`：人工精确摘要授权后，登记中性摘要观察并评估独立 pending 意愿；不直接制作或发送。
- `startCreation(key,intentionId,{action,accountId,target},actor,beforeCommit?)`：必须已有合法意愿；准备最终成品后停在 final-review。
- `evaluateGrowth({key,id,expectedRevision},actor,beforeCommit?)`：只取上述 Host 证据端口。

对应管理 API 为 POST `bili-source`（capture/revoke/learning）、GET `bili-source?id&revision`、POST `creation-intention`、POST `summary-creation`、POST `creation-start`、既有 `learning` 人审、`review` 最终作品人审、`submit` 和 `growth` evaluate。路由认证、字段白名单、body/key 权限及 UI 由对应模块负责；没有将维护 authorize/binding 开放为客户端字段。

摘要路径为：capture 稳定公开快照 → 显式单项学习候选 → 人工批准学习 → 展示并单独批准 exact 记忆摘要、账号/动作/目标/期限 → pending 意愿 → 显式开始制作 → 最终人审 → 一次提交意图。原始来源仍可只含 read/learn；获审摘要 alias 才有其独立 draft/publish。raw/private 全文不会自动送给 planner。

摘要授权按每个 grant 生成独立、有界 topic，因此同一记忆的不同目标不会合并或复用旧 pending。工作流捕获完整 action/account/target；恢复从原 work 读取。材料阶段与最终审核/提交/发前均解析 exact alias，不能只比较 target 而放过 account/action 变化。

Bili 撤源/刷新先建立应用 hold，再撤销旧学习来源；PolicyMemory 传播失败也会独立阻止旧作品。旧 snapshot 不删除，只可审计。失败后的旧来源不会自动复活；须显式 capture 新 revision、选择内容并重新人审。Host 单独撤销 Bili learn 或整体发布许可，同样阻断依赖旧事实的后续动作。

## 明示的自主计划

只有配置 `ports.runner.creationPlans()` 且操作者明确 start runner 后才运行。回调同步返回最多8条 `{key,topic,request:{action,accountId,target}}`，每批拒绝重复 key/topic 和超量计划。应用 wrapper 调用 `prepareCreationIntention` 后，在有合法意愿时才调用 `startCreation`。

runner 没有默认创作计划、自动批准、自动 submit 或自动启用。明确区分 ready-for-review、失败与未准备状态，不把“执行了回调”报告为作品成功。停机后不接受后续计划；实际政策窗口、参与度、额度及来源有效性继续由 runtime/workflow 控制。

## Host 维护能力

只返回 `app.maintenance`，没有 HTTP 自批入口：

- `inspect({domain:'code'|'outbox',ids,reviewer})`
- `archive({domain,ids,expectedRevision,reviewer,reason})`
- `list({domain,reviewer,offset?,limit?})`
- `read({domain,id,reviewer})`

所有操作复核当前 profile、同步维护许可、实际 Code/channel broker 绑定、bridge idle、无 running Code/待答交互、Code OFF、全局 Outbox 暂停且无 sending。Code 归档前必须先处理其热交互，相关投递须有明确终态。Outbox code-interaction 归档必须能读到对应冷交互；code-result 需对应已送达的原任务结果。creation 投递必须对应当前身份上下文中的作品。领域 archiveIn 继续负责 CAS、终态、无 unknown 锁、冷 hash/事件去重和同事务写入。维护不重新发送、不清掉 unknown，不替用户自动归档历史。

## 实际验证与边界

`application-integration.test.mjs` 使用实际临时磁盘 SQLite、真实 Request/Response API handler、源模块和合成 Host/transport/计划/发送端口。覆盖：

- Bili 构造惰性、单选学习 pending、人审后来源关联、混合材料无丢失。
- 权限撤销后迟到模型/读取不落盘，关闭排空后释放 owner 锁。
- 可信成长评测只到 evaluated，缺端口、伪造证据种类、撤权均拒绝。
- Code/Outbox 双域维护、缺实际绑定、OFF/暂停/交互与结果依赖守卫。
- 无手工 self.decide 的 pending 意愿与明示 runner 自主制作，只停在 final-review。
- Host 单独撤 publish 拒绝旧审核、提交、发前；真实 SQLite trigger 导致策略撤源传播失败时，独立 hold 仍阻旧作品。
- **实际 API 整链**：Bili capture → learning pending → 人工 reviewLearning → summary-creation → pending → creation-start → final-review → 人工 approve → submit → 一次合成 dispatch；随后撤源并实际关闭/重开数据库，拒绝旧批准副作用。原始来源始终只有 read/learn，raw Bili draft/publish 回调明确 false；planner 只收到获审 exact 摘要。
- 同记忆两个目标各自 pending/start，target/account/action 互换均拒绝；缺 Bili ports 重开也不能将已知来源退回外部 provider。

命令：`node --experimental-strip-types --experimental-test-isolation=none --test next/agent-v1/test/application-integration.test.mjs next/agent-v1/test/runner.test.mjs next/agent-v1/test/bili-materials.test.mjs`。本次最终运行38项通过；既有 application.test.mjs 另10项通过（包括合成本地 MP4 制作）。未自行执行统一构建。

没有真实 B站/QQ/DSH Host 登录、平台浏览或发布，没有真实/付费模型，没有正式数据迁移、安装、启停或浏览器视觉验收。本地合成端口不是平台兼容、长期自主创作质量、管理员真实身份或成长质量的证明。实际提供方还须确认账号/目标名单、额度、权限证据、版权/材料用途、生命周期与长期保留方案。
