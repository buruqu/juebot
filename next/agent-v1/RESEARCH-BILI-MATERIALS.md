# Bili Whale 读取与创作材料接点

2026-10-29，只读核对。此文件是接入设计证据，不代表已实现或获准读取真实B站。

固定上游 `Alterssss/dsh-bili-whale` 0.4.6，提交 `8b0009f8ce2ebdc421afcb2e727b19ac18912ec6`：[package.json](https://github.com/Alterssss/dsh-bili-whale/blob/8b0009f8ce2ebdc421afcb2e727b19ac18912ec6/package.json)。

## 可参考部分与副作用

[comments.mjs](https://github.com/Alterssss/dsh-bili-whale/blob/8b0009f8ce2ebdc421afcb2e727b19ac18912ec6/tools/commands/comments.mjs) 的47–94行体现 BV查询元信息取得aid，再以 type=1/oid=aid、sort、ps/pn读取评论并映射rpid/mid/text/page/total。它同时会读取用户级Cookie和写评论缓存，不能直接导入或执行CLI作为纯材料端口。

[debrief.mjs](https://github.com/Alterssss/dsh-bili-whale/blob/8b0009f8ce2ebdc421afcb2e727b19ac18912ec6/tools/commands/debrief.mjs) 包含顶层凭据读取、下载和落盘；[Host](https://github.com/Alterssss/dsh-bili-whale/blob/8b0009f8ce2ebdc421afcb2e727b19ac18912ec6/lib/index.js) 启动自主调度。因此复用接口机制与受审查的工具片段，保持 juebot 自身人格、意愿和统一发送入口，不整装第二套运营主体。

上游主体[MIT许可](https://github.com/Alterssss/dsh-bili-whale/blob/8b0009f8ce2ebdc421afcb2e727b19ac18912ec6/LICENSE)及[NOTICE](https://github.com/Alterssss/dsh-bili-whale/blob/8b0009f8ce2ebdc421afcb2e727b19ac18912ec6/NOTICE.md)需独立保留；B站内容、社区接口文档和媒体工具许可不由该MIT许可代替。本轮没有拷贝或打包上游实现。

## 下一轮最小实现合同

1. `bili-read-source`：只有显式 `read({bvid,page,limit,sort},{signal})` 才调用可信注入transport。固定HTTPS主机和路径，不跟重定向、不访问响应中的媒体URL、不自动找Cookie/登录/重试/调用模型。身份ID以字符串保存，不安全整数直接拒绝。
2. 持久保存不可变材料快照：命名空间账号、BV/aid/cid、作者及评论ID、内容hash、来源版本、取得时间、分页与覆盖范围。错误BV/aid绑定、重复评论、超限、风控/超时、撤权期间返回均失败关闭。只取得标题/简介/评论不能声称看完视频。
3. `bili-materials`：从已保存快照投影到 `CreativeMaterials`，逐次核实来源当前修订、期限、受众和draft/publish授权，不在此回调重新HTTP或修改时间。

接点是 `src/creative-workflow.ts` 的材料端口与 `host/application.js` 的 `ports.creative.materials`。创作流程会在计划、制作后重读并比较完整材料；每次获取新时间、播放量或版本会造成持续 `MATERIALS_CHANGED`，因此显式刷新与撤销才改变快照版本。

材料现有边界为64来源、64条目，每条4000字符、总64000字符。来源登记与读取分开；公开可读不等于可以学习、跨平台共享或用于公开创作。最终评论、回复和作品仍逐件人工审核，改变内容/目标/来源须重审。身份使用已有bilibili/thread命名空间，不把UID与QQ/OpenID自动关联。

本轮仅完成接点调查。真实允许的账号、接口、来源名单、请求额度、保留期限和平台协议兼容性仍待确认/验收；没有访问B站、读取凭据、加载插件或发布内容。
