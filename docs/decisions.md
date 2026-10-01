# 决策记录

> 每条记录「决定了什么」与「否决了什么」。改设计前先读这里，避免重走已否决的路。

## 产品定位

**目标**：把用户粗糙的一句话/一段话转写成规范提示词，让**无上下文的模型**也能准确理解意图 —— 用户原话「其实最重要的是把事情说清楚」「大概我想要的就是让我的话能对齐大模型吧」。

由此推出：「规范」不等于套模板，也不等于适配某个特定模型。验收靠盲读测试（见 [testing.md](testing.md)）。

## 不可协商的产品边界

用户明确勾选，**不进 AGENTS.md**（AGENTS.md 只放开发规范），改动需重新确认：

| 边界 | 含义 |
| --- | --- |
| 绝不自动发送 | 「采用」只调 `setDraft`；代码里不得出现提交/发送调用 |
| 绝不写入任何文件 | 插件运行期不注入、不调用任何 fs 写接口 |
| 不进会话历史 | 转写只走 `ctx.llm`，不注入 `agentLoop`、不追加会话事件，不污染模型上下文 |
| **可以读会话上下文** | 用户在第 2 轮开发追加：「要能读上下文」。Host 只读 `ctx.sessionQuery.observeSession()` 取最近消息用于消歧；边界管的是**写**，读不受限 |
| 不做模板管理 | 不做多模板 / 模板库 / 模板编辑器 |
| 不做批量 | 只处理一条提示词 |
| 不加其他入口 | 除 `/polish` 与模型选择器左侧那个按钮外，不做快捷键、右键菜单等 |

## 关键决策

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 交付形态 | DSH 插件 bundle | 只有插件能同时拿到命令注册与输入框写入能力 |
| 转写执行者 | 插件独立调 `ctx.llm` | 用户选定；且不污染会话历史 |
| 结果展示面 | 输入框正上方浮层（`conversation.input.dock`） | 用户要求「输入框上方浮层」；源码 `client.js:16309` 核实该 slot 渲染在输入框卡片之前 |
| 触发按钮位置 | 模型选择器左侧（`conversation.input.right`） | 用户在截图上圈定；源码 `client.js:17532` 核实该 slot 渲染在 `conversation.input.model` 之前 |
| 触发入口 | `/polish` 命令 + 按钮，二者共用一套逻辑 | 用户要求两者都支持 |
| 粗糙文本来源 | 有参数用参数，无参数用当前草稿 | 用户选「两者都支持」 |
| 缺信息处理 | 先追问澄清，浮层内多轮，上限 3 轮 | 用户选定；上限避免无限问答 |
| 追问形式 | 选项按钮（可多选）+ 可自由填 | 回答成本最低且不限制表达 |
| 浮层内容 | 只读，不能直接改 | 用户选定；要改就带反馈重试，或采用后回输入框改 |
| 重试语义 | 只带反馈重试 | 用户选定；「不满意」需填一句理由，理由进下一轮请求 |
| 写入方式 | 整段替换 + 聚焦 | 用户选定；符合「我认可了再发送」 |
| 输出语言 | 跟输入语言，术语保留英文 | 用户选定 |
| 模型 | 默认跟随当前会话默认模型，Config 可覆盖 | 用户选定；既不突兀又能兜底 |
| 生成历史 | 不保留 | 与「不进会话历史」一致 |
| 源码位置 | 仓库根目录 | 用户原话「源码放根目录，就是给这个项目用的」 |
| 临时文件 | 只放 `tmp/` | 用户指定的开发规范 |

## 被否决的方案

