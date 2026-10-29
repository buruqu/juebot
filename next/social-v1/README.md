# 下一阶段离线社交逻辑

这是既有juebot项目内的纯逻辑开发目录，不是新项目或安装包。未导出到活`bundle`或`candidates/0.2.0-dev.1`，未接Host、HTTP、Tool、数据库、模型、定时器或平台发送。

## 已实现

- `src/typing.ts`：字素计数、有限等待计划、单会话FIFO、跨会话独立、容量拒绝、取消/领取/完成。等待中的社交草稿可取消；Code结果及管理确认不能通过社交取消接口删除。平台出站暂停保留队列。
- `src/expression-policy.ts`：全局/会话/人设词句规则叠加，精确或包含匹配、NFKC/大小写折叠及指定零宽符清理，blocked优先，有限重写预算判定。输入是字面规则，不能执行任意正则。默认规则为空，不替用户决定黑名单。
- `src/repetition.ts`：同群多人连续/间隔重复的纯文字候选；独立的参与意愿、许可及冷却检查；不强制复读，排除自身、bot、重复事件及跨流混入。只返回候选，不会调用QQ的+1或发送接口。复读按复制粘贴，零额外打字等待。
- `test/`：使用合成文字、时钟及规则，验证上述行为和两模块组合负例。

## 接线合同

这些API只供可信Host使用，不可直接暴露为模型或普通用户可写工具。`kind`、完整带命名空间的会话键、版本、权限和改写次数须由Host生成；把任意聊天标为`code-result`会绕过社交文风检查，不能由外来输入决定。

1. 在完整逻辑回复上做表达检查，再分段；只查各段不能阻止拆词。风格合同和反例当前仅是数据结构，字面`allow`不等于语义风格复核通过。
2. 经检查的社交文本按当前策略版本入队。到期不等于发送许可；`claim`核对Host传入的最新绑定、策略及总出站状态。
3. 社交策略版本变更返回`recheck`并保留原稿。Host重新取最新规则、授权和来源，对完整原文检查；通过后才调用`revalidateSocial`。该方法校验版本/原文一致，本身不执行表达检测，也不授权外发。更晚版本出现时，旧复核不能放行。
4. 需要改写时由有预算的生成器完成，再独立复检；纯逻辑不会调用模型。取消旧社交项并消费其cancelled结果后，合规替稿作为新项入队，排在已有项之后，不承诺保留旧项顺序位置。禁止无限改写或未复检直接发出。
5. 绑定变化可移除失效社交项。Code结果的绑定/策略变化返回blocked并保留，由后续管理流程处理，不改投他处。Code OFF不阻断已有合法结果。
6. `claimed`只是本地一次领取。Host仍须在真实出站时原子校验Outbox和最新授权；unknown应保存核对记录，不自动重试。`complete`只在消费方处理完交付结果后释放本地队头，不能用它冒充平台已确认。

复读例外：Host将获准原文标为`repetition`，表达检查仍按社交文本执行；`planTyping`对此类消息返回零延迟，`TypingQueue.enqueue`从类型及运行时拒绝此类输入。复读直接走统一Outbox/发前门禁，不在拟人打字队列后等待；实际平台限速和在途发送仍有效。若决定另行生成改写回复，该回复属于普通social，不能以复读标签免除正常打字节奏。

会话键里的namespace须由后续身份层覆盖connectorKind、issuer/appId、persona和群/私聊类型等完整身份；目前只是有界不透明字符串，没有实现官方QQ或B站身份注册。领取旧绑定的积压项需要保存原队列键，不能仅按新绑定键枚举。UI控制确认应走独立原生通道及时反馈，放进社交FIFO仍会等队头。

默认12字素/秒、150–6000毫秒、±10%是可调整的离线默认；默认随机样本0.5保证纯函数确定性，真实接线要显式注入采样函数。按字符长度加等待，未扣除模型生成耗时。上限按单条计算，排队可能更久。

表达输入最多32000 UTF-16单元；打字计划最多64000单元及8000字素。组合入口应用两者更严格限制。规则库含私人例句时仍需来源/读取/模型使用权限；判定只返回action及ruleId，不输出原文片段。

复读候选依赖Host认证的会话/账号/绑定键、发送者类型与参与意愿；这些不是聊天正文可填写的自我声明。检测默认窗口20条/120秒、3次相同文字及2名人类参与者、60秒冷却；Host必须持久记录每次已处理机会，不能每次传空lastAttemptAt绕过冷却。候选依然通过完整表达、来源、频率及Outbox流程，不能直接转交发送器。多人粘贴不是多份独立事实证据，不能重复学习加权。

## 本地验证

在juebot目录，使用已有Node与TypeScript，不安装依赖、不发出构建产物：

```powershell
& 'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' --test next/social-v1/test/*.test.ts
& 'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' 'C:\Users\Administrator\AppData\Roaming\npm\node_modules\openclaw\node_modules\typescript\lib\_tsc.js' -p next/social-v1/tsconfig.json --noEmit --incremental false
```

当前结果见[本轮验证](../../VERIFICATION-SOCIAL.md)。单测不是实际发送、断电持久性或UI效果证明。下一步身份/账本/原生会话页、记忆模式、自主状态与真实出站仍按[主设计](../../SOCIAL-BEHAVIOR-PLAN.md)分阶段实现。
