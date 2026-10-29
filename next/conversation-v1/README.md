# S1a：会话身份、事件账本与受控读取候选

原juebot项目内的独立下一阶段模块，设计v0.7.0。已经实现并在本机验证；未挂载真实Host，不是新的安装版本，也不是完整聊天管理界面。活`bundle`、0.2配置候选和旧数字QQ/schema1实现没有修改。

## 已实现

- `src/identity.ts`：bot/persona、通道、issuer/app、平台账号、群/私聊/线程、远端标识组成无损稳定会话键。个人QQ、官方OpenID、B站标识分域，不按昵称/数字合并；账号绑定修订独立记录。
- `src/contracts.ts`：有界严格输入、事件类型及原因码白名单、正文和元数据分离、权限快照与错误合同。非法Unicode在写入前拒绝，避免SQLite替换字符破坏重放比较。
- `src/ledger.ts`：显式空库初始化、schema/namespace拒错、绑定CAS、事务追加、来源ID去重和冲突拒绝、同会话因果引用、升序分页及正文按引用读取。
- `src/read-service.ts`：列表、事件元数据和正文分层读取；权限先于读取，返回前复核完整授权快照和绑定版本。撤权/旧游标/换绑定时不返回原页面或正文。
- `src/http.ts`：三个只读WHATWG处理器入口，严格query与错误响应。没有监听端口或注册Host路由。
- `lib/`：本次从源码发出的5个ESM与5个声明文件，仅位于本目录。编译产物独立SQLite/API烟测通过。

## 使用边界

账本构造器只接受调用方已经持有的SQLite窄接口，不接文件路径、不查profile、不导入node:sqlite、不创建目录。`initialize:true`只能初始化完全空库。独立应用标识为`0x4a554543`，当前账本结构版本1；不是旧MemoryStore的schema2，不打开或迁移原业务库。不同namespace、外来/未来/不完整结构拒绝，不重置、不容错跳过。

真实连接、文件安全、WAL/同步模式、备份、凭据保管及持久化所有者仍需S1b明确。测试只使用`:memory:`和新建的合成临时文件；本轮没有正式数据库路径。`close()`只关闭账本使用入口，不关闭注入的数据库连接。

`registerConversation`、`changeBinding`、`append`只供可信Host内部调用。调用方必须先验证账号绑定、入站授权、保存许可、事件来源和应脱敏的内容；本模块不是完整DLP或真实平台身份认证器。HTTP没有写入入口，模型不能自报owner或直接写账本。个人QQ的号码控制证明、OpenID应用归属、PersonLink仍未接线。

同会话/绑定/sourceEventId的完全相同输入重放返回同一事件，任一字段或正文改变则冲突。正文另存一次，投递状态事件通过`causedBy`指向同流同绑定的草稿等事件，不能将原文复制进每条状态日志。返回追加成功发生在COMMIT成功后；若底层提交后才报告错误，结果可能已提交，调用方须按同sourceEventId核对，不能据异常假定绝对未写入或换ID重投。已测的注入提交失败发生在提交前，不等于断电恢复证明。

绑定提升后旧事件保留但从新绑定读取面隐藏，旧授权也失效；没有删除、自动重新绑定或跨平台迁移。长期保留、撤销后的清理、导出和恢复仍未实现，正式运行前必须完成原台账要求。

## 读取与权限

Host为真实principal提供`AccessSnapshot{revision, grants}`。每条grant绑定会话键、当前bindingRevision，以及metadata/body两种权限；body许可必须包含metadata许可。权限快照每次读取前后各获取一次，修改权限应增加revision；同revision内容变化也会拒绝本次返回。

列表只向账本查询获准键，不提供全局数量或原文预览。事件页返回阶段/类型、原因枚举、关联ID、时间及bodyRef，不返回正文或隐藏推理。正文须另行授权读取，跨流引用不可见。名单最多128条、单页1–100项、正文最多16000 UTF-16单元，是可逆实现上限，不是生产容量承诺。扩大到更多会话需新的有界授权查询设计，不能直接改无限数组。

游标是版本化JSON位置，不是授权凭据；绑定会话、用途、权限版本及绑定修订，每次使用仍重新鉴权。事件按提交序号读取，不按可能乱序的源时间排序。列表和事件支持增量分页；本轮未提供实时订阅、跨分页冻结快照或历史快照查询。

## HTTP候选

| GET路径 | 参数 | 返回 |
| --- | --- | --- |
| `/juebot/conversations` | 可选limit、cursor | 获准会话列表 |
| `/juebot/conversation-events` | key；可选limit、cursor | 指定会话事件元数据 |
| `/juebot/conversation-body` | key、sequence | 获准正文 |

Host负责真实认证、Origin/owner绑定和生命周期注册。当前`resolvePrincipal`只是依赖接口，测试是明确的身份替身，不是登录验收。成功为`{ok:true,data}`，错误为`{ok:false,error:{code}}`；401未认证、403权限拒绝/变更、400参数/游标、409绑定冲突、404未找到、503受控不可用。错误不回传底层SQL、正文、路径或堆栈。取消请求不产生成功回执。

总query最多32KiB，cursor最多8KiB编码前UTF-8，key最多4096 UTF-16单元；总上限容纳合法长中文身份和游标的URL百分号编码。未知/重复参数、非规范数字和写请求拒绝。JSON响应禁缓存。将来原生页面按权限请求正文，不做全量正文预取或用前端隐藏充当授权。

## 本地复现

在原juebot目录用已存在的运行时，禁止旧默认build：

```powershell
& 'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' 'C:\Users\Administrator\AppData\Roaming\npm\node_modules\openclaw\node_modules\typescript\lib\_tsc.js' -p next/conversation-v1/tsconfig.json --noEmit --incremental false
& 'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' --test next/conversation-v1/test/*.test.ts next/social-v1/test/*.test.ts
& 'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' 'C:\Users\Administrator\AppData\Roaming\npm\node_modules\openclaw\node_modules\typescript\lib\_tsc.js' -p next/conversation-v1/tsconfig.build.json
& 'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' --test next/conversation-v1/test/compiled.test.mjs
```

发出目标固定为本目录`lib`，重新构建前确认该目录和父目录不是链接。`erasableSyntaxOnly`约束确保Node直接剥离TS类型即可执行测试，不依赖隐式转换参数属性。

## 接续顺序

S1a本地后端候选完成后，S1b接真实Host所有权/认证与安全生命周期，再做DSH原生会话列表、消息/轨迹页及浏览器验收；之后S2局部设置/记忆模式、S3意愿情绪、S4统一Outbox、S5获准平台试点。缺少正式DSH管理工具时不换软链接或手改profile部署。

本轮没有改动复读逻辑：复读依然零额外打字等待、绕过拟人队列；仍受表达、频率、权限及真实出站门禁约束。

实际结果与未测范围见[阶段验证](../../VERIFICATION-CONVERSATION.md)。
