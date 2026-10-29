# juebot 0.3.0-dev.2 开发交付与验证

2026-10-28。继续原 juebot，设计仍为 v0.7.0，D001–D023不变。本轮完成下列候选接线、恢复能力和整合修复；完整QQ/B站运营产品尚未完成，未部署、未调用真实或付费模型。

## 本轮完成

- **DSH 原生模型入口**：使用本机 rc.3 的 prepareCall 和 BlockAssembler，显式模型/预算配置，检查完整结束、格式、工具与响应限额，丢弃推理块。Cordis 子作用域在模型服务出现、替换、移除时正确重建/清理；默认禁用不触碰数据路径或SDK。
- **持久模型预算与本地会话**：UTC日账本、原子预留、幂等结算、未知保留、实际usage超额记账；换模型/人格及重开不清零。显式本地所有者会话只授权当前local-test身份，不冒充QQ管理员，Code仍未授权。修复身份切换已写入却被旧readKeys误报拒绝的问题。
- **创作中断恢复**：管理面板及API支持填写理由后人工恢复/放弃；恢复同一作品但重新准备材料/规划/制作，过期意愿与变化来源/身份不允许恢复。完成后仍须审核最终作品，放弃保留审计且不能再次恢复。
- **发送结果核对**：unknown仅由可信只读证据provider核对，绑定账号、目标、正文/payload指纹及原投递ID；UI不能填写成功或重发。队列、预算和作品/Code结果同一SQLite事务提交，投影失败整体回滚。Code重启held或撤权后可记录已发送事实，但不授权新任务/发送。未知与确认事件分别记入会话日志。
- **QQ官方被动文本协议**：群/单聊官方请求字段、应用命名空间、原始事件期限、msg_seq、持久去重及不明结果保留。修复token等待期间撤权仍可能发送的竞态：取token后重新核对完整授权证明，再同步检查期限。协议模块不含入站认证或账号连接。
- **独立打包**：保留完整0.2设置载荷和单原生loader双面板；新增模型peer和默认关闭项，构建只写独立dev.2候选。活bundle、封存0.2和前次0.3.0-dev.1全部保留。

具体配置/权限/生命周期见 [NATIVE-INTEGRATION.md](next/agent-v1/NATIVE-INTEGRATION.md)。预算单位采用请求UTF-8字节数加输出上限预留，不是精确token或货币费用保证。原生模型要求prepared路由normal/0重试，不改profile，也不承诺约束任意第三方middleware行为。

QQ协议依据腾讯[接口鉴权](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/api-use.html)、[群消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)和[单聊消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)。单聊文档存在60分钟/5分钟冲突，实现保守采用5分钟、每原消息4次；群5分钟、5次。详见 [研究记录](RESEARCH-QQ-TRANSPORT.md)，未通过真实账号验证这些限额。

## 最新完整验证

证据时间 `20261028T141759Z`。**695通过，0失败，0取消，0跳过**；核心严格类型检查、新候选编译、全部载荷JS语法、清单/版本/peers/导入/归档逐字节校验通过。

| 测试组 | 通过 | 原始证据 |
| --- | ---: | --- |
| 旧核心、配置、HTTP、Tool、路径和持久化回归 | 291 | `next/agent-v1/evidence/20261028T141759Z/legacy.tap` |
| 打字、表达、复读、会话身份与账本 | 86 | 同目录 `social-conversation.tap` |
| 策略/成长/运行链、原生模型/预算、恢复/核对、QQ协议、API/组件VM、Code/视频和打包 | 318 | 同目录 `agent.tap` |

使用真实隔离SQLite、磁盘重开、两个独立连接争用日预算、事务内实际写后故障回滚，以及实际本地ffmpeg。原生SDK流使用合成provider和本机实际BlockAssembler，Cordis生命周期使用实际4.0.5 Context加合成connection；没有连接运行中的DSH或实际模型。

关键增量测试包括：QQ协议39项；创作/Code核对15项及social审计；原生入口依赖生命周期4项；持久预算5项。最新完整回归包含这些测试，不把子集数字重复相加。独立审查发现的LLM注入缺失、QQ取token期间撤权、Outbox/业务投影分裂三项均已修复并覆盖回归；另修复本地会话/身份更新导致的权限快照误报。

