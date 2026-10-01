# 测试

> 状态：**自动化测试已实现并全绿**（59 项）。盲读测试仍未执行。

## 框架与运行

| 项 | 值 |
| --- | --- |
| 框架 | Node 内置 `node:test` + `node:assert/strict` |
| 运行 | `npm test`（即 `node --test`，自动发现 `test/*.test.js`） |
| 依赖 | **零**。项目无依赖、无构建，引入 jest/vitest 会为一个 bundle 包增加安装面与锁文件，不值得 |
| 文件 | `test/host.test.js`（Host 半边，33 项）、`test/client.test.js`（Client 半边，26 项） |

## 测试缝：Client 怎么被测试

`client.js` 是浏览器产物：它把工厂注册给 `window.__ModuleLoader__`，不导出 ES 绑定。`test/client.test.js` 因此：

1. 先装上 `globalThis.window.__ModuleLoader__`，再动态 `import('../client.js')`，捕获注册对象；
2. 用一个 React 替身调用工厂（工厂在模块作用域只需要 `React.createElement`）；
3. 通过工厂返回的 **`__internals`** 拿到纯状态机与序列化函数。

`__internals` 是**刻意的测试缝**，运行中的应用不读它。之所以需要它：浏览器模块加载器只交出这个工厂，纯函数没有第二条可达路径。

Host 半边不需要缝：`test/host.test.js` 用假 ctx 调 `apply(ctx)`，然后直接调**真实注册出来的 HTTP handler**，断言的是 Client 实际说话的契约，而不是私有函数。

## 覆盖清单

### 1. 命令解析

| 用例 | 断言 |
| --- | --- |
| token 在行首 / 行尾 | 两种位置都能剥掉，其余原样保留 |
| 只有命令、没有内容 | 剥完为空串 |
| 多行 + 首尾空白 | 只 trim 首尾，多行结构不变 |
| 不含命令 | 原样返回 |
| 出现两次 | 只剥第一个 |
| 非字符串输入 | 返回空串 |

Host 侧另测命令定义：`name`、`recordInput: false`、`input.hint`、handler 返回 `{kind:'success'}` 且 **`text` 为 undefined**（保证规范版不进会话日志）。

### 2. 状态机迁移

覆盖 [data-model.md](data-model.md) 迁移表的每一行：

| 用例 | 断言 |
| --- | --- |
| 有文本触发 | → `drafting`，请求体为 `{sessionId, text, transcript:[], feedback:''}` |
| 无文本触发 | → `input`，**一次模型调用都不发** |
| 模型要澄清 | → `clarifying`，带 questions |
| 用户回答 | → `drafting`，transcript 追加一轮，请求体带上 |
| 出稿 | → `review`，带 prompt 与 assumptions |
| 不满意重试 | → `drafting`，feedback 进请求体，transcript 保留 |
| 出错后重试 | → `drafting`，**已问到的澄清轮次不丢** |
| 追问上限 | 第 3 轮之后模型仍追问 → `error` + `polish/round-limit`（**代码强制**） |
| 预算与记录分离 | 「不满意重试」后 `rounds` 归零、`transcript` 保留，模型可再问；出错重试两者都保留 |
| 预算上报 | 每次请求体都带 `rounds`；Host 依它决定是否写「问满轮次」指令，缺省回退 `transcript.length` |
| 过期响应 | 旧请求后到 → 丢弃，不覆盖新状态 |
| 放弃 | 中止在途请求（`AbortController.signal.aborted === true`）并回 `idle` |
| 中止后 fetch 再 reject | 状态对象**身份不变**（不被改写成 error） |

### 3. 序列化

| 用例 | 断言 |
| --- | --- |
| 多选标记 | `multi` 与 `multiSelect` 两种拼写都认；缺失为单选 |
| 选项 + 自由填 | 用 `、` 连接；自由填先 trim |
| 只有自由填 / 全空 / undefined | 分别得到文本、空串、空串 |

### 4. 错误码映射

Host（经真实 HTTP handler 断言 `error.code`）：

