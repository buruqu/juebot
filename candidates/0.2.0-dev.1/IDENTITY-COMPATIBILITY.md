# 0.2 配置候选与 v0.6 身份规划兼容评估

2026-10-28。本轮只评估并限定现有字段语义；没有实现跨平台身份、平台绑定或数据库迁移。

## 当前合同

| 位置 | 当前含义 | 兼容缺口 |
| --- | --- | --- |
| `src/control.ts` 的 `admin.qq` | 个人QQ数字字符串预登记；最多20位，始终pending-proof | 不含connector、issuer/appId、远端主体命名空间；不能用于官方OpenID或B站UID认证 |
| `src/contracts.ts` 的botId/senderId/Conversation | 旧个人QQ数字合同 | 同数字在QQ/B站可能是不同主体；不同官方应用中的相同OpenID也不是同一主体 |
| `src/memory.ts` 的私域、管理员及共享门禁 | 个人QQ会话与来源范围 | receive/send前置不能替代read/learn/draft/publish用途授权 |
| `src/storage.ts` 的schema 1 | 旧QQ身份键、共享授权、来源修订与索引 | 没有跨平台命名空间或PersonLink；数据库schema与控制配置schema均为1，但属于不同域 |

本轮不改存储shape、不放宽数字正则、不自动分配新平台。界面中英文明确“个人QQ预登记、官方OpenID不支持”；登记不产生绑定证明、Code资格或外发权限。即使输入恰好等于某B站UID的数字，也只是一条未证明的个人QQ预登记，不能据此推导任何跨平台身份。

## 后续合同边界（设计，尚未实现）

- 内部botId/personaId、平台账号AccountBinding、外部Actor、PersonLink分别建模。平台键至少明确connectorKind、issuer/appId、remoteAccountId、remoteActorId；会话及目标键继承这些命名空间。
- 新增官方QQ绑定入口必须携带可信平台事件与应用上下文，独立证明管理员关系；不从QQ号、昵称或头像推算OpenID。B站身份关联不授予Code权限。
- 如需替换控制配置shape，使用显式版本升级；旧admin.qq保持个人QQ、pending-proof，不转换为“已证明”。未知旧记录隔离待确认，不默认归属新账号。
- 业务库下一版schema编号/迁移先设计，再用合成库或明确授权副本验证碰撞、回滚、索引重建及私域不扩权。不得在正式库上试迁移。
- PersonLink/账号绑定/来源共享的revision与撤销必须使派生内容、评测材料和待发审批失效；用途、披露与平台出站许可分别检查。
- D008保留：Code OFF仅拒新开发输入，已运行任务继续；D009保留：私聊事实默认私有。双平台愿景不追加公开许可。

## 仍待决定与验证

沿用主台账JUEBOT-XP-Q001/Q004/Q005：实际QQ通道和账号、官方绑定证明、人物关联许可、迁移/保留/删除方案。既有schema1与本候选都不得标为跨平台支持。无需为本轮离线配置收口提前决定这些平台启用事项。
