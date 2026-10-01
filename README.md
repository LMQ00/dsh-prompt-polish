# dsh-prompt-polish

DSH 插件：把粗糙提示词转写成规范提示词，浮层预览确认后写入输入框（**不自动发送**）。

- 入口：`index.js`（Host 半边，`export function apply(ctx)`）+ `client.js`（Client 半边，
  `dsh.client.platform = web`）
- 依赖：**零**。`index.js` 没有任何 bare import，只用相对路径与 Node 内建；`client.js`
  唯一的外部符号是模块加载器提供的 `require('react')`——它是浏览器模块表的查询，不是 ESM
  的包解析，所以不构成依赖。
- 安装形态：`link:` 进 profile `web`，Loader 行为 `include:polish`。

## 用法

```
/polish <粗糙提示词>    # 用参数文本转写，输入框草稿不动
/polish                 # 无参数：用输入框当前草稿
```

也可以点输入框工具条里的按钮（模型选择器左侧）触发。

| 调用 | 用的粗糙文本 | 输入框草稿 |
| --- | --- | --- |
| `/polish 帮我写个登录页` | 参数文本 | 不动 |
| `/polish`（草稿非空） | 当前草稿 | 不动，只在「采用」时被替换 |
| `/polish`（草稿为空） | 无 | 浮层提示「先写点东西」，不调模型 |

转写结果在输入框上方的浮层里预览，点「采用」才写进输入框。模型认为信息不够时最多追问 3 轮，
追问选项的形状刻意对齐 DSH 内置的提问组件。

## 规则

- **从不自动发送。** `inputActions.submit` 全程未被引用；「采用」只写输入框，发送始终由
  用户自己按。
- **用户文本不进会话日志。** 转写在 Host 的私有路由 `POST /polish/translate` 上完成，粗糙
  文本与规范提示词都不 append 到 session。
- **输出语言跟输入语言**，不提供语言配置。
- **v1 不声明 Config。** `MAX_ROUNDS = 3`、`TIMEOUT_MS = 60000`、模型取
  `ctx.agentDefaultModel`，都是 `index.js` 里的代码常量。

开发规范（临时文件位置、验证流程、提交习惯、绝对路径禁令等）见 [`AGENTS.md`](AGENTS.md)
的 D1–D8，那里是唯一权威。

## 文档索引

| 文档 | 何时读 |
| --- | --- |
| [`docs/交接文档.md`](docs/交接文档.md) | 第一次接手，或不确定该读哪份时 |
| [`docs/tech-stack.md`](docs/tech-stack.md) | 改技术选型、加依赖、考虑换实现方式前 |
| [`docs/architecture.md`](docs/architecture.md) | 改模块划分、Host/Client 职责、调用桥、写入路径前 |
| [`docs/data-model.md`](docs/data-model.md) | 改浮层状态机、追问轮次、错误态前 |
| [`docs/api.md`](docs/api.md) | 改 `/polish` 命令契约、HTTP 契约、输出契约、错误码前 |
| [`docs/development.md`](docs/development.md) | 搭环境、安装 bundle、判断是否真的生效前 |
| [`docs/testing.md`](docs/testing.md) | 写测试、跑测试、跑盲读测试前 |
| [`docs/runbook.md`](docs/runbook.md) | 出问题时：按钮不见、浮层错位、打字打不进、改了不生效 |
| [`docs/decisions.md`](docs/decisions.md) | 追问「为什么这么设计」「为什么不用 X」前 |

## 自测

```
npm test      # = node --test，自动发现 test/*.test.js，零依赖
```
