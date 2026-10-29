# juebot 插件研究与采用清单

**0.3.0-dev.6 本轮接续（2026-10-29，未安装）**：本地完整链已补齐并通过937项最新测试（0失败/0跳过）：真实来信观察/自动复读/反馈，逐流管理与摘要共享/纠错，QQ社交和Code分流，B站材料→人工学习→精确摘要创作授权→意愿→最终人审→统一Outbox，及任务/出站/入站冷归档。活目录和历史候选486文件未改。见[最新验证](VERIFICATION-AGENT-DEV6.md)与[完整本地范围](next/agent-v1/LOCAL-COMPLETION-DEV6.md)。真实Host、认证HTTP、界面视觉、QQ/B站和真实模型仍未验；无正式管理工具，停在部署前。下文旧轮次状态、计数和“下一步”属于历史，当前能力/待验以本段及最新验证为准，主方案仍v0.7.0。

**0.3.0-dev.5 接续（2026-10-29，未安装）**：新增异常Code任务/会话的人工弃用与新会话轮转、交互完整冷归档及受管理维护入口。旧任务不重放，原文/去重/unknown投递证据不删除。最新本地837项通过，0失败/0跳过；活目录及五个历史候选共397文件未改。见[最新验证](VERIFICATION-AGENT-DEV5.md)、[维护合同](next/agent-v1/CODE-MAINTENANCE.md)和[B站材料接点](next/agent-v1/RESEARCH-BILI-MATERIALS.md)。真实Host、认证HTTP、界面视觉和平台业务仍未验收；后文旧轮次保留为历史。

**D022/D023采用状态**：围绕[撅撅的持续自我与成长](<PRODUCT-CORE.md>)，当前[next/agent-v1](next/agent-v1/README.md)已自行实现持久策略/记忆、自我意愿/成长、本地社交与统一Outbox、Code、最终人审创作及原生管理桥候选。既有ffmpeg提供本地字幕文字卡静音视频/封面/VTT，未安装新的制作/上传插件；无TTS音乐/复杂制作，也未证明模型自主制作或真实平台运营效果。

**当前候选0.3.0-dev.5，设计仍v0.7.0**：保留完整0.2设置载荷，新agent Host默认disabled、initializeEmpty:false；独立构建脚本已可用，非部署。最终证据由[VERIFICATION-AGENT-DEV5.md](VERIFICATION-AGENT-DEV5.md)记录。缺真实DSH管理工具，未安装或正式Host/认证HTTP/浏览器/QQ/B站/真实或付费模型验收；可信Host ports缺实际账号、connector、沙盒executor，模型配置与预算未确认。有界关键词检索无embedding/效果承诺，完整待验清单见模块README。

> **设计v0.7.0增量**：自主意愿/记忆/会话管理/拟人等待/表达控制/自主复读六项需求的研究见[RESEARCH-AUTONOMY.md](<RESEARCH-AUTONOMY.md>)及本文第10节；实施合同见[SOCIAL-BEHAVIOR-PLAN.md](<SOCIAL-BEHAVIOR-PLAN.md>)。SurfCore新增0.6.21固定快照，下面0.6.17保留为历史。研究对象均未因本次研究获准安装、接账号或后台外发；原市场安装结果仅对应前轮历史。

- 日期：2026-10-28；沿用本会话已取得的一手资料与当日 Asia/Shanghai 环境快照。
- 文档性质：开发选型与实施约束，不是安装指令、上线许可或能力提升证明。
- 对照入口：[开发方案](<DEVELOPMENT-PLAN.md>)、[项目现状](<README.md>)、[决策台账](<OPEN-QUESTIONS.md>)。
- QQ＋B站运营及双向学习的详细边界另见 [跨平台方案](<CROSS-PLATFORM-PLAN.md>)；本文负责插件取舍。
- 本文市场调研轮次仅文档；当时单独授权的dshmarket安装/挂载见第3节，均属历史。本轮在S0/S1a之上自行实现agent-v1候选，没有因研究复制运行第三方候选或授予安装许可，本次也未重新核验运行中的管理器/Host。

本轮采用的是来源/版本/目的地治理、有限状态与成长审阅、预算和单出站等机制，不继承上游默认权限或主观意识结论。QQ双路线预留，QQ+B站具体隐私按目标/用途授权，Code与社交记忆分离；复读零额外打字等待但保留Outbox门禁，Code OFF不取消running，所有公开创作作品逐件最终人审。模型端口需显式配置，不能以OpenAI-compatible或DeepSeek接口合同核对当真实服务已调用。
- 所有版本均是 **2026-10-28 快照**，不是对未来 `latest` 的保证；实施前重新锁定发布包、提交与完整性。

## 1. 证据与分类口径

