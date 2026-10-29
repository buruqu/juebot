# juebot 0.3.0-dev.5 开发交付与验证

2026-10-29（北京时间），验证时点UTC 20261028T173704Z。继续原项目，候选未安装，未覆盖或停用maibot-bridge。

本轮完成异常Code任务/会话的人工弃用、新会话轮转、交互完整冷归档与Host维护入口。旧task/input/event/attempt不重放；恢复本身不启用Code、不调用SDK/模型、不发送，新明确消息才创建新session。归档保留完整原文、人工理由、哈希及去重/投递事实，unknown仍保持锁定。使用与限制见[维护合同](next/agent-v1/CODE-MAINTENANCE.md)。

修复独立审查发现的合法长身份键/授权revision0兼容、关闭后归档写入和同步回调修改维护入参的问题，补负例后纳入本轮全量。B站固定上游工具与副作用已核对，形成[下一步材料接点](next/agent-v1/RESEARCH-BILI-MATERIALS.md)；适配器本轮尚未实现，没有访问B站。

## 分层验证

| 范围 | 结果 |
| --- | --- |
| 本地测试 | **837通过，0失败、0取消、0跳过**；核心291、社交/会话86、agent460，比dev.4新增30；构建/类型/JS语法/包清单和归档核对通过。 |
| 真实Host | **未测**；实际SQLite和本机SDK离线fixture不等于正式Host。维护权限和session停止证明仍由合成回调提供。 |
| 认证HTTP | **未测正式认证HTTP**；旧合成owner/路由回归通过，本轮没有新增维护HTTP入口。 |
| 界面视觉 | **未测**；本轮后台库变化，无新增网页UI；VM注册及QQ文字合同不是浏览器验收。 |
| 平台业务 | **未测**；未登录/连接真实QQ或B站，未调用真实或付费模型，未上传/评论/发布。 |

实际组合覆盖失败任务→OFF预览→人工弃用→ON新QQ事件新SDKsession，旧event去重/输入不重放；维护权限、停止证明、旧CAS、grant/profile撤销、同步回调入参变动和真实SQLite query_only/trigger故障；session/task/audit同事务回滚；终结交互冷回读及关闭后零归档写入。外部SDK是合成服务，CodeTasks/Runtime/Dispatcher/StateStore/Outbox/broker/executor实际运行。

验证入口：`tools/verify_agent_candidate.py --baseline`，基线为本聊天work/agent-dev5-prechange/runtime-hashes.json，使用既有Node24.21.0、TypeScript6.0.3、Python及本机SDK离线fixture。源码、fixture与日志hash见evidence.json；未安装依赖或打包第三方SDK源码。打包后再次核对源码、日志、fixture、受保护文件与verify-only，交付manifest列出每个文件hash。

## 候选与运行边界

- 包：`dsh-juebot-0.3.0-dev.5.tgz`，84个载荷文件，169798字节。
- SHA-256：`0f6bf95759b1d9ee681760a808c7e42ac5e127c7ee4642fb99a8bd9a276db877`。
- 活bundle、0.2、dev.1/dev.2/dev.3/dev.4共**397文件保持不变**。
- 默认新Host disabled、enabled:false、initializeEmpty:false、dataRoot:null；不改profile/链接/HMR、正式库、账号、旧桥，不提交推送、不停启。
- 维护必须CodeOFF、桥已排空、无running任务/pending交互、原完整授权一致；Host同步明确维护权限与旧session已停止证明不可由body伪造。关Code本身仍只拒新/暂停queued，running继续。
- 冷归档在同一库保留完整私域原文，绝非独立备份/自动清理。热交互64、档索引4096、回应事件4096及7MiB约束仍在；Code任务64、入站2048和Outbox容量未做归档，长期保留/导出/备份仍待开发。

下一步：Bili显式BV读取→稳定材料快照→当前draft/publish授权投影；再补其它持久容量和管理操作体验。所有作品/评论仍最终人审。正式管理器缺失，按用户约定停部署前；本包不是完整juebot已完成或可直接无前置上线的声明。撤回本轮无需恢复运行文件：活目录从未修改，历史候选已完整保留。
