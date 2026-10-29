# juebot agent-v1：撅撅的本地行为链候选

**0.3.0-dev.7 接续（2026-10-29，候选未安装）**：dev.6 已安装并在真实 Desktop Host 完成装载、独立测试库初始化与重开验证；同一页面 setup 正常，但 agent 全部数据请求失败，页面刷新及整 Host 重启均不能恢复。现场依据为[最新验收 §11.6–11.7](../../VERIFICATION-LOCAL-ACCEPTANCE-DEV6.md)和[故障交接](../../DSH-AGENT-HTTP-HANDOFF.md)。旧文档的“dev.6 未安装/未挂载”已被这些证据覆盖。

dev.7 将纯 GET 路由改为 buffered，含 POST 路由保持 streaming，新增 owner 门禁后的静态 health 探针和客户端 HTTP/code 错误提示。真实 TCP 测试已复现：rc.3 连接桥给 streaming GET 附 body，在进入 agent handler 前即失败；**仅装 dev.7 仍不能修复混合 GET/POST 路由**。另有经用户授权准备的连接依赖源码补丁候选，须走 DSH 正式运行时发布渠道，不捆绑/覆写依赖或放宽版本检查。具体证据、包哈希、部署条件见[dev.7 验证](../../VERIFICATION-AGENT-DEV7.md)。真实 Desktop 装后验收留给 DSH 会话；QQ/B站、模型、Code 和生产库本轮不接入。产品主方案仍 v0.7.0。

dev.6 的937项通过属于历史本地证据，其功能范围见[本地范围](LOCAL-COMPLETION-DEV6.md)。下文旧轮次状态与计数保留历史，不作为当前安装/验收结论。

本轮接线合同见[APP-INTEGRATION.md](APP-INTEGRATION.md)。默认构建目标已更新到 dev.7，保护 bundle、0.2 配置候选以及 dev.1–dev.6 全部封存文件。

2026-10-29。源码位于独立 `next/agent-v1`，打包目标为 `candidates/0.3.0-dev.5`；产品设计仍为 v0.7.0。历史 0.1.0-dev.2 安装记录和 0.2.0-dev.1 配置候选均保留。本候选未安装，不替换活 bundle、封存 0.2 或前次 0.3.0-dev.1、dev.2、dev.3 与 dev.4。

核心是培养持续维护自身身份、记忆、兴趣、关系与经历的“撅撅”，逐步形成自然交流、主动选择和成长，再在明确授权后经营自身 QQ/B站身份。人格模式保持角色核心与有限适应层分离。状态、候选与模型自述不能证明主观意识，合成链路也不代表培养目标已经达成。产品合同见 [PRODUCT-CORE](../../PRODUCT-CORE.md)、[社交方案](../../SOCIAL-BEHAVIOR-PLAN.md)和[创作运营方案](../../CREATION-OPERATIONS-PLAN.md)。

## 当前实现层次