| 方案 | 否决原因 |
| --- | --- |
| 纯提示词模板文件 | 只能复制粘贴，无法自动写进输入框 |
| DSH skill | 同上：skill 只能让模型输出文本，写不了输入框 |
| 由当前会话 Agent 回答 | 会在会话里产生一轮对话、污染上下文；用户明确选了插件独立调模型 |
| 命令结果走 chat 行展示 | 用户要的是输入框上方浮层，不是对话流里的卡片 |
| 在 AI 回复上加「插入输入框」按钮 | 依赖会话里产生一轮回复，与「不进会话历史」冲突 |
| 输入框浮层内可编辑 | 用户选定只读；可编辑会让「采用」与「手改」的语义混淆 |
| 固定结构模板（角色/任务/上下文/约束/输出格式…） | 用户否决：「ai来转」，由 AI 判断怎么才算清楚 |
| 面向特定目标模型调优 | 用户否决：重点是「把事情说清楚」，不是适配某个模型 |
| 保留生成历史 | 与「不进会话历史」冲突，且增加存储面 |
| 包目录放 `packages/polish/` | 用户否决：源码放仓库根目录 |
| 把产品边界写成 AGENTS.md 规则 | 用户裁决：AGENTS.md 只放开发规范规则，产品特性归 docs/ |
| 调用桥用 `ctx.remote.commands.execute` 执行 `/polish`，拿命令结果回传 | 命令结果会进 `command/done`，等于把规范提示词写进会话日志，违反产品边界；且命令 handler 跑在 Host，拿不到输入框 |
| 调用桥用 Typert 生成的 `ctx.remote.*` 命名空间 | 需要生成产物与构建步骤；本仓库是普通 JS、无构建 |
| 浮层可编辑 | 用户选定只读；重试必须带反馈 |
| v1 就声明 Config | 声明 Config 要 import schema 库；workspace 包的模块解析路径与 profile 安装包不同，先保证能加载，Config 延后 |

## 已实现的决策（第 1 轮开发）

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 调用桥 | 插件自有 HTTP 路由：Host `ctx.webServer.register({kind:'exact', path:'/polish/translate'})`，Client 普通 `fetch` | 不需要代码生成；走 HTTP，不落会话日志；认证复用 `ctx.connection.requestRejection` |
| Host `inject` | `['commands','llm','agentDefaultModel','connection','webServer']` | 路由挂在 `webServer`；`connection` 只用来取认证判定 |
| 为什么不用 `ctx.connection.rpc.handle` | **实测不可用**：`handle` 把路由挂在 connection 服务自己的 ctx 上（`register(this.ctx, …)`），该 ctx 的 inject 只有 `credentials` + `webRuntime`，不含 `webServer`，任何调用方都撞 `cannot get property "webServer" without inject`；给本插件加 `webServer` 无效，因为 owner 不是本插件 | 上游问题，不是配置错误 |
| 为什么不用 `rpc.intercept('/api', …)` | API Gateway 已占 `/api` 的唯一 interceptor，第二个注册直接抛错 | — |
| `/polish` 命令的角色 | 只做「可见性 + 触发信号」：`recordInput: false`，handler 返回 `{kind:'success'}` 不带 text | 让命令记录行里既没有粗糙文本也没有规范提示词 |
| 粗糙文本的来源 | Client 记下含 `/polish` 的最近一行草稿，`command/executed` 时取用 | 命令提交会清空草稿；这样不用把文本写进会话日志 |
| 在途请求作废 | AbortController + 状态对象身份比较 | 比造请求 id 少一层状态 |
| v1 无 Config | 常量写死在 `index.js` | 见上 |

## 已知未决/风险

- `/polish` 会在对话流留下一条命令记录行（DSH 命令机制固有，log-only、模型不可见）。已压到无 `args`、无结果 `text`。若实测仍不可接受，退路是只保留按钮入口。详见 [api.md](api.md)。
- 改 Host 半边（`index.js`）后，**必须重启 dsh 才能生效**：Host 模块被 ESM 缓存，`set_plugin` 关开一次也只会复用旧模块。Client 半边（`client.js`）不受此限。
- Config 延后：待确认 workspace 包能否 bare import `@deepseek-ai/schemastery`。
