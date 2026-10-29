# juebot 0.3.0-dev.3 开发交付与验证

2026-10-28。在原项目next/agent-v1继续开发，独立候选未安装；没有覆盖或停用maibot-bridge。最新验证时点UTC：20261028T153054Z。

## 本轮结果

复用官方QQ SDK已认证事件和DSH Agent，完成可信私聊入站、去重、专用会话映射、串行任务、最终公开回答与原私聊Outbox链。精确/开启code、/关闭code优先于模型队列，重复幂等；OFF当前任务继续。审批/问题不自动许可，不把idle/部分文本当完成；失败步骤不自动重放。修复关闭通道后迟到授权/事件可能读库或获准发送的竞态。

代码继续私有，不进入社交学习；官方OpenID不冒充数字QQ。既有模型、人格成长、记忆、创作最终人审规则保留。详细实际接线和限制见[CODE-CHANNEL-INTEGRATION.md](next/agent-v1/CODE-CHANNEL-INTEGRATION.md)。

## 最新验证

| 层次 | 本轮状态与证据 |
| --- | --- |
| 本地测试 | **758通过，0失败、0取消、0跳过**：旧核心291，社交/会话86，agent381（含新增63）；类型检查、构建、JS语法、完整载荷与归档核对通过。 |
| 真实Host | **未测**。本机SDK源码只读核对，真实Cordis/BlockAssembler离线验证不等于正式Host；缺DSH管理工具，未安装或重启。 |
| 认证HTTP | **未测正式认证HTTP**。本地合成Connection/owner/API反例随回归通过，不冒充真实认证。 |
| 界面视觉 | **未测**。本轮无新增UI，既有VM注册测试不等于真实浏览器交互或视觉验收。 |
| 平台业务 | **未测**。QQ/DSH外部服务是合成测试替身；没有真实QQ/B站、真实或付费模型、浏览/评论/上传/发布。 |

新验证覆盖：真实SQLite与CodeTasks/Runtime/Dispatcher组合；QQ原文、来源/账号/目标/TTL、持久去重、群/非管理员/引用拒绝；原私聊结果队列；忙中开关与重复幂等；问题/审批不当成功；专用DSH会话防重/并发/结果判定；工具/模型/路径策略复核；模型失败重试阻断；认证、执行、发送证明与卸载的迟到回调。独立只读审查无新增阻断，发现的卸载窗口及D007命令遗漏已修复。

命令：项目根运行tools/verify_agent_candidate.py --baseline（本轮work/agent-dev3-prechange/runtime-hashes.json），使用现有Node24.21.0、TypeScript6.0.3、Python；设置JUEBOT_DSH_ASSEMBLER_SOURCE与JUEBOT_DSH_CORDIS_MODULE到本机只读提取的SDK离线fixture。脚本先重建候选，再运行分层测试与verify-only。完整命令路径、源hash、日志hash见next/agent-v1/evidence.json；日志位于next/agent-v1/evidence/20261028T153054Z/。未安装依赖或捆绑第三方SDK源码。

## 载荷与保护

- 包：candidates/0.3.0-dev.3/artifacts/dsh-juebot-0.3.0-dev.3.tgz；83个载荷文件，157054字节。
- SHA-256：`9fd804e6ba17f76df7c52901372682634b160ba9fdcb764a547eca402231268e`。
- 活bundle、封存0.2、dev.1、dev.2共**220文件哈希未变**；没有修改profile、软链接、HMR或生产库；没有提交推送。
- 版本/peers/files/exports与完整归档匹配；新增组合库子入口不会自动加载、订阅或登录。原生agent Host继续disabled、initializeEmpty:false、dataRoot:null。

## 尚未完成与下一步

QQ提问/审批答复续跑、异常会话人工恢复、命令确认消息和长任务结果过期后的人工回传尚未实现。官方被动回复保守5分钟，过期保留结果不主动兜底；每账号2048事件满拒新，无自动清除去重证据。不得把本候选称为可长期运行的正式QQ服务或完整juebot。

先补Code人工交互与正式受管理Host接线，核实实际账号/管理员、工作区策略和预算；随后复用Bili Whale读取/创作材料工具，隔离其独立人格与自动调度，所有评论和作品最终人审。SnowLuma个人QQ路线仍保留，未选择正式运行路线。

本轮无部署、重启、账号登录、自动发送/发布许可。缺DSH管理器时按用户要求停在部署前，不能直接改profile/链接/HMR。当前仅交付可审阅候选载荷与接线合同，不宣称一条命令即可完成正式升级。撤回本轮开发不涉及运行恢复：活目录未变；先前独立候选均完整保留。
