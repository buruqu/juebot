> 原项目 README 的历史快照；本机路径已脱敏。当前公开使用说明以根 README 为准，历史链接可能指向未公开的本机证据。

# juebot：撅撅的本地行为链与原生管理候选

**0.3.0-dev.6 本轮接续（2026-10-29，未安装）**：本地完整链已补齐并通过937项最新测试（0失败/0跳过）：真实来信观察/自动复读/反馈，逐流管理与摘要共享/纠错，QQ社交和Code分流，B站材料→人工学习→精确摘要创作授权→意愿→最终人审→统一Outbox，及任务/出站/入站冷归档。活目录和历史候选486文件未改。见[最新验证](../VERIFICATION-AGENT-DEV6.md)与[完整本地范围](../next/agent-v1/LOCAL-COMPLETION-DEV6.md)。真实Host、认证HTTP、界面视觉、QQ/B站和真实模型仍未验；无正式管理工具，停在部署前。下文旧轮次状态、计数和“下一步”属于历史，当前能力/待验以本段及最新验证为准，主方案仍v0.7.0。

**0.3.0-dev.5 接续（2026-10-29，未安装）**：新增异常Code任务/会话的人工弃用与新会话轮转、交互完整冷归档及受管理维护入口。旧任务不重放，原文/去重/unknown投递证据不删除。最新本地837项通过，0失败/0跳过；活目录及五个历史候选共397文件未改。见[最新验证](../VERIFICATION-AGENT-DEV5.md)、[维护合同](../next/agent-v1/CODE-MAINTENANCE.md)和[B站材料接点](../next/agent-v1/RESEARCH-BILI-MATERIALS.md)。真实Host、认证HTTP、界面视觉和平台业务仍未验收；后文旧轮次保留为历史。

**最终培养目标（D022）**：让撅撅具有连续自我和自主选择，能像人一样维护自己的记忆、兴趣、关系与成长，并经营自己的QQ/B站身份；用户以Neuro-sama式体验作参照。详见[产品核心与验收主线](<../PRODUCT-CORE.md>)。下面是当前基础实现状态，完整体验尚未实现。

**创作能力（D023）**：QQ空间动态、B站读评论拟回复/看视频拟评论及自主制作视频投稿已纳入[创作运营方案](<../CREATION-OPERATIONS-PLAN.md>)；本地候选已有意愿/材料到最终作品、人审和提交意图链，实际平台尚未接通或发布。上述作品及既有B站动态均须人工审核最终内容，视频不能只审脚本。

## 2026-10-29 最新状态：设计v0.7.0与0.3本地候选

当前开发入口为 [next/agent-v1](../next/agent-v1/README.md)，候选版本 **0.3.0-dev.5**，未安装。已加入持久策略/局部设置、受来源与用途约束的记忆、自我状态/意愿/成长版本、可选模型端口、持久 Outbox/统一投递、独立 Code 任务、最终人审创作、本地文字卡静音视频制作，以及原生会话/审核面板和 Host/runner 桥候选。它把此前 S1a、S0 逻辑接为可本地验证的行为链；S2–S4 不再是完全未写，真实 S1b/S5 与产品效果仍待验。

**当前证据入口：[VERIFICATION-AGENT-DEV5.md](../VERIFICATION-AGENT-DEV5.md)**，构建、测试和哈希以最新验证记录为准。当前缺真实 DSH 管理工具，未安装、未正式 Host/认证 HTTP/浏览器验收，未连接 QQ/B站或请求真实/付费模型。QQ/DSH Code薄桥已离线实现，可信Host仍缺实际账号/管理员证明与受管理接线及实际工作区/策略验收；模型配置/预算仍 Open。关键词检索无语义效果承诺；视频是真实本地字幕文字卡/静音成片，没有 TTS、音乐或复杂制作。完整待验清单与独立打包命令见模块 README。

0.3 以完整 0.2 配置载荷为基础，新增 agent Host 默认禁用，`initializeEmpty:false`；一个原生 ModuleLoader 注册新面板 `juebot` 与旧设置面板 `juebot-setup`。不改活 bundle、封存 0.2 或已有安装，打包不是部署。

### 前一轮分层基线（历史，S1a交付时点）

