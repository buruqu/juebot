# juebot（撅撅）

juebot 是从作者现有 DSH 本地项目整理的公开开发仓库：围绕连续记忆、社交行为、自我状态、独立 Code 任务和人工审核创作，提供原生控制面及离线可验证的候选实现。本仓库保留设计、源码、历史候选与构建原件，公开不等于授予额外开源许可；未新增许可证，出处与范围见各包 NOTICE。

## 当前状态

当前候选为 **0.3.0-dev.6，尚未部署**。原项目已有的本地验证记录为 **937 项通过、0 失败、0 跳过**；这是既有证据，公开整理没有重跑这 937 项。真实 Host、认证 HTTP、UI 视觉及交互、QQ、B站、真实模型和实际 Code 工作区均未验收，不能据此认定平台业务可用。后台默认关闭，数据路径为空，安装不自动开启 QQ/B站、模型、Code 执行或正式数据库。

## 下载与安装控制面

1. 到 [v0.3.0-dev.6 Release](https://github.com/buruqu/juebot/releases/tag/v0.3.0-dev.6) 下载 **dsh-juebot-0.3.0-dev.6.tgz**。
2. 核对 SHA-256：`6a032b2b705454fd19e3c212a6c34d48dff60549f3b22f6648f1190284cc1c75`。
3. 在兼容的 DSH **0.2.1-rc.3** 原生插件管理/控制面中选择本地包安装入口，导入该 tgz，并由正式管理器应用至目标 profile。不同管理界面的入口名称可能不同；本次未验证实际安装流程。
4. 应用后查看原生 `juebot` 面板与 `juebot-setup` 设置面板。后台启用、管理员身份、数据位置、模型预算与平台接线需要另行配置和验收。

**GitHub 的 Download ZIP 是源码工作区，根目录不是可安装插件。请下载上述 tgz，不能把源码 ZIP 当插件安装。** 包的声明 Node 要求为 >=22.18.0，不代表所有符合版本均已实测。

## 开发入口与限制

- `next/agent-v1`：当前行为链源码、Host 桥、测试和编译产物；`src`/`bundle` 保留早期核心及控制面。
- `candidates`：0.2 和 dev.1–dev.6 的封存候选，原件逐字节保留。不要修改历史候选或向活 bundle 输出构建。
- `tools/build_agent_candidate.py`：独立候选构建入口。原 Windows 默认 Node/TypeScript 路径属于作者环境，换机必须显式提供自己的 `--node` 与 `--tsc`（现有 TypeScript 编译器脚本路径），例如 `python tools/build_agent_candidate.py --node /absolute/path/to/node --tsc /absolute/path/to/tsc.js`。此命令可能生成输出，使用前阅读脚本的保护和收据检查。
- `tools/verify_agent_candidate.py` 是原环境验证入口，依赖原环境工具链和证据前提，不承诺跨机一键验证。本次未运行默认 build，也没有重建发布 tgz。
- 默认 npm build/pack 入口受保护；不自动安装依赖或第三方 SDK。可选本地视频合成仍含原环境 ffmpeg 路径，换机需要适配。

原文历史说明见 [PROJECT-README](docs/PROJECT-README.md)；导出来源、排除和限制见 [PUBLIC-EXPORT](PUBLIC-EXPORT.md)。历史文档中的状态和测试计数可能属于旧轮次，以此处当前版本边界为准。
