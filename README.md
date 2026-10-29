# juebot（撅撅）

juebot 是从作者现有 DSH 本地项目整理的公开开发仓库：围绕连续记忆、社交行为、自我状态、独立 Code 任务和人工审核创作，提供原生控制面及离线可验证的候选实现。本仓库保留设计、源码、历史候选与构建原件，公开不等于授予额外开源许可；未新增许可证，出处与范围见各包 NOTICE。

## 当前状态

当前候选为 **0.3.0-dev.7**：纯 GET 修复与诊断；原 rc.3 连接依赖仍阻塞混合路由 GET。仅装插件不足以恢复整个面板，独立连接补丁不包含于安装包，也不代表正式运行时已发布修复。

既有统一验证 **961通过，0失败，0取消，0跳过**；公开整理未重跑。dev.7 Desktop、现场HTTP、真实UI及平台业务未验收。详情见 [验证报告](docs/DEV7-VERIFICATION.md)。

## 下载与安装控制面

请使用 [Release tgz](https://github.com/buruqu/juebot/releases/download/v0.3.0-dev.7/dsh-juebot-0.3.0-dev.7.tgz)，按 [安装说明](docs/DEV7-INSTALL.md) 核对哈希并通过正式管理器安装。GitHub Download ZIP 不是安装包。

## 开发入口与限制

- `next/agent-v1`：当前行为链源码、Host 桥、测试和编译产物；`src`/`bundle` 保留早期核心及控制面。
- `candidates`：0.2 和 dev.1–dev.7 的封存候选，原件逐字节保留。不要修改历史候选或向活 bundle 输出构建。
- `tools/build_agent_candidate.py`：独立候选构建入口。原 Windows 默认 Node/TypeScript 路径属于作者环境，换机必须显式提供自己的 `--node` 与 `--tsc`（现有 TypeScript 编译器脚本路径），例如 `python tools/build_agent_candidate.py --node /absolute/path/to/node --tsc /absolute/path/to/tsc.js`。此命令可能生成输出，使用前阅读脚本的保护和收据检查。
- `tools/verify_agent_candidate.py` 是原环境验证入口，依赖原环境工具链和证据前提，不承诺跨机一键验证。本次未运行默认 build，也没有重建发布 tgz。
- 默认 npm build/pack 入口受保护；不自动安装依赖或第三方 SDK。可选本地视频合成仍含原环境 ffmpeg 路径，换机需要适配。

原文历史说明见 [PROJECT-README](docs/PROJECT-README.md)；导出来源、排除和限制见 [PUBLIC-EXPORT](PUBLIC-EXPORT.md)。历史文档中的状态和测试计数可能属于旧轮次，以此处当前版本边界为准。