- **0.1已装记录**：历史正式安装版本为0.1.0-dev.2，本轮未复验Host、GUI或市场运行态。
- **0.2本地候选**：0.2.0-dev.1配置候选已本地收口，未部署、未替换活包。
- **独立离线模块**：[next/social-v1](<../next/social-v1/README.md>)范围扩为打字计划/有限内存FIFO、表达禁用和新增repetition复读候选判断三段逻辑；未接Host、定时器、平台发送、配置持久化或语义模型。
- **S1a后端候选**：[next/conversation-v1](<../next/conversation-v1/README.md>)的身份、独立SQLite账本、权限范围只读服务/HTTP已本地完成；仅真实合成SQLite加模拟Host认证验证，详见[VERIFICATION-CONVERSATION.md](<../VERIFICATION-CONVERSATION.md>)，未正式挂载Host。
- **六项需求**：[设计v0.7.0](<../DEVELOPMENT-PLAN.md>)已纳入记忆模式、主动意愿/情绪、会话中心/日志、打字节奏、表达控制与自主复读。S1a后端候选本地完成；[S1b及S2–S5](<../SOCIAL-BEHAVIOR-PLAN.md>)仍待完成。S1b包括真实Host生命周期/认证挂载、原生会话中心与浏览器验收，设计版本不改变包版本。
- **已确认共享边界**：通用知识、表达和获准偏好可互通；具体私聊事实、群内隐私、Code材料按来源授权，不因关闭隔离自动互通。账号、模型预算与真实外发许可仍单独确认。

本轮研究见[RESEARCH-AUTONOMY.md](<../RESEARCH-AUTONOMY.md>)，实现和未验证范围见[VERIFICATION-SOCIAL.md](<../VERIFICATION-SOCIAL.md>)。下文GUI、Host与旧测试数字保留为对应阶段历史证据。

**复读按D021自主选择**：同群多人连续或隔消息复制同一消息时，只先形成候选，再由兴趣/状态决定是否“+1”，不强制每次跟上。**按用户纠正，复制粘贴零额外打字等待，绕过拟人打字队列**；表达、权限、频率、发前复核与真实统一Outbox仍保留，平台限速/在途发送不保证立即到达。自身/已知bot循环、同一人刷屏、过期/跨流/重复messageId不形成合法候选，禁用表达不因复读而豁免。social-v1 单独模块只判断候选，agent-v1 已接本地 Outbox 链；真实平台未接入。