| 触发 | code |
| --- | --- |
| 空文本 | `polish/empty-input` |
| 无默认模型 | `polish/no-model` |
| 输出无 JSON 对象 / JSON 不可解析 / questions 为空 / prompt 为空 / 结构不认识 | `polish/bad-output` |
| 无 finish 标记 / finish 为 `error`·`aborted`·`max-tokens`·未知 | `polish/llm-error` |
| 抛 `TimeoutError` | `polish/timeout` |
| 连接中途关闭（`res` 发 `close`） | `polish/aborted` |
| 请求体超 64 KiB / 非 JSON | `polish/bad-request`（HTTP 413 / 400） |

Client：HTTP 非 2xx → `polish/transport-error`（带状态码）；业务失败原样保留 Host 的 code/message；结构不认识 → `polish/bad-output`；fetch reject → `polish/transport-error`。

### 5. `setDraft` 只写不提交

| 用例 | 断言 |
| --- | --- |
| 采用 | `setDraft` **恰好被调一次**，参数为规范版；spy 的 `submit` **零调用** |
| 非 review 态采用 | 一次都不调 |
| 源码级不变量 | `client.js` 必须含 `.setDraft(`，且**不得出现 `.submit(`** |

### 另外覆盖（同属验收范围）

- **HTTP 契约**：401/403 拒绝（且不调模型）、非 POST 405、超限 413、非 JSON 400、空 body 等价空 payload、成功时 content-type 正确。
- **提示词组装**：粗糙文本、四硬清单四项、语言约束、Q/A 渲染、未回答渲染、问满轮次的指令。
- **上下文读取**：只取 user/assistant 的 text 块（忽略 image 与 tool 事件）、观察租约被释放、尾部 8 条、超长从头截断、读取失败降级为无上下文、无 `sessionId` 时不发起读取、**模型调用不带 `sessionId`/`purpose`**。
- **边界**：假 ctx 只提供被注入的六个 Service + `effect`，完整请求仍成功（触及 `agentLoop`/fs 就会失败）；源码不得出现 fs 写接口。

## 变异验证（证明测试不是空转）

| 变异 | 结果 |
| --- | --- |
| `recordInput: false` → `true` | 1 项失败 ✓ |
| `adopt` 里 `setDraft` → `submit` | 2 项失败（行为 + 源码）✓ |
| 追问上限判断 `>= MAX_ROUNDS` → 实际失效 | 1 项失败 ✓ |

## 未覆盖 / 已知缺口

诚实列出，避免「全绿」被误读为「全覆盖」：

- **盲读测试仍未执行**（人工，见下）。自动化测试不能证明转写质量好。
- **浮层的真实渲染、样式、深色主题未测**：没有浏览器控制，也不允许引入 DOM 模拟或自定义渲染器。这部分只能靠真实 GUI 人工看。
- **「不落盘」是间接断言**（假 ctx 无 fs + 源码正则），没有运行期拦截。
- **「切换会话丢弃在途请求」未直接测**：状态按 `sessionId` 分键，切会话只是读另一个键；已测等价性质「过期响应被丢弃」。
- **Host 侧追问上限仍只是提示词请求**（`userPrompt` 依据 Client 报来的 `rounds` 告诉模型别再问）；硬拦截只在 Client。若模型在 Host 侧被其它入口直接调用，没有第二道闸。
- **预算只在内存**：`rounds` 不落盘，刷新页面后按 0 重算（与「不进会话历史」一致）。
- **未测 HMR / 插件卸载路径**（样式表与槽位的回收）。

## 盲读测试（人工验收）

目的：验证生成的规范提示词**脱离上下文仍能被理解**。

步骤：

1. 准备 3 类粗糙输入：写代码 / 写文案 / 分析数据，各一句到一段。
2. 对每条：触发 `/polish`，走完追问（若有），在 `review` 态复制规范提示词全文。
3. **新开一个会话**（或换一个 AI），只粘贴这一段，不带任何补充说明。
4. 判定：
   - 对方直接开工，或只问它确实无法自行决定的问题 → **通过**
   - 对方反问「你到底想要什么 / 给谁用 / 输出成什么形式」这类规范版本可以写清的东西 → **不通过**
5. 3 条全通过才算通过；失败条目记录原文与反问内容，用于改提示词。

记录位置：结果与失败样本写进本文件下方的「盲读测试记录」。

## 盲读测试记录

（尚未执行。）
