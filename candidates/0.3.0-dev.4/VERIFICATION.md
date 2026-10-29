# juebot 0.3.0-dev.4 开发交付与验证

2026-10-29（北京时间）；验证时点UTC 20261028T161817Z。继续原项目，独立候选未安装，未覆盖或停用maibot-bridge。

本轮完成 Code 人工提问和单次工具审批：通知经统一Outbox送往原管理员私聊，明确答复继续原DSH Agent与等待请求。批准绑定具体工具和完整参数，只允许本次；拒绝不能被外层中间件改为允许。答复旁路任务队列，OFF仍可回答当前任务；成功答复更新仅该任务的原始回复来源，不修改原task.input，不进入社交学习，不取消重跑。

已修复数据库故障导致等待不结束、关闭时丢失异步排空，以及中文/emoji通知超过实际字节上限的问题。详情见[人工交互说明](next/agent-v1/CODE-INTERACTIONS.md)和[接线合同](next/agent-v1/CODE-CHANNEL-INTEGRATION.md)。

## 分层验证

| 范围 | 结果 |
| --- | --- |
| 本地测试 | **807通过，0失败、0取消、0跳过**；核心291、社交/会话86、agent430；比dev.3新增49。类型检查、JS语法、构建、包清单/导入/归档核对通过。 |
| 真实Host | **未测**；SDK公开源码只读核对与真实Cordis/BlockAssembler离线运行不等于正式Host；未调用真实Agent或模型。 |
| 认证HTTP | **未测正式认证HTTP**；现有合成owner/Connection/API回归通过，不作为实际认证证明。 |
| 界面视觉 | **未测**；本轮无网页UI修改，QQ文本合同未在真实账号显示；VM注册不是浏览器验收。 |
| 平台业务 | **未测**；QQ/DSH服务均用合成替身，没有QQ/B站登录、真实模型、上传、评论或发布。 |

新增重点：broker14项真实SQLite测试（含query_only写失败、timeout/abort/close、实际与逻辑session分离、最坏答复空间预留、UTF8上限）；executor31项（同Agent续接、原工具输入、单次批准/拒绝、权限撤销/迟答/永久批准拒绝）；ingress45项（明确命令、版本/答案结构、原私聊来源）；组合16项（真实SQLite+Runtime+CodeTasks+Dispatcher+新executor，外部SDK是合成服务，含忙中答复、notice统一发送、原始时间及关闭后零晚读库）。上述数量为对应模块总量，已计入807，不能额外相加重复计数。

独立只读审查的2项P1及1项P2均已修复并有回归，最终未发现新增阻断。状态/工具请求不包含模型内部推理；私域题目、工具输入和答案未进入社交日志。

验证入口：tools/verify_agent_candidate.py --baseline（work/agent-dev4-prechange/runtime-hashes.json），使用现有Node24.21.0/TypeScript6.0.3/Python及本机SDK离线fixture。先独立构建，执行分层测试及verify-only。源文件、工具、fixture和日志hash见next/agent-v1/evidence.json；原始日志在next/agent-v1/evidence/20261028T161817Z/。没有安装依赖或打包第三方SDK源码。

## 候选载荷和运行边界

- dsh-juebot-0.3.0-dev.4.tgz：84个载荷文件，164991字节。
- SHA-256：`c74a75b3f8ad04963512f2eab4da96e1f6ff6141fcfa0c3d3680428175d68480`。
- 活bundle、0.2、dev.1、dev.2、dev.3共**308文件保持不变**；无生产库迁移、profile/软链接/HMR修改、停启、提交或推送。
- Host仍默认disabled、enabled:false、initializeEmpty:false、dataRoot:null；组合库不自动登录/订阅。QQ管理员只能来自外部真实证明，登记仍pending-proof。

默认总执行5分钟包含人工等待；QQ被动窗口仍按原平台事件5分钟。请求payload最多12000字符，完整notice最多16000 UTF8字节；超限拒绝而不截断参数。64条交互记录为累计上限；2048入站和既有Outbox容量也没有正式归档入口。unknown不自动重投，真实费用/工作区/OS限制仍需Host验收。

重启没有原SDK等待，保留needs-review；异常会话人工恢复、长期保留/归档、QQ表单按钮、命令确认与文件回传仍未实现。下一步推进这些恢复与维护能力，并继续Bili Whale读取/创作材料工具复用；所有评论和作品仍最终人审。

缺正式DSH管理器，按用户要求停在部署前，不能绕过profile/链接/HMR。交付可审阅候选和实际接线合同，未宣称完整juebot已完成或可以无前置直接上线。撤回本轮不需恢复运行文件：活目录从未改变，历史候选完整保留。