SDK离线来源指纹（仅work临时副本，不分发SDK源码）：

- rc.3 assembler SHA256：`35a4754ab854055942b9142934c595c3e6358a717947daa2d8d89847aef988f7`
- Cordis4.0.5入口 SHA256：`6a9394c0877ff45218818c6e815edd038f8057e1a1deb390a8d43ec81c57691e`

重验入口：从项目根调用既有Python执行 `tools/verify_agent_candidate.py --baseline <开工前runtime-hashes.json>`；设置 `JUEBOT_DSH_ASSEMBLER_SOURCE` 和 `JUEBOT_DSH_CORDIS_MODULE` 为已核实的本机SDK离线副本。缺少必要SDK测试环境导致跳过时，全量验证不会报告通过。它不安装或修改DSH。

## 分层状态

| 层次 | 已测 | 未测／未完成 |
| --- | --- | --- |
| 本地测试 | 695项、严格编译、真实隔离SQLite/视频、协议合成IO、包校验 | 长期人格/自主体验、真实语义质量、生产规模/断电备份恢复 |
| 真实Host | 本机SDK合同只读核实；实际Cordis离线依赖测试 | 正式DSH安装、真实Host初始化/卸载/恢复；当前无管理/Inspect工具 |
| 认证HTTP | 本地WHATWG处理器、注入可信principal、权限/CAS/撤权负例 | 运行中Host的真实owner会话与未认证请求验收 |
| 界面视觉 | 原生组件VM状态/按钮/API/媒体合同 | 真实浏览器交互、布局、控制台、媒体播放与截图；未启动替代GUI |
| 平台业务 | QQ官方协议合成fetch、原始事件证明约束、统一Outbox与人审链 | QQ真实入站/账号/收发、个人QQ、B站浏览评论上传、真实模型与费用；没有登录或发布 |

## 交付包与保护

- 候选：`candidates/0.3.0-dev.2/artifacts/dsh-juebot-0.3.0-dev.2.tgz`
- 79个发行文件，归档145336字节。
- SHA256：`b8b4dc9f89e7e9b77fd2297623187dd97f775685921bc18b7acbc6cb94160277`
- 开工前136个受保护文件全部未变；构建器另比较整个活bundle、整个0.2和整个0.3.0-dev.1目录。前次599项证据与dev.1包继续保留。
- `build-receipt.json`给出精确输入及逐文件哈希；`next/agent-v1/evidence.json`给出最新源码、命令、日志、SDK来源哈希。交付目录另附清单和方案/日志ZIP。

没有依赖安装、生产库迁移、profile/软链接/HMR变更、现有服务停启、maibot-bridge修改、Git提交或推送。新旧业务Host默认禁用，native localChat和dshModel也默认关闭；包不包含账号、密钥、聊天库或SDK临时提取文件。

## 剩余开发与正式升级前置

1. 实际可信入站connector、QQ官方/个人路线选择、管理员证明与逐用途授权；B站实际浏览/评论/上传适配，以及同账号唯一回复owner仍未完成。当前QQ sender不等于完整QQ连接器。
2. 正式Code工作区与操作系统沙盒executor、真实会话模型/预算配置仍未完成或确认；full-access与工具mask不冒充OS沙盒。管理员登记继续pending-proof。
3. 正式数据保留/删除/导出/备份、生产恢复，真实记忆/表达/成长质量及长期体验仍需开发和获准样本验收；撤源拒绝使用不等于物理擦除所有副本。
4. 视频仍为本地文字卡静音成片；更完整的素材/TTS/音乐/剪辑及平台格式待完成。QQ空间和所有B站公开创作仍逐件审核最终内容与目标，修改后重审。

安装载荷已备齐，但**尚未达到可直接正式更新**：当前没有DSH管理/Inspect工具，无法核实当前安装owner、停启及恢复入口和正式验收地址。本次按用户明确约束停在部署前。后续正式升级会改变原生面板及添加默认禁用Host项，是否重载/重启和中断时长由真实管理器核验，不猜测或手写替代控制器；恢复须由同一正式管理器恢复已有包及原激活状态，不能整库回滚或清空数据。本轮未安装也未执行恢复。
