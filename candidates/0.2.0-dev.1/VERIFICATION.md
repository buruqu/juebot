# juebot 0.2.0-dev.1 候选交付记录

日期：2026-10-28（Asia/Shanghai）。状态：候选本地收口完成，未部署。

## 已装／候选／规划

- 已装文件：desktop依赖及软链接仍指向原项目的`bundle`；该包为0.1.0-dev.2。活目录23个文件与接手前SHA-256完全一致。没有重新确认运行中的Host激活状态。
- 候选：`candidates/0.2.0-dev.1/bundle`，包名仍为`@local/dsh-juebot`。身份配置、个人QQ待证明登记、仅元数据路径确认及profile控制配置持久化；正式业务后台保持disabled、storagePath:null。
- 主方案仍为v0.6.0。官方/个人QQ双通道、B站逐条审批及共同成长均为规划；本轮没有新增跨平台实现。

## 本轮修复与保护

1. 统一候选package、诊断、Client、NOTICE版本和中英文元数据，加入4个settings文件与精确peers：storage-domain 0.2.1-rc.3、Zod 4.4.3。没有安装依赖。
2. 刷新候选JS/声明，使既有保存队列内5分钟期限复核进入发行产物。HTTP使用同一compiled CoreError，真adapter竞争测试确认409，不覆盖另一写入。
3. Client解析严格错误envelope后区分版本冲突与两类路径重校验；清token/确认勾选，保留草稿；非JSON、坏JSON、未知错误码安全回退。
4. Host首次await前登记卸载哨兵，覆盖probe/open期间卸载、迟到domain恰一次关闭、部分注册失败回收；不在失活ctx追加effect。
5. 路径预检新增拒绝目录软链/junction祖先，验证叶子软链、硬链、包/profile禁区、文件变化、取消及确认到期。所有路径操作仅元数据，不创建/打开/迁移业务数据库。
6. 新增HTTP/Tool/真实adapter及合成磁盘整合负例：64KiB、超时、取消、坏UTF-8、Content-Type/query、未知字段、私有错误脱敏、伪造权限、排队撤权、重开/损坏/IO失败/profile隔离。
7. 新建显式候选构建/打包入口；旧默认build/pack改为拒绝执行。发射参数、链接/硬链接、源码与产物收据、完整清单、静态/动态导入和归档字节均验证。故障注入只在隔离副本，错误时保留既有归档。
8. 原QQ数字校验、业务schema1、Code关闭继续旧任务、私聊默认私有均保持。个人QQ与OpenID兼容评估见`IDENTITY-COMPATIBILITY.md`。

## 最新实测结果

| 层次 | 状态与证据 |
| --- | --- |
| 本地源码/声明/JS | 通过；Node v24.21.0、TypeScript 6.0.3；严格核心、发出声明检查与全部候选JS语法 |
| 本地回归 | 291通过、0失败、0取消、0跳过；154项原核心/存储/活版合同回归＋137项配置/候选测试 |
| 真实文件系统 | 合成临时文件的软链/硬链/junction、路径变化及磁盘配置重开负例通过；不使用正式业务文件 |
| 本地HTTP/Tool整合 | 直接调用真实WHATWG Request/Response处理器、真Zod/adapter/service；模拟Host注册、权限服务和storage设施，不代表认证边界验收 |
| 真实Host | 本轮未测候选安装、加载、卸载和实际SDK磁盘持久化；已有只读Host历史证据不套用候选 |
| 认证HTTP | 未测。没有安装候选，也未获取/复用浏览器凭据；本地handler成功不是认证HTTP通过 |
| 界面视觉 | 未测原生DSH React页面、实际点击、深浅主题、浏览器控制台或截图；VM请求回调测试不是视觉验收。未另起替代GUI |
| 平台业务 | QQ/B站/模型/Code真实链路均未测、未接入；没有登录、付费调用或发布 |

生命周期实现另只读核对本机`D:/dsh/resources/app.asar`内Cordis 4.0.5：失活effect抛INACTIVE_EFFECT，setup同步，卸载并发回收。运行测试仍为明确合同mock，不冒充Host实测。

独立审查发现的两项构建门禁问题（noEmit误配置、输出硬链接）均修复并补隔离负例，复核已关闭。最终统一构建/291项测试/归档重新执行通过。最初声明检查遇TypeScript 6要求显式ignoreConfig，修正脚本后通过，未因此降级类型检查。

## 可复现命令

在原项目目录执行，使用已经存在的运行时和编译器，不联网安装：

```powershell
$node = 'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$tsc = 'C:\Users\Administrator\AppData\Roaming\npm\node_modules\openclaw\node_modules\typescript\lib\_tsc.js'
$python = 'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'
& $node scripts/build-candidate.mjs 0.2.0-dev.1 $tsc
& $node --experimental-strip-types --experimental-test-isolation=none --test 'test/*.test.ts' 'test/*.test.mjs'
& $python -I -B scripts/pack-candidate.py 0.2.0-dev.1
```

构建输出仅候选lib，生成build-receipt.json。打包须与最新源码/发射产物hash一致；后续源码变更必须重新构建、验证、打包。根package.json只是开发工作区包，不是安装版本。

归档：`dsh-juebot-0.2.0-dev.1.tgz`，29文件，44052字节。
SHA-256：`4b7e7537590d2d1327d9171ee905cb957e9b0b616f1e7e352550bdbe67433353`。

## 部署前停止点与后续验收

当前无DSH管理工具，按用户指令停在部署前。没有手改profile/软链接、关闭HMR、替换包名、停用maibot-bridge、提交或推送。

升级需用户新的明确指令及正式DSH管理器。届时重新核对desktop/实际Host版本、peers解析与autoInstallPeers、当前包归属及控制配置备份；只备份到私有位置，不把配置值放入共享归档。按管理器的application/warnings/nextStep处理同名包、package-moved或可能的Host重启，不能手工改链接绕过。

可能影响：当前profile的所有会话与原生入口；正式升级可能要求停用/移除旧包或Host重启。候选启用后会读写profile命名空间的小型控制配置，但不会打开业务DB或连接平台。是否需重启以正式管理器结果为准，本轮没有执行。

部署后必须单独补：真实Host加载/卸载与SDK配置持久化、owner认证HTTP成功及未认证/错误Origin拒绝、真实页面交互/刷新持久化/409恢复/控制台与截图。平台业务仍需独立账号、预算与范围授权。

回退：本轮运行态无变更，无需回退在线版本。候选修改前快照位于本聊天`work/prechange`，恢复前需对比后续修改；新增文件单独撤销，不reset/clean整个仓库。未来若已正式升级，使用管理器停用/移除仅本包并恢复经确认的dev.2，不覆盖整个profile；控制配置域与业务库分开保留，不自动降级迁移。

## 证据范围和限制

291项本地测试不证明多Host CAS、SDK断电/fsync耐久或真实平台消息。路径检查不是抗恶意本地TOCTOU的OS沙箱。当前schema和权限仅个人QQ原型；官方OpenID/跨平台身份、PersonLink、用途授权及迁移仍按v0.6规划另行开发。

Git根、master与既有未提交工作保留，作者未配置，本轮未初始化/暂存/提交/推送。git diff --check通过，但juebot仍未跟踪，另记录本轮文件指纹。共享主方案、原决策台账、跨平台规划和插件采用矩阵未被改写；README及CODEX-HANDOFF只追加最新候选状态和安全入口。
