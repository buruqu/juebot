# juebot：自主行为、记忆、聊天流与表达研究

2026-10-28，配套设计v0.7.0。本次只读公开GitHub资料、固定提交的关键源码和用户截图；没有安装或执行参考插件，没有运行上游测试，没有账号、平台或模型调用。以下区分源码事实、文档声明和juebot设计选择。

结论：可组合“有来源的自我状态＋有限意愿候选＋参与调度＋发前门禁”，不能把项目名中的意识、情绪、神经网络或成长直接当作真实主观意识或效果证明。用户要求落在[六项功能合同](SOCIAL-BEHAVIOR-PLAN.md)，实施顺序先身份/会话/日志，再记忆模式和自主行为，最后接受控出站。

## 1. 研究快照与采用方式

固定提交是本次读取基线，不保证此后仍为上游最新；分支名、README横幅和manifest有冲突时分别记录。许可证仅记录核查结果，不是通用复用许可判断；本次没有复制插件实现代码。

| 项目 | 本次版本/提交 | 读取层次与许可线索 | 采用 |
| --- | --- | --- | --- |
| AstrBot proactive_chat | metadata 1.2.6；`77a1d408ccd003a9d34ad4f51acfb8fc17bc35f5` | README、调度/门控/review/发送关键源码；AGPL-3.0 | 借触发、复核、未回应限额，不搬发送器 |
| AstrBot neural_network_memory | 1.0.0；`081ed4e5b84f1357899272afeb4cba31b90c3ea0` | README、入口、affinity/learner/store；未确认LICENSE | 仅参考有界状态，不复制 |
| AstrBot LivingMemory | 2.7.3；`ac4114012f9462ce8d17ecd001687dbed4e95af9` | README、scope及recall关键源码；AGPL-3.0 | 借统一作用域入口，不搬全局共享 |
| AstrBot memory_system | 1.2.0；`01b730afd23940d8b34c1e98874e52ffdd0b1678` | README、adapter/database/WebUI/schema；未确认LICENSE | 借消息/记忆管理结构，重新做隔离及鉴权 |
| MaiBot主仓 | pyproject 1.3.17；`6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3` | 版本/许可证、聊天流/配置/学习/调度/监控/发送关键源码；GPL-3.0 | 借原生聊天流信息架构与事件账本机制 |
| MaiBot proactive_talk_plugin | 2.0.1；`4d3ee361f7a1864937d036b89b7e942800e65175` | README、manifest、manager/controller/hotfix；声明GPL-3.0-or-later但LICENSE文本含占位 | 借冷却/配额，拒绝随机情绪和失败放行 |
| MaiBot impression_affection_plugin | manifest 2.5.0；`9777bf8e8c8c410e73b23dfe42849735977d056c` | README、manifest、plugin/affection_service；LICENSE MIT | 借关系事件去重、置信度与纠正，不把分数当权限 |
| MaiBot human_reply_speed | 1.0.1；`0e9a31889e766f58ff8717c8a536285ba2827639` | README、manifest、hooks/calculator/unload；LICENSE MIT | 自行实现纯计算、保序与取消保护 |
| DSH emotion-feedback | 0.1.0；`59b6544ec130a4873f4f0419dd4b9eb01a15a279` | README、package、lib/index.js；package声明MIT | 借状态/时间分离，不搬隐式用户消息注入 |
| DSH evo-subagent | 1.2.0；`b215c56d8619d92a2a00fae3525b3c6371b151f0` | 本轮仅README及package；package声明MIT，未取得有效persona源码正文 | 借人格/习惯/获准偏好分层，效果与关键实现不作结论 |
| SurfCore | 0.6.21；`e2bae364841f330c70c810c5909a26ed3c17743a` | README、package、PURPOSE_OUTREACH及purpose-engine；package声明MIT | 借意图来源及额度结构，不整装、不继承默认外发 |