六项要求及这次纠正均已整理进[开发方案第20节](<../DEVELOPMENT-PLAN.md#20-v070社交需求与离线交付>)、[社交详细合同](<../SOCIAL-BEHAVIOR-PLAN.md>)和[决策台账](<../OPEN-QUESTIONS.md>)。设计仍为v0.7.0；这里是方案完整性说明，不表示六项功能已经上线。

## 2026-10-28 配置候选收口（历史，未部署）

已装版本按交接记录仍为0.1.0-dev.2；本轮未通过真实Host复验。0.2.0-dev.1配置候选已修复并完成本地验证，详见[candidate交付记录](../candidates/0.2.0-dev.1/VERIFICATION.md)及[身份兼容评估](../candidates/0.2.0-dev.1/IDENTITY-COMPATIBILITY.md)。没有正式升级、重启、平台接入或迁移。

**活`bundle`不得作为构建目标。旧默认build/pack入口已改为拒绝执行；使用下方候选命令。** 下文安装、GUI端口、Host与154项测试为历史证据，不代表本轮重新验证。

**历史安装记录：`0.1.0-dev.2` 曾通过正式插件管理器安装到 desktop profile并应用，无需当轮代理重启Host。** 当时启用只读控制面和原生页面入口，独立存储后台为 **inactive**；未启用QQ、模型、真实Code或正式数据文件。本轮未重新核验这些运行状态。

历史GUI地址为<http://127.0.0.1:55150>，本轮未验可达性，使用前从真实运行配置重新确认。历史只读页入口为侧栏 **juebot**，只有Host诊断、能力边界、未决前置及“刷新状态”“返回对话”；0.2编辑页仍仅候选，完整会话中心尚未实现。

## 2026-10-28：前轮研究与双平台规划更新（历史）

- 已整理[插件采用矩阵](<../PLUGIN-ADOPTION.md>)：哪些机制由juebot自行实现、哪些插件仅辅助DSH、哪些可作为平台适配候选。
- 新增[QQ＋B站共同成长方案](<../CROSS-PLATFORM-PLAN.md>)：共同身份、来源/范围受控的双向记忆与学习、B站浏览证据、草稿审批和出站回执。
- 用户确认QQ先预留官方机器人和个人QQ两种通道、验证后再选；B站先逐条确认发布、验收后再另行开放有限自动运营。
- 用户指定的[dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale)按原始源码核验并纳入参考，**未安装、未登录或执行B站动作**。不直接继承其自动发送和默认配置。
- 按用户单独要求已安装 **dshmarket@1.73.1**，管理器返回applied，当前页面`plugins.tab`中`dsh-market`注册active；入口为「插件 → 插件市场」。未独立验收实际视觉与市场交互，未自动安装其它候选。
- 本轮不改juebot业务源码/schema，不启用正式账号、模型或学习；下表154项测试是历史基线，非本轮重测。详见[本轮交付与回退](<../VERIFICATION-PLANNING-MARKET.md>)。

## 只读安装阶段已验证与未验证（历史，非本轮复验）

| 内容 | 当轮证据 |
| --- | --- |
| 安装 | `plugin_manager` 返回 applied，版本0.1.0-dev.2 |
| 真实Host | Node v24.21.0 / SQLite 3.53.4；内存schema、FTS5、短词、合成私域反例与清理均ok |
| Client | 当前连接页已注册侧栏juebot入口；使用原生main key，不替换conversation |
| 生命周期 | 实际停用后Provider/侧栏消失，恢复后重新出现；最终包已恢复启用 |
| 本地验证 | 154/154测试，严格核心/声明检查与JS语法通过 |
| 实际画面与已认证页面GET | 无浏览器控制，未独立验收；注册和静态测试不代替视觉结论 |
| 直接HTTP安全边界 | 未认证GET为401、错误Origin为403；不把拒绝当成功读取 |
| 正式业务 | 存储后台未激活，无QQ/模型/Code接入 |

诊断在Host激活时仅执行一次 `:memory:` 合成检查并关闭。刷新只读冻结快照；失败显示未知/过期，不显示伪造运行状态。没有搜索浏览器凭据或启动替代浏览器/服务。旧受限进程启动故障不因此视为已修复。

## 说明与证据

- [开发方案](<../DEVELOPMENT-PLAN.md>)、[决策台账](<../OPEN-QUESTIONS.md>)、[社交行为方案](<../SOCIAL-BEHAVIOR-PLAN.md>)、[自主行为研究](<../RESEARCH-AUTONOMY.md>)。
- [历史安装与验收说明](<../VERIFICATION-CONSOLE-INSTALL.md>)、[当轮安装/运行证据](<../evidence/2026-10-28-console-installation.json>)。
- [当前dev.2归档](<../artifacts/dsh-juebot-0.1.0-dev.2.tgz>)及[打包清单](<../artifacts/bundle-manifest.json>)。
- 历史：[第二轮存储验证](<../VERIFICATION-STORAGE-HOST.md>)、[SQLite探测](<../evidence/2026-10-28-sqlite-probe.json>)、[首轮记录](<../VERIFICATION-P0.md>)。

## 旧实现代码分层（历史，当前入口见agent-v1）

- [contracts.ts](<../src/contracts.ts>)、[runtime.ts](<../src/runtime.ts>)：权限/消息结构、普通与Code路由，未接真实执行器。
- [memory.ts](<../src/memory.ts>)、[storage.ts](<../src/storage.ts>)：作用域/来源检查、SQLite事务/版本/授权/索引；数据库归属校验、CAS、来源版本失效、删除标记与正常重开已经本地验证。
- [host.js](<../bundle/host.js>)、[sqlite-driver.js](<../bundle/sqlite-driver.js>)：仍禁用的可选存储后台。只有显式合法路径与初始化选项才可打开数据库；不自动建目录，不在失败时自动删用户文件。
- [console-host.js](<../bundle/console-host.js>)、[diagnostics.js](<../bundle/diagnostics.js>)：已激活的只读控制面，注册受认证GET及 `JuebotStatus.getStatus` Inspect。
- [client.js](<../bundle/client.js>)：真实Client模块的main/侧栏注册、双语、主题token、超时/Abort与过期状态处理。只用内置React，不导入Harness UI包或创建另一套应用。

## 业务规则不变

**关闭Code只停止新开发输入，当前运行任务继续并保留结果。** agent-v1已有持久任务与受控结果投递链；真实沙盒任务执行器尚未接入。接纳开关不等于撤权、手动停止、预算阻断或总停机；撤权可阻断工具/自动外发，不能丢弃结果。

管理员身份/关系及获准偏好可以在授权范围共享，具体私聊事实默认私有。agent-v1本地候选在检索、生成返回及发送前重验来源/策略/上下文版本；真实平台隐私与撤销效果仍须获准样本验收，Code不进入社交学习。

所有授权、配置、来源与生命周期接口仅供可信Host代码，不能作为模型自我授权工具。当前会话的完全权限不会自动授权给QQ或未来Code Agent。

## 旧存储实现限制（历史；agent-v1检索为有界关键词方案）

- FTS5按Unicode码点选trigram或短词 `instr` 回退；不提供中文分词/简繁/同义质量保证。
- 文本固定0分＋ID排序，不使用不可见语料的全库BM25评分。默认500、最多2000个元数据候选；有界而非完整召回。
- 向量按provider/model/generation/dimension隔离，仅有界精确cosine，不是ANN或真实embedding质量证明。
- tombstone禁止同ID复活并清理当前正文/索引/向量，不是WAL、备份或已发送内容的安全擦除。
- 路径预检拒绝常规网络路径和叶子链接（含悬空），但不是抗本机恶意TOCTOU/hard-link的OS沙箱。
- 正常重开不等于断电/崩溃恢复；Q006/Q007未被测试擅自定案。

## 0.2及旧实现本地复现（历史；0.3命令见agent-v1 README）

本轮使用既有 Node v24.21.0、TypeScript 6.0.3；声明的最低Node范围未逐版本验证。构建和打包不自动安装依赖，不启动其所属应用。

```powershell
$node = '<LOCAL_PATH>
$tsc = '<LOCAL_PATH>
$python = '<LOCAL_PATH>
& $node scripts/build-candidate.mjs 0.2.0-dev.1 $tsc
& $node --experimental-strip-types --experimental-test-isolation=none --test test/core.test.ts test/storage.test.ts test/host.test.mjs test/console-host.test.mjs test/client-contract.test.mjs
& $node --experimental-strip-types --experimental-test-isolation=none --test test/control.test.ts test/settings-*.test.mjs test/candidate-package.test.mjs
& $python -I -B scripts/pack-candidate.py 0.2.0-dev.1
```

严格类型检查覆盖src与发出的声明文件；JS桥接/Client做语法、运行或静态合同检查，后者不是React渲染测试。已链接安装的包修改代码后需重新核对应用/刷新/重启要求，不保证文件编辑会自动更新现有GUI。

## 影响与回退

本轮新增agent-v1本地行为链、管理桥候选与独立0.3打包，不部署、重启、改profile或迁移正式库。以下保留历史安装回退说明：当轮曾通过正式管理器安装本包，作用于该profile的所有会话；直接依赖仅新增本包，既有直接依赖版本未改。安装器有peer警告和依赖剪裁输出，详情见历史验收说明，不宣称依赖树完全无变化。未改动maibot-bridge、未设置Git作者、未提交/推送，也未启用正式业务或重启Host。

回退优先正式停用或移除 `@local/dsh-juebot`；不要手工覆盖整个profile。安装前私有快照已排除Git/打包，可能含配置秘密，不应分发。旧项目及既有不兼容插件没有被擅自修复或授予版本豁免。

接续以[agent-v1说明](../next/agent-v1/README.md)及[当轮证据](../VERIFICATION-AGENT.md)为准：S2–S4已有本地候选，先完成源码收口/独立打包，再验真实S1b Host/认证/原生浏览器与获准S5试点。候选构建不代替安装许可或真实验收；管理员证明、正式数据路径、账号名单、模型预算和Code权限仍按未决台账处理。

## S1a会话后端候选（历史独立模块边界，未正式挂载）

[next/conversation-v1](<../next/conversation-v1/README.md>)提供namespaced身份、注入连接的独立SQLite事件/正文分表账本、权限范围只读服务及HTTP后端候选；真实合成SQLite结合模拟Host认证本地贯通，见[VERIFICATION-CONVERSATION.md](<../VERIFICATION-CONVERSATION.md>)。身份包含bot/persona/connector/issuer/account/type/remoteId，bindingRevision独立，读取拒绝旧绑定。

独立application_id `0x4a554543`、schema1与owner_namespace，不是旧MemoryStore schema2，不迁移现存库；模块不open文件路径、不读profile。HTTP没有写入口或模型工具，principal/权限来自注入接口，目前仅合成认证模拟；正式认证、Host生命周期/挂载、原生会话中心与浏览器验收属于S1b，尚未完成。全部新实现位于next，未改旧src、活bundle或0.2候选。
