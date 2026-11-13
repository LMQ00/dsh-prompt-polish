# 003 生命周期

跟着一次转写从触发走到关闭。概念见 [001 领域模型](001-domain.md)，准入与上限见 [002 规则与权限](002-rules.md)。

## 阶段

一次转写同一时间只有一个阶段，由浮层此刻在等什么决定。从上往下读，第一条成立的为准。

| 阶段 | 成立条件 | 界面文字 |
| --- | --- | --- |
| 输入 | 触发时粗糙文本为空 | 规范提示词 · 输入请求 |
| 转写中 | 请求已发出，还没拿到结果 | 规范提示词 · 转写中 |
| 澄清 | 模型返回 `{kind:'questions'}` 且本轮预算未用尽 | 规范提示词 · 需要澄清 |
| 预览 | 模型返回 `{kind:'prompt'}` | 规范提示词 |
| 失败 | 任何一步失败，或预算用尽仍在追问 | 规范提示词 · 未完成 |
| 关闭 | 采用、放弃，或还没触发 | 浮层不渲染 |

## 状态字段

每个会话一份，整体替换。

| 字段 | 装什么 |
| --- | --- |
| `phase` | 上表的状态 |
| `source` | 本次要转写的粗糙文本，触发时的快照 |
| `transcript` | 已问过并得到回答的轮次，`{ questions[], answers[] }[]`，只增不减 |
| `rounds` | 本次尝试已花掉的追问轮次，0 到 3 |
| `prompt` | 规范提示词（预览态） |
| `assumptions` | 模型标注的假设（预览态） |
| `questions` | 待回答的问题（澄清态） |
| `imageFiles` | 触发那一刻抓到的浏览器 `File` 数组 |
| `code` / `message` | 错误码与文案（失败态） |
| `controller` | 该次请求的 `AbortController` |

`rounds` 与 `transcript.length` 是两件事：记录只增不减，预算可以在「不满意，重试」时归零。

`imageFiles` 存 `File` 而不是 base64：编码只在每次发请求前做一次，避免把几 MB 的字符串常驻在状态里，也避免重试时拿旧编码。纯文本路径不做任何编码，也不加 `await`。

## 迁移表

| 从 | 事件 | 到 |
| --- | --- | --- |
| `idle` | 触发且有文本 | `drafting` |
| `idle` | 触发且无参数、草稿为空 | `input` |
| `input` | 点「转写」且文本非空 | `drafting`（`transcript` 为空） |
| `input` | 点「关闭」 | `idle` |
| `drafting` | 模型要澄清且 `rounds < 3` | `clarifying`（`rounds + 1`） |
| `drafting` | 模型要澄清但 `rounds >= 3` | `error` + `polish/round-limit` |
| `drafting` | 模型给稿 | `review` |
| `drafting` | 调用失败 | `error` |
| `clarifying` | 用户回答并提交 | `drafting`（`transcript` 追加一轮） |
| `clarifying` | 用户放弃 | `idle` |
| `review` | 采用 | `idle` + `setDraft(prompt)` |
| `review` | 带反馈重试 | `drafting`（保留 `transcript`，`rounds` 归零，带 `feedback`） |
| `review` | 放弃 | `idle` |
| `error` | 点「转写」（原文可改） | `drafting`（沿用 `transcript` 与 `rounds`） |
| `error` | 关闭 | `idle` |

## 执行者

转写由插件自己在 Host 上执行，不创建子代理、不进会话。

| 项 | 值 |
| --- | --- |
| 执行者 | `index.js` 里的 `translate()` |
| 身份 | 插件自己的 `ctx.llm` 调用，不带 `sessionId`、不带 `purpose` |
| 模型 | 会话当前模型，见 [002 规则与权限](002-rules.md) §准入表 |
| 目录 | 无；插件不读也不写任何文件 |
| 接入接口 | `ctx.llm.stream()`、`ctx.attachments.admitPromptContent()`、`ctx.sessionQuery.observeSession()` |

## 一次转写的时序

