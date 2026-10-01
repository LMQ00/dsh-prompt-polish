# 数据模型：浮层状态机

> 状态：**已实现**（`client.js` 的 `readState`/`writeState`）。浮层是单实例、每会话一个；状态少，用普通对象 + 订阅，不引入状态管理库。

## 状态

| 状态 | 浮层可见 | 含义 |
| --- | --- | --- |
| `idle` | 否 | 未触发，或已关闭 |
| `input` | 是 | 没有现成粗糙文本（草稿为空）时打开：面板内给一个可编辑文本框 + 「转写」 |
| `drafting` | 是 | 已发出转写请求，等待模型；展示加载态 |
| `clarifying` | 是 | 模型判定有缺口，展示追问（选项 + 自由填） |
| `review` | 是 | 展示只读规范提示词 + 采用 / 带反馈重试 / 放弃 |
| `error` | 是 | 展示失败原因 + **可编辑的原文** + 「转写」；已输入的粗糙文本保留 |

`input` 是第 1 轮开发后补的状态：原本草稿为空只弹一句「先写点东西」，用户反馈「面板里不能输入」——需求本来就是想在面板里直接写，而不是被赶回输入框。

终态只有两个，都回到 `idle`：`adopted`（已写入输入框）与 `discarded`（用户放弃）。

## 状态字段

| 字段 | 说明 |
| --- | --- |
| `state` | 上表枚举 |
| `source` | 本次转写的粗糙文本（触发时快照，之后不被输入框编辑影响） |
| `transcript` | 追问问答记录：`{ questions[], answers[] }[]`，重试时保留。**轮次不单独存**：`transcript.length` 就是已完成轮次 |
| `prompt` | 当前规范提示词（`review` 态） |
| `assumptions` | 模型标注的假设（`review` 态） |
| `questions` | 待回答的问题（`clarifying` 态） |
| `error` | `{ code, message }`（`error` 态） |
| `controller` | 该次请求的 `AbortController`；响应回来时若 store 里已不是发起时那个状态对象，直接丢弃 |

### 浮层内的回答草稿（纯 UI 状态，不进 store）

每个问题一个槽：`{ options: string[], custom: string }`。选项与自由填**并存**，提交时 `[...options, custom].filter(Boolean).join('、')` 序列化成 Host 收的字符串。

用数组而不是拼接字符串存选项，是为了避免选项文案里出现 `、` 时把切换逻辑弄坏（v1 用字符串拼接，这是缺陷）。

槽在「问题集合签名」或 phase 变化时重置；重置发生在 **render 阶段**（React 官方的「prop 变了就调整 state」写法），不用 effect —— effect 会和击键竞争，把输入吞掉。

## 迁移

| 从 | 事件 | 到 |
| --- | --- | --- |
| `idle` | 触发（有文本） | `drafting` |
| `idle` | 触发（无参数且草稿为空） | `input`（面板内可编辑文本框，不调模型） |
| `input` | 点「转写」且文本非空 | `drafting`（`transcript` 为空） |
| `input` | 点「关闭」 | `idle`（discarded） |
| `drafting` | 模型要澄清且 `transcript.length < 3` | `clarifying` |
| `drafting` | 模型要澄清且已达上限 | `review`（直接出稿，稿内显式标注假设；实际由 Host 提示词强制） |
| `drafting` | 模型给稿 | `review` |
| `drafting` | 调用失败 | `error` |
| `clarifying` | 用户回答并提交 | `drafting`（`transcript` 追加一轮） |
| `clarifying` | 用户放弃 | `idle`（discarded） |
| `review` | 采用 | `idle`（adopted）+ `setDraft(prompt)` |
| `review` | 带反馈重试 | `drafting`（保留 `transcript`，附加 `feedback`） |
| `review` | 放弃 | `idle`（discarded） |
| `error` | 点「转写」（原文可改） | `drafting`（沿用 `transcript`，**保留已问到的澄清轮次**） |
| `error` | 关闭 | `idle`（discarded） |

## 追问的硬约束

- **上限 3 轮**。第 3 轮回答后无论是否仍有缺口，一律直接出稿，并在稿的「假设与缺口」段显式标注仍未确定的信息。
- **有缺口才问**：模型自己判断信息是否足够；足够时首轮直接给稿，`clarifying` 不出现。
- 追问形式：每个问题给 2–3 个选项按钮（可多选），同时允许自由填；不强制选。

## 竞态与边界

- **过期响应**：响应回来时 `readState(sessionId)` 已不是发起时那个状态对象 → 丢弃（等价于请求 id，少一层状态）。
- **中途切换会话**：丢弃在途结果，关闭浮层，不写新会话的输入框。
- **重复触发**：`drafting`/`clarifying`/`review` 中再次触发 → 新请求先 `abort` 掉旧请求再接管。
- **输入框被用户改动**：`source` 是触发时的快照，用户后续编辑输入框不影响本次转写；但「采用」仍是整段替换，会在浮层上二次提示当前草稿将被覆盖。
- **浮层无会话**：`conversation.input.dock` 只在有 session 时渲染；无会话时不显示，按钮同理置灰。
