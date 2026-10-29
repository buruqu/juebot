# 本地 B 站读取与材料端口

仅参考既有 RESEARCH-BILI-MATERIALS.md 固定的 Whale 0.4.6 / `8b0009f8ce2ebdc421afcb2e727b19ac18912ec6` 接口机制。没有复制、导入或安装上游实现，不继承其 Cookie、缓存、下载或调度副作用。本模块没有登录、真实平台读取或发布许可。

`host/bili-read-source.js` 导出 `createBiliReadSource({transport,authorize,budget,now,timeoutMs=10000,maxResponseBytes=524288})`。所有能力显式注入，构造不联网。`read({account,bvid,page=1,limit=20,sort=0},{signal}={})` 仅访问固定 HTTPS `api.bilibili.com/x/web-interface/view` 与 `/x/v2/reply`；每次请求均 GET、omit credentials、禁止重定向，响应体有字节、时间和字段边界。无重试、全局 fetch、Cookie 查找、媒体 URL 访问、模型或 CLI 调用。account 是规范 JSON `['bilibili',issuer,accountId]`。page 1–100、limit 1–50、sort 0/1/2；一次读取最多两次 HTTP。

`authorize({operation:'read',...request})` 必须同步返回 `{allowed:true,revision}`，读取过程中反复检查相同 revision。`budget.consume({account,bvid,endpoint,requests:1})` 每次 HTTP 前同步返回 true；已经发出的请求不自动退还额度。transport 是 `(url,{method,redirect,credentials,signal,headers})=>Promise<Response>`，Host 应确保自身不会偷偷补充凭据、重定向或重试。`now()` 返回可信毫秒时钟；其余入口也不提供默认时钟或凭据。

`host/bili-materials.js` 导出 `createBiliMaterials({store,reader,authorize,now,namespace='default'})`：

- `capture({id,expectedRevision,request},{signal})` 创建版本；`refresh` 是同一 CAS 接口，已有 ID 固定账号和 BV，不能重新绑定。id 最多128字符并符合既有创作来源标识格式。
- `revoke({id,expectedRevision})` 显式撤销并增加来源版本，不删除旧版，也不能复活撤销 ID。
- `get(id,revision?)` 经当前 read 授权读取不可变旧版供审计，返回 current source/status 与指定 snapshot；该读取不能使旧版重新可用。
- `materials(intention,target)` 直接适配 CreativeWorkflow 材料端口。全部 intention.sources 必须是此服务保存的 ID/当前 revision；每次检查当前 draft **和** publish 权限、精确目标与期限。混合其他来源需 Host 显式组合，不能略过意愿依据。
- `learningSource({id,revision,conversationKey})` 返回 `requiresHumanApproval:true` 的 PolicyMemory 来源候选及材料，不写入 PolicyMemory；不默认授予 publish，不批准跨流共享。候选期限取保存期限与当前 learn 许可期限交集。
- `close()` 拒绝新写入，取消并等待在途 capture/read 退出；不会关闭 caller-owned StateStore。读源另有自己的 close，由 Host 负责生命周期。

材料 authorize 是 Host 同步回调，参数含 operation（read/save/revoke/draft/publish/learn）、id、revision、target，适用时含 request、account、bvid。必须返回 `{allowed:true,revision,expiresAt:null|未来毫秒}`；没有“公开可读即授权学习/创作”的默认规则。save 在读取前后与落盘前复验同一许可。来源与用途权限由 Host 维护，不从 HTTP body、B站文字或模型输出取得。

StateStore 中每个快照版本独立保存，另有 CAS 头指针；存 contentHash、取得时间、BV/aid/cid/作者及评论 ID、page/truncated 和 `metadata-and-top-level-comments-only` 覆盖说明。标题/简介与有限顶层评论不证明看过视频或完整评论树。ID 保留字符串，危险数值 ID 拒绝。refresh/revoke 才改变 catalog revision，材料回调不 HTTP、不写库、不按当前时间生成版本，因此重复读取稳定。正文不截断，超过64条/每条4000字符/合计64000字符会明确拒绝，不能以不完整内容冒充成功。

快照校验同时复算内容 hash 和材料投影。最多1024来源，历史版本占用既有 StateStore 总容量；没有自动删历史，也不承诺无限保存。改变来源、版本、目标、期限或权限会使旧材料失效；最终作品仍逐件人审。这里未实现视频观看、字幕、登录、账号发布、学习自动批准或真实平台协议验收。

## 应用桥补充

`application.js` 通过显式 `ports.bili={transport,authorizeRead,budget,authorizeMaterials,timeoutMs?}` 构造并管理本服务，按应用 namespace 与当前 bot/persona 分区。API 使用 actor 校验后的 `app.biliSources`，不直接暴露底层 reader。capture 支持异步 `beforeCommit`（在 HTTP 返回后、任何快照写入前复查 API/身份权限）及同步 `beforePersist`（已检查当前 snapshot CAS 后、提交前执行保守来源失效）。revoke 的同步 `beforeCommit` 在完整 revoke 授权及 CAS 预检后执行；Promise 回调拒绝。

应用的 learning 入口必须显式选取 `itemId` 和 `proposalId`，不会把整页自动记忆。它登记按 snapshot/version/key 分开的只含 read/learn 的来源，再调用 `runtime.proposeLearning` 形成待人工审核候选。刷新或撤源不会复活旧来源或旧记忆。

应用保存独立的 `applicationHold` 事实：`minimumRevision` 大于所读 snapshot revision 时，该旧版仅可审计，不能继续学习、创作或外发。该事实先于旧来源失效写入；即使后续 PolicyMemory 写入失败，也不能继续使用旧批准。若刷新失败留下保守阻断，须显式重新 capture 到新版本并重新提交学习人审，不会自动重跑或复活旧来源。source read 同时返回 hold 元数据；成功刷新后旧 hold 仍作为事实保留，但新版本达到 minimumRevision 即不受该下限阻断。

经人工批准的记忆摘要可再单独授权用于精确账号、动作、目标和期限。该 alias 只给获审摘要文本增加 draft/publish，不为原始 Bili/private 来源增加 publish。每次材料读取、作品审核、提交及发前都复核 exact alias、原始来源当前 active/revision/learn/期限、Bili snapshot head 和 hold。Host 的整体 publicationAuthority 仍能禁止发布。直接使用 raw Bili 材料则始终要求 draft 和 publish 两项当前许可。

缺少 Bili ports 时，应用仍识别已保存的 Bili head、alias 与 hold；这些已知来源不能退回外部 provider 或绕过复核。混合来源必须全部保留并逐项授权，原始私聊事实不能因改走摘要端口自动公开。

本地验证（实际隔离 SQLite，合成 transport/授权/模型计划）：

`node --experimental-strip-types --experimental-test-isolation=none --test next/agent-v1/test/bili-materials.test.mjs`
