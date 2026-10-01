# 技术选型

> 状态：**已实现**。选型依据来自 `/polish` 需求访谈（见 [decisions.md](decisions.md)）。

## 运行时与语言

| 项 | 选择 | 理由 |
| --- | --- | --- |
| 宿主 | DSH `0.2.0-rc.2`（本机安装于 `/nix/store/phlcm79hb1aym7w3xdspj5qrgz8g4qjg-dsh-0.2.0-rc.2/`） | 功能以 DSH 插件形态交付，只能用宿主提供的扩展点 |
| 语言 | 普通 ESM JavaScript，无构建步骤 | 与官方插件模板一致；Client 半边由 DSH 的 client module loader 直接加载，引入编译步骤只会增加故障面 |
| 包形态 | 一个可安装 bundle，源码放仓库根目录（规则 D6） | 见 [architecture.md](architecture.md) 的目录结构 |
| 依赖 | **零**：`package.json` 没有 `dependencies`；不声明对 DSH 内置包（`@deepseek-ai/dsh-*`）的依赖 | 这些包从 DSH 安装处解析；bundle 只声明自己的元数据与入口 |

`index.js` **没有任何 bare import**（只用相对路径与 Node 内建）。`client.js` 唯一的外部符号是模块加载器提供的 `require('react')`——它是浏览器模块表的查询，不是 ESM 的包解析，所以不构成依赖。

## 用到的宿主能力

| 能力 | 接口 | 来源包 |
| --- | --- | --- |
| 注册斜杠命令 | `ctx.commands.register({ name, description, input, handler })` | `@deepseek-ai/dsh-commands` |
| 直接调模型（不进会话） | `ctx.llm.stream(options)` | `@deepseek-ai/dsh-llm` |
| 取当前默认模型 | `ctx.agentDefaultModel.currentSelection()` | `@deepseek-ai/dsh-agent-default-model` |
| 只读会话上下文 | `ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'none' })` | `@deepseek-ai/dsh-session-query` |
| 注册自有 HTTP 路由 | `ctx.webServer.register({ kind, path, handler })` | `@deepseek-ai/dsh-host-webserver` |
| 路由认证判定 | `ctx.connection.requestRejection({ headers })` | `@deepseek-ai/dsh-client-connection` |
| 写入输入框 | `InputActions.setDraft(text)` | `@deepseek-ai/dsh-client-ui-conversation` |
| 浮层挂载点 | slot `conversation.input.dock` | 同上 |
| 触发按钮挂载点 | slot `conversation.input.right` | 同上 |
| 插件行与 Config | bundle 的 `cordis.patch.yml`；**本插件不声明 `Config`**，可调项是 `index.js` 里的代码常量 | Loader |

## 明确不引入

- **不引入独立 LLM SDK**（openai / anthropic 等）：转写走 `ctx.llm`，复用宿主已配置的凭据与重试策略，插件不接触任何密钥。
- **不引入 UI 组件库**：浮层样式只用 DSH 主题 token（见 [architecture.md](architecture.md)），不 import 任何 Harness Client UI 包。
- **不引入状态管理库**：浮层状态机是单实例、状态少（见 [data-model.md](data-model.md)），用普通对象 + 订阅即可。
- **不引入模板引擎**：转写提示词是固定字符串 + 变量拼接。