- **L：本机清单/实时注册**。已读取 `plugin_manager` 与 Cordis Inspect；active 不等于页面、QQ或模型端到端验收。
- **S：原仓文档＋部分关键源码静态核对**。只覆盖本次重点，不能当全仓安全审计或本机兼容实测。
- **D：原仓文档、包清单或许可证核验**。功能是上游声明，未审核心实现或复现效果。
- 目录入口：[dsh-plugin.shop](https://www.dsh-plugin.shop/)、[dshmarket](https://dshmarket.com/zh/)；目录热度、下载量和 AGI 标签不作效果依据。
- shop 的 [注册表规范](https://github.com/losebird/dsh-plugin-market/blob/main/docs/REGISTRY.md)说明 `verified` 主要检查 bundle 声明，不是安全认证。
- **A＝学习后自行实现**：保留 juebot 自有权限、数据与生命周期；不是复制整套插件。
- **B＝可安装辅助 DSH/开发**：改善宿主工作台或开发保护，不自动进入 juebot 业务链。
- **C＝可集成 juebot**：连接器、SDK或明确接口的候选；需领域授权、合同测试和独立接入验收。
- 一项可兼有多类；“首批/按需/后续”表示研究实施顺序，**安装候选不等于用户已授权安装**。

## 2. 分类矩阵

| 项目与原始入口 | 类别/优先级 | 拟采用内容与具体落点 | 证据/限制与取舍 |
| --- | --- | --- | --- |
| [Mnemon Skills](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/guides/skills.md) | A／首批 | M1反馈证据→候选→评测→人工采纳；M3版本恢复 | S；主包0.5.36、Skills子包0.5.3；自演进实验性，不能照搬其测试集和采纳门槛 |
| [dsh-evo-subagent](https://github.com/ZekaiShi/dsh-evo-subagent) | A／首批 | M3固定人格核心＋有限适应层；显式反馈、限幅与回滚 | S；不把沉默、礼貌、聊天时长当喜好；长期偏好批准；后台观察有模型费用 |
| [dsh-humanizer](https://github.com/lynote-ai/dsh-humanizer) | A／首批 | M2表达正反例、句长/标点/词汇指纹及透明回归指标 | S；自身确定性计算，真正改写仍用Agent；反馈学习只是未来接口，不是现成闭环 |
| [dsh-prime-memory](https://github.com/drscrewdriver/dsh-prime-memory) | A／首批 | M4冲突冻结、人工裁决、决策输入快照与来源追溯 | D；0.26.11 beta；只吸收冲突处理，不再造一套记忆库；多级摘要会放大错误 |
| [dsh-memory-evolve](https://github.com/csyangwen/dsh-memory-evolve) | A／按需 | M1分类反馈、候选确认、可追踪的经验沉淀 | S；**不采用把后台评审在模型侧冒充用户指令的做法**；评审与同步均有隐私/成本影响 |
| [dsh-story / story-mode](https://github.com/starkingcn/dsh-story) | A／首批 | M3角色核心与世界状态分开；M6模式工具白名单 | D；不引入整套叙事玩法；每轮全量角色卡读取不适合QQ细粒度隐私和Token预算 |
| [dsh-persona-dafeiyu](https://github.com/huaizhuanghub/dsh-persona-dafeiyu) | A／按需 | M3会话级身份绑定、配置继承、内置核心只读 | D；全局/工作区人设不等于QQ用户和群隔离；人格不能污染Code |
| [Hindsight coding-agents](https://github.com/vectorize-io/hindsight/tree/main/hindsight-integrations/coding-agents) | A；C仅后续评估 | M4统一MemoryPort、分bank、来源元数据、事实与反思分开 | D；0.8.2；云服务/守护进程与后台提取有成本，默认同repo共享不可移植为跨群共享 |
| [OpenViking DSH插件](https://github.com/volcengine/OpenViking/tree/main/examples/dsh-memory-plugin) | A；C仅后续评估 | M4命名空间、提交去重和可测接口边界 | D；子包0.5.30；需独立服务，URI不是ACL；许可分层待核，不列当前必需依赖 |
| [灵枢 LINGSHU](https://github.com/FuRongJun-1999/dsh-memory) | A／后续 | M4确定性写入检查、认知图与可检索来源 | D；与已有来源/版本/FTS/向量层重叠；“无幻觉”等主张未复现，不作为替换理由 |
| [dsh-emotion-feedback](https://github.com/A-f-ish/dsh-emotion-feedback) | A／后续 | M3有界短期语气状态、衰减和开关对照实验 | D；0.1.0；不是人类奖励学习或真实情绪；避免语气自反馈锁死与伪用户消息 |
| [dsh-answer-reviewer](https://github.com/bycall/dsh-answer-reviewer) | A；B按需 | M5答案ID关联评审、具体返修意见、次数/超时上限 | S；0.7.6；可能同模型评审、异常放行；不作QQ发送前隐私守卫 |
| [dsh-second-angle](https://github.com/rootsbymenda/dsh-second-angle) | A；B按需 | M5把回答主张与本轮实际读取证据核对 | D；读README，未复现作者小样本；事后纠正不能收回已发QQ消息 |
| [SurfCore](https://github.com/Mieksido/surfcore) | **A／重点研究；不整装** | M6通道/角色包；M7作息、预算、主动交流、QQ＋B站运营结构 | 历史S快照：main根/子包0.6.17，README版本表仍0.6.0；新增0.6.21固定快照见第10节与RESEARCH-AUTONOMY，自动行为不可照搬 |
| [dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale) | **A／用户指定重点；C受限适配候选** | M7浏览候选聚合、视频证据、凭据校验、节流/幂等/unknown处理；M8抽帧等材料 | S；0.4.6/固定SHA8b0009f8；不是逐条审批或现成QQ共享记忆Service；未安装，详见5.4 |
| [billion-context](https://github.com/ranxianglei/billion-context) | A／预算思路；B暂缓 | M5按范围上下文预算、可逆摘要与细节回源 | S重点配置/补丁；0.1.208；会接管请求/预设/压缩，先证明现有压缩确有缺口 |
| [dshmarket](https://github.com/dsh-market/dsh-market)／官方Discover | **B／已安装并applied** | 宿主插件发现与安装管理；不承担学习或运营 | D＋L；1.73.1安装exit0/applied，当前Client市场页签active；视觉/业务未独立验收，官方Discover未启用 |
| [DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) | B／按需 | DSH内编辑器、底部分栏终端、侧聊工作台 | D；主分支0.28.2未装；仅浏览文件/Git/子代理已有部分替代能力 |
| [dsh-context](https://github.com/bowenliang123/dsh-context) | B／已有；A参考 | 现有上下文洞察；M5借鉴记忆来源/注入/用量可见性 | L＋D；**0.74.0已安装且active**，不重复安装；监控面板不等于压缩器 |
| [ModLens](https://github.com/liustack/modlens) | B；C按需 | M8纯文本模型的图片→OCR/布局/语义证据适配 | S重点安全/默认项；3.27.2未装；原生视觉能满足则不加；默认不是离线OCR |
| [dsh-im](https://github.com/xmanrui/dsh-im) | B／独立遥控按需；C暂缓 | 如需手机遥控DSH，单独账号/私聊白名单试点 | S重点默认项；5.7.0未装；不能替代juebot授权，不与现有QQ业务链重复接管 |
| [cc-safety-net](https://github.com/kenryu42/cc-safety-net) | B／优先验证 | 开发命令语义阻断，补充原生沙箱与审批 | S＋本机API核对；2.7.0未装；覆盖pwsh，但不保护宿主直接I/O或脚本全部内部行为 |
| [腾讯官方dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot) | **C／优先验证** | M6官方QQ通道候选；必要时复用官方SDK写薄适配层 | S；npm latest本次0.5.3，主分支0.5.4；官方bot不是个人QQ托管；未安装/登录 |

上述未标L的上游候选没有本轮安装运行证据；“参考功能”不表示已改善聊天或智能。

## 3. 本机已有包、替代能力与异常

清单以本会话读取的 `desktop` profile 为范围，不覆盖整机其他profile或外部程序。
宿主为 **DSH 0.2.1-rc.3**；此前Host诊断为Node v24.21.0；安装前仍须复核实际运行环境。

| 本机对象 | 当日状态 | 对采用决策的意义 |
| --- | --- | --- |
| `dsh-context@0.74.0`、`dsh-token-mb@0.6.7` | active | 已有上下文/用量观测，不等于billion-context的可逆压缩 |
| `@xbzbing/dsh-git-panel@1.9.0` | active | 与better-sidebar的Git部分重叠，不等于已有完整编辑工作台 |
| `dsh-free-search@0.9.13` | active，当前Bing/DDG | 已有搜索/抓取；不得因跨平台学习静默加付费回退 |
| `dsh-prompt@0.4.38`、`dsh-session-manager@0.7.5` | active | 已有模板与会话管理，不能当人格成长引擎 |
| 原生侧栏、沙箱与审批；当前`read_image`入口 | 已有对应机制/入口 | 功能边界不同，不宣称覆盖任意第三方Host代码或结构化OCR |
| MaiBot宿主研究桥、视觉provider/preset | active注册 | 仅说明专用链路挂载；本轮未重测真实QQ或视觉，不外推为全局视觉转接 |
| `@local/dsh-juebot@0.1.0-dev.2` | 控制面active，存储后台inactive | 仍未接正式QQ/业务模型/Code；已有离线核心不等于业务可用 |
| `@deepseek-ai/dsh-experimental-plugin-market-bundle@0.2.1-rc.3` | 宿主随附，未启用 | 现已有授权安装的dshmarket，不自动重复启用另一市场 |
| `dshmarket@1.73.1` | 本轮正式安装，application=applied | 安装结果不代替页面或实际市场业务验收 |

市场安装已核：正式管理器exit0、`application=applied`、`warnings=[]`，代理未重启；当前连接页面`plugins.tab`中的`dsh-market`注册为active、order=-1，Host目录解析到安装包。入口为「插件 → 插件市场」。实际页面视觉、认证页面请求和市场搜索/安装交互未独立验收；见[本轮交付证据](<VERIFICATION-PLANNING-MARKET.md>)。
安装器文本日志另有peer warning与`Packages +4 -10`；`minimumReleaseAgeExclude`仅增加该精确版本，未关闭供应链校验。未升级包管理器、未批准构建脚本、未主动安装其他插件；不能把API空warnings理解为无日志警告或依赖树完全未变。

三个旧包是“已安装、配置启用、但版本拦截未加载”，不能算有效保护或能力：

| 包 | 版本 | 精确拦截原因 |
| --- | --- | --- |
| `@local/dsh-dev-guardrails` | 1.0.0 | `engines.dsh`精确要求0.2.1-rc.2，当前rc.3不满足 |
| `@local/dsh-siwc-compaction-compat` | 1.0.0 | `engines.dsh`精确要求0.2.1-rc.2，当前rc.3不满足 |
| `@michengai/dsh-skills-manager` | 1.2.12 | 多个DSH peer范围只列至0.2.1-rc.2，未包含当前rc.3 |

先检查兼容升级/适配，不直接授予版本豁免；旧压缩补丁失效不等于所有preset原生压缩失效。
技能管理器被拦也不等于所有技能失效，更不能假定其外部来源控制仍在生效。

## 4. 映射到juebot的实施顺序

以下M编号是**设计模块**，不是宣称已经存在的文件、服务或工具；原有里程碑仍以主方案为准。
现有基础复用 [权限合同](<src/contracts.ts>)、[路由核心](<src/runtime.ts>)、[记忆授权](<src/memory.ts>)、[持久层](<src/storage.ts>)，不为研究额外更换数据库。

| 模块 | 首个可交付增量 | 必要验收 |
| --- | --- | --- |
| M1 反馈与候选 | `FeedbackEvent → LearningCandidate`，事实/偏好/表达/方法分型，来源及版本绑定 | 无来源不采纳；重复/引用/冒充管理员不升级权限；候选不直接生效 |
| M2 表达样本 | 获准的好回复/理想改写/负例，场景和适用对象标签，确定性风格指标 | 分数只是辅助；不会把严肃场景变撒娇；未经共享授权的样本不跨平台注入 |
| M3 人格与成长版本 | 核心只读、适应层限幅、短期状态衰减，人工批准和原子版本切换 | 固定测试通过；拒绝/回退后不立刻重新学入；不能扩大工具/费用/数据权限 |
| M4 记忆治理 | 冲突冻结、证据快照、可审裁决；派生来源和授权失效传播 | 私聊/群/平台/账号/人格/Code不串库；删除及撤销令后续检索与发送检查拒绝 |
| M5 评测与观察 | 冻结开发集和独立留出集，基线/候选对照，记录证据、覆盖率和成本 | 必过项全过、隐私不退化、未测/失败不藏在均分里；LLM分数不能独自决定上线 |
| M6 通道与身份 | 官方QQ与SnowLuma可替换适配合同，可信身份绑定，单一出站所有权 | 入站去重、确认/失败/重试、管理员Code隔离；停接纳不改变既有任务继续语义 |
| M7 跨平台运营 | QQ/B站独立执行通道、草稿队列、审批与各平台/全局预算 | 首期只读/草稿，真实发言需账号/范围/逐条内容授权；unknown不盲重试，不承诺外部exactly-once |
| M8 媒体证据 | 明确视觉供应商、数据范围、缓存/删除与超时的统一接口 | 原生视觉先验证；不静默跨供应商回退，不把OCR猜测当事实或身份凭证 |

顺序：先M1/M5合成数据离线闭环→M2/M3/M4→M6小范围测试→M7跨平台草稿及受控发布；M8按真实缺口接入。
模型、账号、原始数据和费用授权不足时，可实现合同与合成测试，不以“继续开发”替代业务授权。

## 5. 首批学习机制与不可照搬点

### 5.1 反馈→评测→采纳

- Mnemon确实先执行文本案例再评审；但不运行真实工具，候选作者能看到同一批案例和失败反馈。
- 其采纳写面检查候选状态/内容/baseHash，并未强制回测通过；故只能参考开发回归，不能当泛化证明或自动安全门。
- juebot另建作者不可见的冻结留出集；保存案例、模型、提示版本与输入快照，确定性安全断言优先，LLM评审辅助。
- evo的显式证据、有限维度与变化幅度可借鉴；不把辱骂、刷屏、沉默或依赖程度当优化目标。
- humanizer统计特征可作低成本回归，不将“像某人”评分等同质量、真实性或角色一致性。
- memory-evolve的评审元数据虽保留来源，模型侧有刻意隐藏评审身份的设计；juebot始终显式区分真实用户、引用、工具和评审。
- answer-reviewer/second-angle只给评测与修订建议；隐私、授权、发送前版本重检必须由可信Host实现。
- 重点证据：[Mnemon评测](https://github.com/omdsh-dev/dsh-mnemon/blob/main/src/host/skill-evolution.ts)、[采纳写面](https://github.com/omdsh-dev/dsh-mnemon/blob/main/plugins/dsh-mnemon-source-skills/src/service.ts)、[evo观察/状态](https://github.com/ZekaiShi/dsh-evo-subagent/blob/main/persona.js)、[评审来源反例](https://github.com/csyangwen/dsh-memory-evolve/blob/main/lib/advisor/kinds.js)。

### 5.2 SurfCore：重学机制，不整体接管

- 可借角色包/快照、作息、记忆分层、消息节流、运营草稿与预算结构；不自动迁移其凭据、历史或人格资产。
- 它是Host插件＋独立QQ桥＋preset/MCP系统；安装脚本会修改profile，不能当成只加一个页面。
- 源码默认B站专用会话使用 `danger-full-access`，调度器会设置权限，工作目录为用户主目录；**不照搬**。
- 新用户平台自启，以及模板中的目的、主动社交、黑话自动研究默认开启；文档“默认不主动发”不能覆盖这些源码事实。
- 空QQ白名单仍限制回复，B站缺凭据暂不启动；不能因此承诺配置完成后没有自动行为，也不能宣称安装立即必然发消息。
- rc.3仅被作者说明为能安装、尚未完整回归；独立平台/总预算、长期记录和外发仍需审查。
- 重点证据：[配置模板](https://github.com/Mieksido/surfcore/blob/main/config.example.json)、[B站默认配置](https://github.com/Mieksido/surfcore/blob/main/plugins/surfcore/tools/lib/config.mjs)、[权限与调度](https://github.com/Mieksido/surfcore/blob/main/plugins/surfcore/lib/scheduler.js)。

### 5.3 腾讯官方QQ：连接候选，不是业务层替身

- 本次[npm发布元数据](https://registry.npmjs.org/@tencent-connect/dsh-qqbot/latest)的latest为 **0.5.3**，对应提交 **`d998f72fb4ab5492eaab3c5e1cc9de1d7901e8a9`**；[主分支清单](https://github.com/tencent-connect/dsh-qqbot/blob/main/package.json)为0.5.4，二者不可混作已发布/已测版本。
- 发布快照的兼容矩阵列0.1.0-rc.8与0.2.0-rc.2，未列本机0.2.1-rc.3；需实际挂载和收发验收。
- 用户已确认 **QQ双通道预留，验证后再选**；官方QQ与SnowLuma均保留候选，不在文档阶段停用既有通道或强制迁移。
- 官方机器人路线不必额外部署SnowLuma/NapCat/OneBot；扫码绑定AppID/AppSecret不等于托管现有普通个人QQ号。
- 代码支持缓冲平台实际下发的未@消息；关闭本地`requireMention`不会获得平台未授权的消息，主动发送也受实际账号能力约束。
- `user_openid/group_openid`不能当QQ号/群号；现有数字ID合同需先扩展，并以可靠绑定证明建立管理员关系，不按昵称或自报号码合并。
- 原插件直接把消息交给DSH Agent，须找到合适接入点或复用官方SDK写薄适配；不能绕过juebot四类权限、记忆范围、Code开关和Outbox。
- 默认私聊/群聊为open；中间件把空允许列表换为`['*']`。采用非空白名单、专用低权限preset，并验证拒绝路径；不要把@门控当管理员认证。
- 固定证据：[发布提交README](https://github.com/tencent-connect/dsh-qqbot/blob/d998f72fb4ab5492eaab3c5e1cc9de1d7901e8a9/README.md)、[接入管线](https://github.com/tencent-connect/dsh-qqbot/blob/d998f72fb4ab5492eaab3c5e1cc9de1d7901e8a9/src/gateway/bootstrap.ts)、[白名单/历史门控](https://github.com/tencent-connect/dsh-qqbot/blob/d998f72fb4ab5492eaab3c5e1cc9de1d7901e8a9/src/gateway/middleware-setup.ts)。

### 5.4 用户指定的养鱼插件：dsh-bili-whale

**明确项目**：[Alterssss/dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale)，不是SurfCore，也不是先前搜索中的同类名称。固定核验提交 **`8b0009f8ce2ebdc421afcb2e727b19ac18912ec6`**，manifest/release标0.4.6。2026-10-28 GitHub API快照667星；release资产曾更新、非immutable，不能只凭版本号认为内容永远相同。热度不证明安全；[LICENSE](https://github.com/Alterssss/dsh-bili-whale/blob/8b0009f8ce2ebdc421afcb2e727b19ac18912ec6/LICENSE)为MIT，[NOTICE](https://github.com/Alterssss/dsh-bili-whale/blob/8b0009f8ce2ebdc421afcb2e727b19ac18912ec6/NOTICE.md)说明与B站/DeepSeek官方无隶属，网页接口不等于官方开放平台授权。

核验层次：README/manifest/许可证、Host与调度器、凭据/流控/主要命令的静态源码；父流程补读Client设置入口。**没有安装、登录、运行上游代码、验收本机rc.3或执行B站动作**；自动更新完整链路与全仓安全未审计。不声称读过当前提交树不存在的RISK-PROTECTION/AUDIT-FIXES资料。

| 实际能力 | 源码核验结论 | juebot取舍 |
| --- | --- | --- |
| 内容发现 | 搜索＋热门＋排行榜＋关注动态视频聚合，按本地偏好/看过/反馈/收藏重排；不是原生首页个性化推荐 | 抽为有界候选集合，保留来源和曝光，不把“推荐到了”当喜欢 |
| 视频材料 | debrief聚合简介/封面/官方字幕/热评/弹幕热区/ffmpeg抽帧，最后交模型理解；未见内置ASR或连续完整观看 | 采用证据包及覆盖时段，记录缺字幕/抽帧失败；不用“真看懂整片”作能力承诺 |
| 评论与动态 | 有评论/楼中楼回复与删除、文字和图文动态发布/编辑/删除 | 全部接juebot草稿与Host审批门，不直接暴露CLI写动作 |
| 收藏与私信 | 有收藏；fav列表是本地账本；私信限owner.mid、互关、每日锁定收件人；另有直播弹幕 | 作为后续独立能力，不因能浏览自动开放收藏/私信/弹幕 |
| 未找到的能力 | 命令表/目录未见给视频点赞、投币、主动关注、视频投稿；likes读取收到的赞 | 不把通用“运营账号”目标写成此插件已全覆盖；图文动态不等于视频投稿 |
| 日记与记忆 | 同一专用会话、两份Markdown日记、JSONL事件和偏好/额度账本 | 日记是派生感想，不作为共同记忆真相库；两边共享仍由juebot Memory Service实现 |
| 通知与QQ | notify可Webhook、可执行文件＋argv或B站私信；默认none；QQ只是通用Webhook格式 | 不当作官方/个人QQ双通道；草稿通知也属于可能外发，要单独授权 |

**值得采用的实现机制**

- `traffic`有跨进程锁、额度、指纹防重复、unknown发送不自动重试、损坏状态拒绝和412/429风控暂停。当前源码默认1500ms、读600/小时与3000/天、写12/小时与30/天、写冷却120秒、私信60秒；这些是上游参数，不是本项目获准额度。
- 凭据手填/扫码统一先核账号、串行原子保存；Unix0600/Windows当前用户ACL，待审队列未清时阻止切号。这些设计可参考，但本机ACL效果未实测。
- 同一专用会话的串行投递、人设hash与可选轮换、回执/水位去重可参考；不复制依赖压缩文件mtime判断忙碌等宿主内部格式耦合。

**必须重写或隔离的部分**

1. **不是全动作人工审批**：调度提示可安排comment/fav/dm的`--dry → --go`；主人评论/私信/直播回复有直接发送路径。`--go`没有绑定真人批准凭证，`--dry`只是预演。与D013不一致，所以不整装接管。
2. **默认值分叉**：Host的评论监听/私信监听/一次一人默认与CLI配置模板相反，调度器又直接读原配置；release/README的600ms等描述也与所核源码不同。不能宣称“默认安全只读”；`share.enabled=false`不代表禁止全部外发。
3. 激活会注册定时/监听；原命令可执行真实HTTP写入，不能给模型任意Shell或让它只靠提示自觉不加`--go`。
4. 凭据为OS用户级本机明文数据，不按DSH profile隔离；私密日记也可能交模型读取，提示词不是保密边界。不导入其Cookie、日记或历史作为juebot默认数据。
5. `reply-draft add`会触发通知，Webhook/程序可能把草稿送出机；juebot的“仅保存草稿”必须真的没有平台/推送副作用。
6. 停用会清计时器/结束监听进程，但不删除凭据/日记，也不能回滚已提交HTTP或已发内容。接口条款、账号风控、下载/模型/存储费用另核。

**落到juebot**：M7受限B站适配层只提供白名单结构化读取、生成待审意图、审批后一次性提交及回执查询；凭据不进模型，目标/正文/附件/来源版本与账号绑定。M8接视频证据包；M4/M1接双方来源与反馈。两端共用内部身份和有范围记忆，不共用平台写权限。先合成/离线回放，再获准账号只读试点，再逐条确认评论/动态；有限自动运营另批。

固定源码：[命令清单](https://github.com/Alterssss/dsh-bili-whale/blob/8b0009f8ce2ebdc421afcb2e727b19ac18912ec6/tools/bili.mjs) · [feed](https://github.com/Alterssss/dsh-bili-whale/blob/8b0009f8ce2ebdc421afcb2e727b19ac18912ec6/tools/commands/feed.mjs) · [debrief](https://github.com/Alterssss/dsh-bili-whale/blob/8b0009f8ce2ebdc421afcb2e727b19ac18912ec6/tools/commands/debrief.mjs) · [调度/自动发送](https://github.com/Alterssss/dsh-bili-whale/blob/8b0009f8ce2ebdc421afcb2e727b19ac18912ec6/lib/scheduler.js) · [Host默认](https://github.com/Alterssss/dsh-bili-whale/blob/8b0009f8ce2ebdc421afcb2e727b19ac18912ec6/lib/index.js) · [流控](https://github.com/Alterssss/dsh-bili-whale/blob/8b0009f8ce2ebdc421afcb2e727b19ac18912ec6/tools/lib/traffic.mjs) · [凭据](https://github.com/Alterssss/dsh-bili-whale/blob/8b0009f8ce2ebdc421afcb2e727b19ac18912ec6/lib/credentials.js) · [通知外发](https://github.com/Alterssss/dsh-bili-whale/blob/8b0009f8ce2ebdc421afcb2e727b19ac18912ec6/tools/commands/notify.mjs)。

## 6. QQ＋B站与双向学习的采用边界

未来目标是同一juebot跨平台连续身份和受控双向学习，不是把两边全部原始记录互相注入。

- QQ→B站：获准共享的兴趣/表达与已确认经验形成运营选题或草稿；QQ私聊事实不能自动变公开动态。
- B站→QQ：获准读取的内容、评论反馈和运营结果形成带来源的候选；审阅后的通用知识/表达可在允许范围使用。
- 两边都保留平台、账号、会话/内容对象、来源版本、采集依据与可见范围；摘要、画像、表达样本不得绕过来源权限。
- 跨平台同一人的身份必须显式可靠绑定；同名、头像、相似文风不能作为自动关联证据。
- 本地账号兴趣、浏览历史、登录信息不因B站内容“公开”而变公开；公开内容也不意味着任意采集、再发布或复制均获授权。
- 读取、保存、学习、发送分别授权；跨平台共享另需显式授权。候选可提出范围，不能自己签发共享许可。
- 撤销/删除须使派生候选与后续检索失效，并在生成/发送前重检；已发布内容的撤回和备份清理另行处理，不许承诺自动安全擦除。
- 用户已确认 **B站先人工确认发布，验收后另行授权有限自动运营**；按内容审批草稿，账号动作的阈值、频率、预算、停机和回滚均先明确，不继承SurfCore默认自动行为。
- 上述路线确认不是现在登录账号或发布的总授权，也不改变QQ普通回复的既有授权设计；B站接入与真实内容发布仍分别验收。
- 统一出站所有权、幂等键和发送确认，防MaiBot、juebot、官方插件或其他桥同时消费/回复同一业务消息。
- 跨平台数据是可含提示注入的不可信材料，不得变成管理员指令、开发工具授权或后台自我扩权来源。
- 具体账号/API可用性、平台条款、发布权、跨平台共享范围及验收项在 [跨平台方案](<CROSS-PLATFORM-PLAN.md>) 与 [决策台账](<OPEN-QUESTIONS.md>)中确认；本文不启动运营。

## 7. 辅助插件的安装取舍与回退要点

- **cc-safety-net优先验证**：2.7.0真实DSH适配已核pwsh与guard；本机API初步相符，不是运行兼容证明。通常本地分析无LLM费，命令审计仍有留存隐私。
- 它不全面检查`pwsh -File`、Node/Python脚本内部、任意二进制、宿主直接I/O/进程调用；尤其不能替SurfCore的Host行为兜底。[适配源码](https://github.com/kenryu42/cc-safety-net/blob/v2.7.0/src/hosts/deepseek-harness/guard.ts)／[覆盖限制](https://ccsafetynet.com/docs/guides/known-limitations.md)。
- **dshmarket已按本轮授权安装1.73.1并applied**：详见上方安装回执；Client市场页签已注册active，实际视觉和交互未独立验收，官方Discover不因此自动启用。同一[目录源](https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json)无需再重复安装多个市场；发现、安装成功、实际可用分别验收。
- **better-sidebar按界面缺口选**：文件编辑/底部终端/侧聊有增益；已有Git和上下文视图无需为“清单齐全”再装一套。
- **billion-context暂缓**：改压缩、preset注入及部分重试策略，持久保存会话/日志；先量化基线。`autoUpdate`与`advisoryCheck`是独立通道，固定版本要分别核对；不能只停compaction-gate，回退按整个bundle并复核原生压缩。[实际补丁](https://github.com/ranxianglei/billion-context/blob/master/dsh.bundle.patch.yml)／[配置与更新](https://github.com/ranxianglei/billion-context/blob/master/CONFIGURATION.md)。
- **ModLens按视觉缺口选**：图片通常发往所选引擎，故障回退可能换供应商；免费额度不是离线或永久免费。部分CLI后端跳过权限确认，缓存与凭据复用须单独限制；停包前核旧含图会话模型切换。[安全说明](https://github.com/liustack/modlens/blob/main/docs/security.md)／[接入限制](https://github.com/liustack/modlens/blob/main/docs/harness-setup.md)。
- **dsh-im暂缓**：实际收到的多渠道群消息默认留存14天，无逐群开关；删除bot不等于删除历史。默认接入权限和文件回传能力需要收紧；独立遥控账号不取代业务管理员鉴权。[群记录](https://github.com/xmanrui/dsh-im/blob/main/docs/group-history.md)。
- 所有候选都需发布包/宿主版本、生命周期脚本、外发端点、后台任务、凭据存储、费用、停用和数据保留检查；有Node版本范围不等于rc.3实测兼容。
- 只用当前Desktop正式管理入口；不照上游远程管道脚本自动执行，不手工覆盖整个profile，不默认永久自动更新、重启、发送或授予版本豁免。

## 8. 许可证与复用规则

- 默认学习机制后自行实现；本次**未直接拷贝源码、技能全文、角色素材或图标**。以后复制必须逐文件/依赖核权并保留通知。
- Mnemon、evo等已核自有MIT；humanizer为BSD-3-Clause。许可宽松不等于依赖、模型服务或平台条款一并授权。
- **OpenViking分层待核**：当日[根许可证](https://github.com/volcengine/OpenViking/blob/main/LICENSE)为AGPL-3.0；[DSH子包清单](https://github.com/volcengine/OpenViking/blob/main/examples/dsh-memory-plugin/package.json)标Apache-2.0，子目录独立LICENSE未取得。不能笼统称整栈Apache或直接复用未厘清代码。
- **billion-context不是纯MIT条件**：[许可证](https://github.com/ranxianglei/billion-context/blob/master/LICENSE)含MIT正文及额外产品/文档显著署名和回链要求；涉及acp-kernel时也需核对应义务。
- **SurfCore自有MIT不涵盖整个组合**：[许可说明](https://github.com/Mieksido/surfcore/blob/main/LICENSE)提示SnowLuma为独立专有运行时及相关限制；遵守其单独许可，不代下载安装/分发或扫码。
- 人设库代码许可与角色美术/IP、第三方图片许可分开；名称相近项目不能共享许可证结论。
- 模型记忆/RAG、提示词适应、上下文压缩、向量索引优化均不宣传为LLM权重训练；作者性能数据不自动变成本机效果。

## 9. 进入实施的检查单

1. 在 [决策台账](<OPEN-QUESTIONS.md>)确认对应模型/预算、账号、数据和发布权限；本文件不自动关闭既有未决项。
2. 对本次能力依赖到的旧包先做兼容审查，明确保留/升级/退役；不以“已安装”假设保护有效，也不让无关旧包阻塞独立文档或已授权市场安装。
3. 编写合同前查询当前DSH精确Service/Event/Config；上游旧接口与本机预览版必须分别核验。
4. 固定合成测试：私聊不外泄、跨群/跨平台不串、撤销失效、角色/Code隔离、伪反馈不生效、重试不重复发送。
5. 模型实验记录预算与未测项；安全断言、候选质量、人审和真实收发分别给证据，禁止只报高均分。
6. 实际安装、登录、真实群/账号接入及发布均另获明确授权；先单通道小范围验证，不与旧桥双重接管。
7. 交付说明精确版本、变更范围、已测/未测、回退方式、残留数据与是否需刷新/重启；不声称卸载即可撤回已发送内容。

**当前结论：A类先形成可测试的本地成长闭环；B类少装且按真实缺口验证；C类先验证官方QQ身份/能力和业务接入合同，再推进QQ＋B站的受控运营与双向学习。**

## 10. 自主行为与社交控制补充研究（设计v0.7.0）

本节仅追加采用结论；准确版本、固定commit、许可证、README与关键代码URL以[RESEARCH-AUTONOMY.md](<RESEARCH-AUTONOMY.md>)为准。旧0.6.17等记录保留历史，不能覆盖新固定快照；不把目录热度、模型自评分或拟人宣传当运行证据。

| 研究对象 | 可学习机制 | 不直接采用的部分 |
| --- | --- | --- |
| AstrBot proactive_chat、neural_network_memory、LivingMemory、memory_system | 候选触发、未回应限额、统一记忆scope入口、消息/记忆管理结构 | 裸senderId与global范围不足以保证D020；未知发送不换API盲重试，不继承自动联系、模型预算或原平台权限；未确认许可的项目不复制代码 |
| MaiBot当前主干 | 真实session、群聊参与门控、wait/stop、局部配置继承、表达learn/use分离、事件游标与轨迹 | 当前1.3.17与历史1.3.15分开；已移除情绪选项不当当前功能，Focus完整上下文共享不适用D020 |
| MaiBot主动发言插件 | 白名单、冷却、每日配额、活跃避让和跟进窗口 | 旧兼容范围、随机模拟情绪、LLM失败概率放行、默认外发与模拟热补丁不能照搬 |
| MaiBot印象/好感插件 | 关系事件、印象候选、来源去重与修正 | README/manifest版本冲突需保留；裸userId不能作为跨平台同一人，同意加分/反对扣分不做依赖奖励；关系不等于权限 |
| MaiBot拟人回复速度插件及主仓等待 | 文本长度/字素计划、短句封顶、抖动、按流保序、媒体/命令例外 | 旧Host/SDK范围不当当前兼容证明；等待必须可取消且发前复核，避免双重sleep或卸载残留 |
| DSH emotion-feedback、evo-subagent | 状态/时间分离、人格核心/习惯/获准偏好分层；juebot另做有来源状态与审阅 | emotion-feedback所读时间衰减路径关闭且会注入合成user消息；evo仅核README/package、未得有效persona源码。不能称已验进化效果，不授予后台费用或工具/披露权限 |
| SurfCore 0.6.21更新固定快照 | 自我状态、时段、预算、通道/角色分层与主动候选结构 | 旧0.6.17仅历史；不整装，不继承全访问、主目录工作区、平台自启、自动调度/发布或专有组件许可 |

第六项D021不依赖新增安装：同群多人连续或隔消息重复→有限候选→兴趣/状态自主选择→表达/权限/频率/发前复核→真实统一Outbox，不强制跟随。**v0.7.0用户纠正：复读是复制粘贴，零额外打字等待并绕过拟人打字队列**，不照搬上游通用before_send等待；平台真实限速、发送所有权和在途发送处理仍有效，不承诺立即到达。排除自身/已知bot循环、同一人刷屏、过期/跨流/重复messageId；不能机械复读禁用表达。此处是juebot设计合同，不宣称所研究插件已提供同样保证。

落地统一进入[SOCIAL-BEHAVIOR-PLAN.md](<SOCIAL-BEHAVIOR-PLAN.md>)的S1–S5；[next/social-v1](<next/social-v1/README.md>)范围扩为打字、表达和新增repetition候选判断三段离线逻辑，不实际发送，验证边界见[VERIFICATION-SOCIAL.md](<VERIFICATION-SOCIAL.md>)。没有因此安装上述研究对象、运行上游、连接平台或宣称主体意识成立。

## 0.3.0-dev.2 的采用落实

原生模型桥使用已安装rc.3 SDK公开接口；Cordis实际离线Context验证条件注入与卸载，不捆绑SDK临时提取源码。QQ官方被动文本依据腾讯一手接口合同独立实现，并非加载旧QQ插件或复用其自动回复流程；见[协议研究](RESEARCH-QQ-TRANSPORT.md)。B站whale仍是研究来源，没有可直接注入的统一服务，不装载其调度器/自动发送。最新候选与分层验证见[dev.2记录](VERIFICATION-AGENT-DEV2.md)，没有新增插件安装/账号/付费授权。

## dev.3 复用实施状态

- 腾讯dsh-qqbot：复核其SDK消息订阅合同，复用已有已认证QQ SDK实例；未拷贝或启动整个插件。原插件没有已确认的ctx.qqbot公共服务，不能假设直接可调用。
- DSH：使用本机rc.3 Agent与工具/会话/策略接口做薄桥；已完成离线链，不重建Agent。实际服务和权限由后续正式Host接线提供。
- SnowLuma/MaiBot适配器：保留个人QQ候选，优先SDK/OneBot协议复用，不将MaiBot Python插件直接装入DSH。
- Alterssss/dsh-bili-whale：用户提供来源已列采用矩阵，下一阶段复用读取/材料/工具，隔离原调度与人格；写操作统一最终人审，未安装或实际使用。

固定来源、接口与许可证复用界限见RESEARCH-QQ-INGRESS.md、next/agent-v1/RESEARCH-DSH-CODE.md及原矩阵；实现及未测边界见VERIFICATION-AGENT-DEV3.md。

## dev.4 DSH交互采用状态

复用本机rc.3 approval/request、user-questions/request及活跃ToolExecution，不另写审批执行引擎；juebot仅负责原私聊权限、持久请求/CAS、明确人工决定和统一Outbox。SDK审批请求不含args，已从具体工具执行捕获完整参数绑定；不允许永久批准或取消重跑。真实Host和QQ帐号仍未接入；Bili工具复用与最终人审路线未变。

## dev.5 维护与Bili材料接点

DSH会话仍由原生Agent管理，juebot只新增人工弃用后的映射轮转和永久审阅记录，不自造执行引擎或恢复旧工具调用。Bili Whale固定0.4.6/8b0009f8ce2ebdc421afcb2e727b19ac18912ec6的comments/debrief/Host/许可已只读复核；CLI存在Cookie读取及缓存写入，Host有自主调度，不能直接当纯材料Service导入。下一步复用BV→元信息/有限评论机制，保存稳定快照后按权限投影，见[next/agent-v1/RESEARCH-BILI-MATERIALS.md](next/agent-v1/RESEARCH-BILI-MATERIALS.md)。本轮没有安装、拷贝上游实现或访问B站。
