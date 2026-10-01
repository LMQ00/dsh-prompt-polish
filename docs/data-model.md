# 数据模型：浮层状态机

> 状态：设计已定，代码待实现。浮层是单实例、每会话一个；状态少，用普通对象 + 订阅，不引入状态管理库。

## 状态

| 状态 | 浮层可见 | 含义 |
| --- | --- | --- |
| `idle` | 否 | 未触发，或已关闭 |
| `drafting` | 是 | 已发出转写请求，等待模型；展示加载态 |
| `clarifying` | 是 | 模型判定有缺口，展示追问（选项 + 自由填）；带 `round`（1..3） |
| `review` | 是 | 展示只读规范提示词 + 采用 / 带反馈重试 / 放弃 |
| `error` | 是 | 展示失败原因 + 重试；用户已输入的粗糙文本保留 |

终态只有两个，都回到 `idle`：`adopted`（已写入输入框）与 `discarded`（用户放弃）。

## 状态字段

| 字段 | 说明 |
| --- | --- |
| `state` | 上表枚举 |
| `source` | 本次转写的粗糙文本（触发时快照，之后不被输入框编辑影响） |
| `origin` | 触发来源：`command`（有参数）/ `command-draft` / `button` |
| `round` | 已完成的追问轮次，0..3 |
| `transcript` | 追问问答记录：`{ questions[], answers[] }[]`，重试时保留 |
| `draft` | 当前规范提示词（`review` 态） |
| `error` | `{ code, message }`（`error` 态） |
| `requestId` | 在途请求 id；响应不匹配即丢弃 |

## 迁移

| 从 | 事件 | 到 |
| --- | --- | --- |
| `idle` | 触发（有文本） | `drafting` |
| `idle` | 触发（无参数且草稿为空） | `idle` + 浮层提示「先写点东西」（不调模型） |
| `drafting` | 模型要澄清且 `round < 3` | `clarifying`（`round+1`） |
| `drafting` | 模型要澄清且 `round == 3` | `review`（直接出稿，稿内显式标注假设） |
| `drafting` | 模型给稿 | `review` |
| `drafting` | 调用失败 | `error` |
| `clarifying` | 用户回答并提交 | `drafting` |
| `clarifying` | 用户放弃 | `idle`（discarded） |
| `review` | 采用 | `idle`（adopted）+ `setDraft(draft)` |
| `review` | 带反馈重试 | `drafting`（保留 `transcript`，附加 `feedback`） |
| `review` | 放弃 | `idle`（discarded） |
| `error` | 重试 | `drafting`（沿用 `source`） |
| `error` | 放弃 | `idle`（discarded） |

## 追问的硬约束

- **上限 3 轮**。第 3 轮回答后无论是否仍有缺口，一律直接出稿，并在稿的「假设与缺口」段显式标注仍未确定的信息。
- **有缺口才问**：模型自己判断信息是否足够；足够时首轮直接给稿，`clarifying` 不出现。
- 追问形式：每个问题给 2–3 个选项按钮（可多选），同时允许自由填；不强制选。

## 竞态与边界

- **过期响应**：响应 `requestId` 与当前不符 → 丢弃。
- **中途切换会话**：丢弃在途结果，关闭浮层，不写新会话的输入框。
- **重复触发**：`drafting`/`clarifying`/`review` 中再次触发 → 忽略（不打断在途请求）。
- **输入框被用户改动**：`source` 是触发时的快照，用户后续编辑输入框不影响本次转写；但「采用」仍是整段替换，会在浮层上二次提示当前草稿将被覆盖。
- **浮层无会话**：`conversation.input.dock` 只在有 session 时渲染；无会话时不显示，按钮同理置灰。