1. Client 取粗糙文本与图片 `File`，写一个 `drafting` 状态，带上自己的 `AbortController`。
2. Client 把图片编码成 base64，连同 `sessionId`、`text`、`transcript`、`rounds`、`feedback` 发到 `POST /polish/translate`。
3. Host 过认证与方法检查，读请求体，按额度判定。
4. Host 一次只读观察拿到会话尾部上下文与会话记录的模型，解析出本次路由。
5. 有图片时先探这条路由的图片能力；不支持就回 `polish/no-vision`。
6. 图片经附件准入，得到适配器能读的引用；文本在前，图片在后。
7. Host 调 `ctx.llm.stream()`，把正文拼起来。
8. 解析 JSON：问题就回 `questions`，成品就回 `prompt`。
9. Client 按结果写下一状态：`clarifying`、`review` 或 `error`。

## 并发与配额

| 项 | 规则 |
| --- | --- |
| 同时进行的转写 | 每个会话最多一个。再次触发先 abort 旧请求再接管 |
| 追问预算 | 每次尝试 3 轮。`clarifying` 出现时扣一轮，重试归零，出错重试不归零 |
| 在途请求作废 | 响应回来时若状态对象已不是发起时那个，直接丢弃 |
| 切换会话 | 在途结果丢弃，不写进新会话的输入框 |
| 连接关闭 | Host 在 `res.on('close')` 且未回包时 abort，避免继续花 token |

## 结束条件

四种结束方式，之后浮层都不再渲染。

| 结束 | 触发 | 输入框 |
| --- | --- | --- |
| 采用 | 预览态点「采用」 | 整段替换成规范提示词 |
| 放弃 | 任意阶段点「放弃」或「✕」 | 不变 |
| 回答完并拿到成品 | 用户「采用」或「放弃」之后 | 见上两行 |
| 从未触发 | — | 不变 |

## 失败与恢复

### 执行失败

| 失败点 | 错误码 | 下一步 |
| --- | --- | --- |
| 粗糙文本为空 | `polish/empty-input` | 在浮层里的文本框补文本后点「转写」 |
| 三个模型来源都没有路由 | `polish/no-model` | 在输入框的模型选择器里选一个模型 |
| 会话当前模型不接受图片 | `polish/no-vision` | 换一个支持图片的模型，或移除图片 |
| 图片读不出或被准入拒绝 | `polish/bad-image` | 重新添加图片，或缩小它 |
| 模型返回不是可解析结构 | `polish/bad-output` | 点「转写」重试 |
| 模型报错、结束原因异常 | `polish/llm-error` | 点「转写」重试 |
| 超过 60 秒 | `polish/timeout` | 点「转写」重试 |
| HTTP 非 2xx 或 fetch 失败 | `polish/transport-error` | 点「转写」重试 |
| 问满 3 轮仍在追问 | `polish/round-limit` | 点「转写」，Host 会要求模型直接出稿 |

失败态的浮层里，原文是可编辑的文本框，改完点「转写」就从新文本重新开始。

### 重试

| 从哪重试 | 澄清记录 | 追问预算 | 图片 |
| --- | --- | --- | --- |
| 预览态「不满意，重试」 | 保留 | 归零 | 沿用 |
| 失败态「转写」 | 保留 | 保留 | 沿用 |
| 澄清态「继续」 | 追加一轮 | 保持已扣 | 沿用 |

### 中止

用户点「✕」、点「放弃」、或换会话时，Client abort 掉在途请求，Host 侧对应的 `fetch` 被取消，`res.on('close')` 触发 Host 自己的 abort。这条路径不展示错误，浮层直接消失。

### 图片在哪一轮发出

触发那一刻抓到的 `File` 在整次尝试里全程携带：澄清的每一轮、出错重试、不满意重试都重发同一批。每次发请求前重新编码，状态里不存 base64。

### 过期与丢弃

| 情况 | 处理 |
| --- | --- |
| 响应回来时状态对象已不是发起时那个 | 丢弃，不写状态 |
| 中途切换会话 | 丢弃在途结果，不写新会话的输入框 |
| 同一个会话再次触发 | 先 abort 旧请求，再接管 |
| 用户改动输入框 | 不影响本次转写：`source` 是触发时的快照 |