| 范围 | 当前本地候选能力 | 实际接入边界 |
| --- | --- | --- |
| 会话与经历 | 复用 conversation-v1 的命名空间身份、bindingRevision、独立 SQLite 事件账本及有界只读服务；管理 API 与原生面板候选展示会话、事件/正文和局部状态 | 真实 Host、认证 HTTP、浏览器和真实会话发现尚未验收；合成 principal 不构成正式认证 |
| S2 策略与记忆 | SQLite StateStore、revision/CAS；全局隔离/共享、每流继承或进一步隔离；receive/save/learn/reply/proactive 硬拒绝；局部 prompt/打字/表达/参与设置；带来源、用途、目标、期限和版本的记忆卡、派生撤销和上下文票据 | 只接可信 Host 数据；按有界关键词相关性和字符预算选上下文，无真实 embedding 或召回/语义效果承诺 |
| S3 自我与成长 | 持久自我状态、兴趣/关系/情绪与衰减、参与/沉默等选择、主动候选与时段/名单/额度；有来源的成长候选、冻结评测合同、审阅、激活及恢复 | 是可观察的有限状态与规则；评测接口和合成结果不能证明长期效果或自主意识，不自授权限 |
| S4 社交接线 | 可信入站→事件/来源→状态及记忆→可选模型→表达检查/有限重写→持久 Outbox→发前复核→统一 dispatcher；租约、暂停、幂等、预算与 unknown 保留 | 只在本地注入端口/合成 transport 下贯通；新增QQ官方被动文本协议模块并离线验证；新增官方SDK可信入站薄桥，但未接真实账号，B站与个人QQ实际协议仍未完成 |
| 创作运营 | CreativeWorkflow 把获准意愿/材料接版本化作品；最终资产快照、人工批准/拒绝/改稿、一次提交意图及统一 Outbox；原生审核面板候选 | QQ空间、B站评论/回复/动态/视频投稿均须逐件审核最终成品及目标，不能只审脚本；真实上传及回执未接入 |
| 本地视频 | 显式 planProvider 提供有限分镜后，既有 ffmpeg 可生成文字卡静音 MP4、封面和 VTT；受控资产注册、hash、opaque previewRef 与逐次读取校验 | 这是实际本地合成成片，尚无 TTS、音乐、复杂剪辑或画面生成；计划源未配置时报缺失，不能声称已 AI 自主制作 |
| Code | 独立持久任务、可信管理员私聊、DSH Agent会话桥、优先Code指令、工具gate、结果入统一Outbox；OFF 拒绝新任务但 running 继续 | UI 管理员登记仍 pending-proof；DSH Agent桥已离线实现，尚无实际账号证明及工作区/权限验收。queued 保守 held、重启 running 转 needs-review，恢复须显式策略，不替用户决定 Q006/Q007 |
| Host 与调度桥 | 应用工厂、owner 路由适配、显式启停的单实例 runner、迟到订阅清理和等待已接纳工作结束；一个原生 ModuleLoader 同时注册 agent `juebot` 与旧设置 `juebot-setup` | 默认不启动；可信 decoder/权限/账号/预算/发送端口需真实 Host 提供，既不是新增平台协议，也不是正式挂载已验收 |
| 可选模型端口 | 显式 JSON 端口及 DSH rc.3 原生流桥；持久 UTC 日预算、预留/结算、有界响应、超时/取消；只用最终文本，丢弃推理块 | 没有默认模型、真实凭据或真实调用；失败/不确定不自动重试或换模型，选型和费用仍 Open |

本轮最终证据入口是 [VERIFICATION-AGENT-DEV5.md](../../VERIFICATION-AGENT-DEV5.md)，测试、构建与哈希已经主代理复核。后续源码变化时，旧收据会被构建脚本判为过期，不能沿用当前通过结果。

## 本次接续

官方QQ→DSH Code组合、SDK接口依据与可信Host要求见[Code接线](CODE-CHANNEL-INTEGRATION.md)。本轮837项通过，30项新增；外部服务使用合成替身。dev.4人工问题/审批继续原请求，dev.5新增[异常弃用与冷归档](CODE-MAINTENANCE.md)，不重放旧任务。B站下一步见[材料接点](RESEARCH-BILI-MATERIALS.md)。

原生入口只在显式启用模型时通过真实 Cordis 子作用域取得 llm；本地所有者会话默认关闭，不授予 QQ 管理员或 Code 权限。新增的持久日预算不是货币费用上限，实际模型、预算与运行许可仍待确认。人工创作恢复会重做本地准备并重新人审；发送结果核对只接受可信 provider 绑定原出站内容的证据，无客户端填写成功或重发按钮。完整配置/生命周期合同及未接线项见 [NATIVE-INTEGRATION.md](NATIVE-INTEGRATION.md)，QQ协议和文档冲突见 [研究记录](../../RESEARCH-QQ-TRANSPORT.md)。

## 不变的产品与隐私规则

