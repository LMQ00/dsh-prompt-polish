# 契约

> 状态：设计已定，代码待实现。命令字段名依据 `@deepseek-ai/dsh-commands` 的 `CommandDefinition`（已核实）。

## 命令 `/polish`

| 字段 | 值 |
| --- | --- |
| `name` | `polish` |
| `description` | 把粗糙提示词转写成规范提示词，确认后写入输入框 |
| `input.hint` | 粗糙提示词（留空则用输入框当前内容） |
| `recordInput` | 默认（true）——命令名与参数会记进命令生命周期事件，便于排查 |

### 参数语义

| 调用 | 用的粗糙文本 | 输入框草稿 |
| --- | --- | --- |
| `/polish 帮我写个登录页` | 参数文本 | 不动 |
| `/polish`（草稿非空） | 当前草稿 | 不动（只在「采用」时被替换） |
| `/polish`（草稿为空） | 无 | 浮层提示「先写点东西」，不调模型 |

`rawInput` 按 `parseCommand` 的原样传入，首尾空白由插件 trim；trim 后为空即视为无参数。

### 已知副作用

`/polish` 会在对话流里留下一条命令记录行 —— 这是 DSH 命令机制的固有行为（`command/run`、`command/done` 是 log-only 事件，**模型不可见**，不进模型上下文）。若这条行在实测中不可接受，退路是只保留输入框工具条按钮作为入口（代价：失去命令参数这一输入来源）。

### 已实现的行为

- 命令 `name: 'polish'`，`recordInput: false`，`input: { hint: '粗糙提示词（留空则用输入框当前内容）' }`。
- handler 只返回 `{ kind: 'success' }`，**不返回任何 text**：粗糙文本与规范提示词都不写进 `command/run` / `command/done`。
- 粗糙文本由 Client 提供：点按钮取当前草稿；打 `/polish` 时取按钮组件记下的、含 `/polish` 的最近一行，再用 `stripCommand` 去掉命令 token（token 可能在行首或行尾），其余原样保留。
- 因此上表「参数语义」在实现上等价于：整行去掉 `/polish` 后的剩余文本就是粗糙文本；剩余为空 → `polish/empty-input`。

### 已知副作用

`/polish` 会在对话流里留下一条命令记录行 —— 这是 DSH 命令机制的固有行为（`command/run`、`command/done` 是 log-only 事件，**模型不可见**，不进模型上下文）。本插件已把这条记录压到最小：无 `args`、无结果 `text`。若这条行在实测中仍不可接受，退路是只保留输入框工具条按钮作为入口。

## Config

**v1 不声明 Config**：所有可调项都是 `index.js` 里的代码常量。

| 常量 | 值 | 原计划的 Config 键 |
| --- | --- | --- |
| `MAX_ROUNDS` | `3` | `clarifyRounds` |
| `TIMEOUT_MS` | `60000` | `timeoutMs` |
| 模型 | `ctx.agentDefaultModel.currentSelection()`，不可覆盖 | `model` |

原因：普通 JS 插件要声明 Config 就得 import schema 库（`@deepseek-ai/schemastery`）。本仓库是 workspace 包，模块解析路径与 profile 安装的包不同，v1 先不引入任何 bare import 以保证能加载；等确认 bare import 可用后再补 Config。不提供语言配置：输出语言固定跟输入语言（产品契约，见下）。

## 转写输出契约

模型每次返回必须是结构化 JSON（追问或出稿二选一），插件解析后再渲染：

```jsonc
// 追问
{ "kind": "questions", "questions": [
  { "id": "q1", "text": "这个登录页给谁用？", "options": ["内部员工", "外部客户"], "multi": false }
]}

// 出稿
{ "kind": "prompt", "prompt": "……", "assumptions": ["……"] }
```

出稿的 `prompt` 必须满足（四硬清单，用户确认）：

1. **任务与目标** —— 要什么结果、做什么、不做什么。
2. **输出格式与验收标准** —— 交付成什么形式、怎么算完成。
3. **缺口显式标注** —— 原始描述没提但影响结果的信息，必须标出来。
4. **不得发明需求** —— 不添加用户未表达的需求。

另加：

- 语言跟输入语言，术语保留英文。
- JSON 解析失败 → 按 `polish/bad-output` 处理（见下），不把裸文本塞进输入框。

## RPC 契约

- 通道 `/polish`，端点 `translate`。
- 请求：`{ text: string, transcript: [{ questions, answers }], feedback: string }`。
- 成功：`{ kind:'questions', questions }` 或 `{ kind:'prompt', prompt, assumptions }`。
- 失败：`{ code, message, details }`。

## 错误码

实现里的真实 code（Host 抛、Client 渲染）：

| code | 触发 | 浮层文案 | 可否重试 |
| --- | --- | --- | --- |
| `polish/empty-input` | 粗糙文本 trim 后为空 | 先写点东西再触发转写 | 否（按钮/命令入口仍可用） |
| `polish/no-model` | `agentDefaultModel.currentSelection()` 没有 provider/model | 当前没有可用的默认模型… | 是 |
| `polish/bad-output` | 模型没返回 JSON、JSON 不可解析、或结构不认识 | 模型返回了… | 是 |
| `polish/llm-error` | 模型报错、结束原因是 `error`/`max-tokens`/未知 | 模型给出的原因 | 是 |
| `polish/timeout` | 超过 `TIMEOUT_MS` | 超过 60 秒仍未返回 | 是 |
| `polish/aborted` | 调用方中止（关浮层、换会话） | 不显示（已静默关闭） | — |
| `polish/transport-error` | Client 侧 HTTP/桥失败 | 传输错误原文 | 是 |
| `polish/unknown-endpoint` | 端点名不对 | 未知端点 | — |

所有错误都不清空用户已输入的粗糙文本。