MaiBot三项插件在固定的[官方市场清单](https://github.com/Mai-with-u/plugin-repo/blob/f64cfb4e0f6b275ce5682e35d02a56cde64368e4/plugins.json)中可找到。列入市场不证明兼容、效果或安全。本轮对AstrBot/DSH公开仓的查阅也不声称已在本地市场完成搜索、安装或运行验收。

## 2. AstrBot：可取机制与实际缺口

### 主动聊天

[proactive_chat调度服务](https://github.com/Pancakes-Labs/astrbot_plugin_proactive_chat/blob/77a1d408ccd003a9d34ad4f51acfb8fc17bc35f5/core/services/scheduler_service.py)与[门控](https://github.com/Pancakes-Labs/astrbot_plugin_proactive_chat/blob/77a1d408ccd003a9d34ad4f51acfb8fc17bc35f5/core/features/gating_feature.py)拆分触发间隔、免打扰和未回应限制。默认未回应上限3，0表示不限；后者不能作为juebot默认。新消息处理会重置/取消相关调度并识别自身回声。

[review](https://github.com/Pancakes-Labs/astrbot_plugin_proactive_chat/blob/77a1d408ccd003a9d34ad4f51acfb8fc17bc35f5/core/features/review_feature.py)检查后续消息和终止状态，但不能据此宣称全部配置/免打扰在最终发送时均已重验。[sender](https://github.com/Pancakes-Labs/astrbot_plugin_proactive_chat/blob/77a1d408ccd003a9d34ad4f51acfb8fc17bc35f5/core/services/sender_service.py)存在异常后换核心API尝试路径；结果不确定时可能导致重复。juebot改为唯一出站意图、unknown核对和最终Host检查。

### 记忆与关系

[neural_network_memory的affinity](https://github.com/tniany/astrbot_plugin_neural_network_memory/blob/081ed4e5b84f1357899272afeb4cba31b90c3ea0/memory/affinity.py)主要是关键字驱动的有界分数，不是通用自我意识。学习与存储路径依赖裸sender_id及文件名处理，不能区分应用、平台账号、群和私聊全部命名空间；写失败也不能仅依日志而继续向用户宣称记住。juebot需要事件来源、持久化结果和独立关系作用域。

[LivingMemory的memory_scope](https://github.com/lxfight-s-Astrbot-Plugins/astrbot_plugin_livingmemory/blob/ac4114012f9462ce8d17ecd001687dbed4e95af9/core/memory_scope.py)将session/user/global集中解析，并提供白名单和人格过滤入口。其global属于完整作用域选择，不等于“只共享通用知识、表达与获准偏好”；昵称/别名也不能当人物绑定证明。juebot保持逐条来源、用途、受众及修订检查。

[memory_system数据库](https://github.com/Zxin-Pro/astrbot_plugin_memory_system/blob/01b730afd23940d8b34c1e98874e52ffdd0b1678/core/database.py)有session相关字段，但关键检索以裸userId为主，不能以“有该列”证明隔离。其[配置schema](https://github.com/Zxin-Pro/astrbot_plugin_memory_system/blob/01b730afd23940d8b34c1e98874e52ffdd0b1678/_conf_schema.json)和README的WebUI默认启用描述不一致；启用时还需单独审计监听地址和空密码情形。juebot继续使用DSH原生鉴权页，不另起公网管理页。

## 3. MaiBot：截图结构、局部设置与时间线

当前[版本文件](https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/pyproject.toml)为1.3.17，README局部旧横幅不作为版本依据。[变更记录](https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/changelogs/changelog.md)记载1.3.7移除了实验性情绪特点选项，1.3.15调整私聊频率为暂停回复；不能照旧教程承诺当前能力。

[聊天流设置弹窗](https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/dashboard/src/components/chat-stream-settings-dialog.tsx)与用户截图共同支持这些信息需求：真实会话列表、消息/日志切换、账号与会话元信息、默认/局部/实际生效值、频率/暂停、额外Prompt、表达和黑话的学习/使用独立开关。juebot采用此结构，不复制截图中的私人消息、群号、人设Prompt或图片。

[配置解析](https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/common/utils/utils_config.py)提供局部规则优先级，但无匹配时学习/使用默认开启不直接继承。[表达学习器](https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/learners/expression_learner.py)可保存未审核表达候选；juebot另需“禁止使用样本”与“禁止最终句式”两层，不能只删除样本就认为模型不会自行生成同句话。

[官方配置](https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/config/official_configs.py)将长期记忆、表达共享组和Focus机制分开。Focus的完整Planner上下文共享不符合本项目已确认的选择性共享边界；隔离开关必须同时管理检索、缓存和旧模型上下文。

[调度器](https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/maisaka/turn_trigger/scheduler.py)处理防抖、消息触发和动态门控；不能据此把“无人消息时主动找人”当作已实现。[动态门控](https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/maisaka/turn_trigger/dynamic_gate.py)的阈值/计数反馈可以借作决策摘要，但权重不是juebot已验证参数。

[监控事件账本](https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/maisaka/monitor/event_store.py)及[增量事件](https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/maisaka/monitor/planner_delta.py)提供session/run/cycle、eventId、游标和baseEventId机制。juebot用它们组织可核对的决策过程：来源、规则、工具结果、用量、选择与结果；不要求采集隐藏推理全文，不在运行日志重复存私聊正文。上游72小时/1万条不自动变成本项目保留策略。

### 市场插件补充

- [proactive_talk_plugin](https://github.com/yhny1001/proactive_talk_plugin/blob/4d3ee361f7a1864937d036b89b7e942800e65175/proactive_manager.py)：其情绪检测含TODO和随机标签，部分判断错误路径放行；[manifest](https://github.com/yhny1001/proactive_talk_plugin/blob/4d3ee361f7a1864937d036b89b7e942800e65175/_manifest.json)适配范围0.9–0.11，并非当前1.3.17。只借名单/配额/冷却，不搬热补丁和失败放行。
- [impression_affection_plugin](https://github.com/heitiehu-beep/impression_affection_plugin/blob/9777bf8e8c8c410e73b23dfe42849735977d056c/plugin.py)：消息去重与印象更新可借鉴；manifest2.5.0与README3.0/3.5描述冲突。关系分数不能替代权限，裸userId不能跨平台归一，也不按服从/附和奖励依赖。
- [human_reply_speed](https://github.com/RaTaiHok/human_reply_speed/blob/0e9a31889e766f58ff8717c8a536285ba2827639/hook_handlers.py)：按session串行等待，命令窗口跳过等待，适配范围仍需核验；[卸载入口](https://github.com/RaTaiHok/human_reply_speed/blob/0e9a31889e766f58ff8717c8a536285ba2827639/plugin.py)未见完整取消所有等待的处理。juebot自行做有界队列和最终重验。

MaiBot[主仓发送器](https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/chat/message_receive/uni_message_sender.py)也有typing等待；不能插件和主仓各sleep一次。上游不同插件的速度参数仅是参考，本项目默认12字素/秒、150–6000毫秒、±10%为可调离线假设。

## 4. DSH：状态注入与意愿引擎

[emotion-feedback源码](https://github.com/A-f-ish/dsh-emotion-feedback/blob/59b6544ec130a4873f4f0419dd4b9eb01a15a279/lib/index.js)评估模型自己的输出，通过关键字或额外模型更新情绪，并向后续回合注入合成user来源。空闲衰减参数存在不代表已生效，所读实现关闭该时间衰减路径。juebot采用带来源/时间的状态，避免自身输出循环强化，也不把内部状态假装为用户新指令；额外模型默认启用不被本项目继承。

[evo-subagent README](https://github.com/ZekaiShi/dsh-evo-subagent/blob/b215c56d8619d92a2a00fae3525b3c6371b151f0/README.md)和[package](https://github.com/ZekaiShi/dsh-evo-subagent/blob/b215c56d8619d92a2a00fae3525b3c6371b151f0/package.json)描述工作区人格、会话习惯、获准偏好和独立路由。本轮源码请求未取得有效persona正文，因此只采用概念分层，不能声称已经验证自动进化、持久化或权限实现。

SurfCore的[意愿说明](https://github.com/Mieksido/surfcore/blob/e2bae364841f330c70c810c5909a26ed3c17743a/docs/guides/PURPOSE_OUTREACH.md)与[purpose-engine](https://github.com/Mieksido/surfcore/blob/e2bae364841f330c70c810c5909a26ed3c17743a/src/purpose-engine.js)区分来源、目标、风险、冷却及配额，有助于把“想做什么”记成可审阅候选。但启用缺省值、仅显式false才拒绝的环境检查、0代表不限额及换QQ承载的回退方式均不能原样用于juebot。0.6.21是本次新增快照，原采用矩阵0.6.17属于历史读取，不冒充同一版本。

原用户指定的B站参考仍为dsh-bili-whale，未被SurfCore替换。本轮所有参考只用于设计，不获得安装、登录、自动发布或完全访问权限。

## 5. 落到juebot的具体取舍

| 用户需求 | 采用的机制 | juebot需要补上的约束 | 本轮产物 |
| --- | --- | --- | --- |
| 记忆隔离/共同记忆卡 | 独立会话与统一scope入口、分类索引 | 来源/用途/受众/修订；模式切换清旧上下文；私域仍按批准范围 | 合同，尚未接持久层 |
| 主动意愿/情绪/拒答 | 事件驱动状态、冷却/额度、候选和review | 不随机伪造情绪、不自我强化、不以关系改权限；可停可纠正 | 合同，尚未实现调度器 |
| 后台日志和单聊天面板 | 真实session、游标事件账本、局部规则和生效值 | 原生鉴权、数据ACL、写成功再广播、正文引用、不可用状态 | 截图结构与合同，尚未新增UI |
| 拟人打字 | 按文本长度计划、有界单流FIFO | 改规则重查、暂停保留、Code结果不能被社交取消 | `next/social-v1`纯逻辑与合成测试 |
| 禁用表达 | 表达样本审核＋最终消息检查 | 全局/会话/人设叠加；有限重写；最终版本重查；无regex执行 | 字面规则纯逻辑；语义风格/真实改写未实现 |
| 选择性复读（后续新增） | 同群多人相同纯文字形成参与候选 | 排除重复事件/自己/bot/跨群；可以不想参与；仍过表达与出站门禁 | 自行实现离线候选；未借上游未经核验的复读插件 |

“不感兴趣/不想聊/不满”可以成为普通社交选择，不应冒充故障，也不能阻止管理操作或已经运行的Code任务。真实主动联系目标、时段/额度、模型费用、日志保留与账号授权继续沿用[未决台账](OPEN-QUESTIONS.md)，不因本轮研究自动开放。

## 6. 验证边界

公开源码阅读不是运行验证，用户截图是需求证据而非juebot界面验收。上游测试、平台端到端、模型自然度、多人长期成长、资源消耗和安全性均未在本轮实测。juebot本地测试单独记在[本轮验证](VERIFICATION-SOCIAL.md)；真实Host、认证HTTP、界面视觉、平台业务必须分层报告。