- QQ 官方机器人与个人 QQ 两条路线预留，验证后选择；不默认双连接、双回复或停用旧桥。账号键包含 connector/issuer/account，不能用裸号码、昵称或头像代替命名空间。
- QQ/B站可以共同支持同一主体成长，但仅经批准的通用知识、表达和获准偏好可跨流检索；具体私聊事实、群内隐私须明确目标/用途授权。关闭隔离不合并原始聊天，Code 材料和结果不进入社交记忆/学习。
- 复读先判断同群多人有效重复，再由状态/兴趣选择；**零额外打字等待，绕过拟人打字队列**。仍执行表达、权限、频率、发前检查和统一 Outbox；不保证绕过真实平台限速或在途发送。
- 日常普通聊天沿用回复/主动规则；QQ空间及 B站公开创作作品逐件人工审核最终内容、附件、目标、账号与有效来源。改稿、换资产/目标/权限使旧批准失效，unknown 不盲重投。
- Code OFF 与显式 stop、授权撤销和总出站暂停不同。OFF 不取消 running；撤权阻断旧工具和结果自动外发但保留记录，恢复不自动猜测未决策略。

## 完整待验清单

1. dev.6 已正式安装且 Host 生命周期通过，真实界面已观察到 agent 数据面故障。dev.7 与连接补丁的隔离真实 TCP 测试不代替 Desktop 装后认证 HTTP、视觉和卸载恢复验收；后者由 DSH 会话按新报告接续。
2. 可信 Host ports 尚需实际 connector、入站证明、权限/管理员账号证明、canonical account 映射与发送回执；未连接 QQ 或 B站，也未执行浏览、发布、上传、扫码或 Cookie 操作。
3. Code桥复用DSH Agent与实际策略接口；实际工作区、会话、费用和受限工具未正式验收。活跃提问/审批续接已本地实现，重启恢复仍缺；不会另建OS沙箱或把策略名当隔离证明。
4. 聊天、风格复核、成长评测和视频计划的实际模型/端点、费用与持续预算未确认，未请求真实或付费服务。上下文字数预算不冒充精确 token 估算。
5. 记忆相关性、隐私撤销、语义风格和长期人格成长需真实获准样本及独立评测；有界关键词检索没有效果承诺。
6. 视频仅为本地字幕文字卡/静音合成；TTS、音乐、复杂素材剪辑、版权、真实投稿格式及平台发布能力仍待确认和验收。
7. 正式数据路径、保留/删除/导出/备份、生产规模与异常恢复需单独配置和验收。合成临时 SQLite、正常重开不等于正式数据库迁移、断电恢复或备份擦除。
8. 主体体验仍需完整长期场景验收：持续记忆、主动选择、拒谈/恢复、两端隐私、来源纠错、成长版本和最终作品审核；不能把本地一轮贯通写成全部 juebot 已完成。

## 构建与保护边界

仅使用现有 Node/TypeScript/Python 和可选既有 ffmpeg，无 npm install、第三方脚本或旧默认 build/pack。显式编译输出 `next/agent-v1/lib`；完整保留 0.2 配置载荷并追加 `agent/host`、`agent/lib` 到独立 0.3 候选，Host 的 `../lib` 导入关系不变。新 agent Host 默认 `disabled:true`、`enabled:false`、`initializeEmpty:false`、`dataRoot:null`，旧 storage Host 继续禁用。

```powershell
$python = 'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'
$node = 'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $python -I -B tools/build_agent_candidate.py
& $python -I -B tools/build_agent_candidate.py --verify-only
& $node --test next/agent-v1/test/package.test.mjs
```

命令从项目根执行。脚本校验受保护 bundle/封存 0.2/dev.1–dev.6 前后哈希、路径/link/reparse/hardlink、严格有限 Client 转换、单 loader 双 panel VM、manifest/version/peers/files/imports、逐文件 hash 和归档逐字节一致；输入变化即拒绝旧收据。产物位于 `candidates/0.3.0-dev.7/artifacts`，仅是候选打包，不执行安装、profile 修改、数据库迁移或服务停启。
