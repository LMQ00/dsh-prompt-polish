# 技术选型

> 状态：设计已定，代码待实现。选型依据来自 `/polish` 需求访谈（见 [decisions.md](decisions.md)）。

## 运行时与语言

| 项 | 选择 | 理由 |
| --- | --- | --- |
| 宿主 | DSH `0.2.0-rc.2`（本机安装于 `/nix/store/phlcm79hb1aym7w3xdspj5qrgz8g4qjg-dsh-0.2.0-rc.2/`） | 功能以 DSH 插件形态交付，只能用宿主提供的扩展点 |
| 语言 | 普通 ESM JavaScript，无构建步骤 | 与官方插件模板一致；Client 半边由 DSH 的 client module loader 直接加载，引入编译步骤只会增加故障面 |
| 包形态 | 一个可安装 bundle，源码放仓库根目录（规则 D6） | 见 [architecture.md](architecture.md) 的目录结构 |
| 依赖 | 不声明对 DSH 内置包（`@deepseek-ai/dsh-*`）的依赖 | 这些包从 DSH 安装处解析；bundle 只声明自己的元数据与入口 |

Client 半边的 React 导入方式以官方模板 `templates/decoration/client.js`（见 skill `cordis-plugin-development`）为准，不自行假定运行时注入的符号集。

## 用到的宿主能力

| 能力 | 接口 | 来源包 |
| --- | --- | --- |
| 注册斜杠命令 | `ctx.commands.register({ name, description, input, handler })` | `@deepseek-ai/dsh-commands` |
| 直接调模型（不进会话） | `ctx.llm`（prepare / stream） | `@deepseek-ai/dsh-llm` |
| 取当前默认模型 | `ctx.agentDefaultModel.currentSelection()` | `@deepseek-ai/dsh-agent-default-model` |
| 写入输入框 | `InputActions.setDraft(text)` | `@deepseek-ai/dsh-client-ui-conversation` |
| 浮层挂载点 | slot `conversation.input.dock` | 同上 |
| 触发按钮挂载点 | slot `conversation.input.right` | 同上 |
| 插件配置 | bundle 的 `cordis.patch.yml` + 插件 `Config` schema | Loader |

## 明确不引入

- **不引入独立 LLM SDK**（openai / anthropic 等）：转写走 `ctx.llm`，复用宿主已配置的凭据与重试策略，插件不接触任何密钥。
- **不引入 UI 组件库**：浮层样式只用 DSH 主题 token（见 [architecture.md](architecture.md)），不 import 任何 Harness Client UI 包。
- **不引入状态管理库**：浮层状态机是单实例、状态少（见 [data-model.md](data-model.md)），用普通对象 + 订阅即可。
- **不引入模板引擎**：转写提示词是固定字符串 + 变量拼接。
