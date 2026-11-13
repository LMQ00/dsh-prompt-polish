# 002 规则与权限

这份文档决定谁能发起一次转写、什么动作被允许、什么被拒绝。概念见 [001 领域模型](001-domain.md)，边界见 [000 原则](000-philosophy.md)。

## 谁可以发起

转写是一次真实的模型调用，要过三道闸：连接认证、方法、请求体。三道都在调模型之前。

| 闸 | 判据 | 不过时 |
| --- | --- | --- |
| 连接认证 | `ctx.connection.requestRejection({ headers })` 返回空 | 401 `unauthorized` 或 403 `forbidden`，不调模型 |
| 方法 | `req.method === 'POST'` | 405，带 `allow: POST` |
| 请求体 | 是合法 JSON 且不超过当前额度 | 400 或 413，`polish/bad-request` |

认证排在方法之前：`GET /polish/translate` 得 401。

## 两条路径

### 新工作怎么发起

| 入口 | 怎么触发 | 拿到的粗糙文本 | 图片 |
| --- | --- | --- | --- |
| 工具条按钮 | 点输入框右侧、模型选择器左边的按钮 | 当前草稿 | 直接读草稿的附件轨道 |
| `/polish <文本>` | 命令提交 | 参数文本 | 提交前记下的同一批 `File` |
| `/polish` | 命令 action decoration | 记下的含 `/polish` 的那一行 | action 里再读一次轨道 |

三条路都走同一个 `start`，区别只在文本与图片的来源。

### 已有工作怎么继续

| 动作 | 允许的前提 | 结果 |
| --- | --- | --- |
| 回答澄清 | 浮层在 `clarifying` | 追加一轮澄清记录，用同一批图片再转写一次 |
| 不满意，重试 | 浮层在 `review` | 追问预算归零，澄清记录保留，反馈进下一次请求 |
| 出错重试 | 浮层在 `error` | 追问预算与澄清记录都保留 |
| 采用 | 浮层在 `review` | 调一次 `setDraft`，回 `idle` |
| 放弃 | 浮层不在 `idle` | 中止在途请求，回 `idle` |

两条路径互不越权：`input` 态只能转写或关闭，不能采用；`review` 态不能改粗糙文本，要改就重试或采用后回输入框改。

## 强度表

| 动作 | 成立条件 | 代码位置 |
| --- | --- | --- |
| 追问上限 | 默认 3 轮，按**尝试**计；收到 `questions` 时 `rounds >= 3` 就转 `polish/round-limit` | `client.js` 的 `run` |
| 图片准入 | 只收 `image/png`、`image/jpeg`、`image/webp`、`image/gif`，且 `data` 非空 | `index.js` 的 `imageParts` |
| 请求体额度 | 默认 `64 KiB` + 本次图片的 base64 字节数，硬顶 300 MiB | `index.js` 的 `bodyCapFor` |
| 单次调用超时 | 默认 60 秒 | `index.js` 的 `TIMEOUT_MS` |
| 上下文长度 | 尾部最多 8 条消息、合计最多 6000 字符 | `index.js` 的 `MAX_CONTEXT_MESSAGES`、`MAX_CONTEXT_CHARS` |
| 输出长度 | 最多 4096 token | `index.js` 的 `MAX_OUTPUT_TOKENS` |

图片这一项分三段判：结构不可用（未知类型、空 `data`、非对象）在插件里就拒；过了结构的交给附件服务校验（base64 规范性、字节数、像素数、张数），它的拒绝保留原文；模型能力由会话当前模型声明决定。

## 准入表

按接收范围分行，取值来自封闭集合。

| 接收范围 | 接受 | 拒绝 | 默认 |
| --- | --- | --- | --- |
| 图片类型 | `image/png` · `image/jpeg` · `image/webp` · `image/gif` | 其它任何 MIME | 白名单外视为不可读 |
| 模型图片能力 | `inputModalities` 含 `image` | 声明了但不含 `image`，或没有声明 `inputModalities` | 缺声明按不支持 |
| 能力查询失败 | — | — | 放行，由适配器裁决 |
| 会话模型来源 | live Agent · 会话记录的 `modelSelection` · 部署默认 | 三者都拿不到 | 前两个优先，部署默认兜底 |
| 多选标记 | `multi` · `multiSelect` | 两者都没有 | 单选 |
| 输出结构 | `{kind:'questions'}` · `{kind:'prompt'}` | 其余任何结构 | 报 `polish/bad-output` |

## 只读约束

Host 侧对会话、对模型都只读。

| 对象 | 允许 | 不允许 |
| --- | --- | --- |
| 会话 | `observeSession` 读事件与投影 | 追加事件、写回、改历史 |
| 模型 | `model.current()`、`currentSelection()` 读 | `model.select()`、`saveSelection()` |
| 文件系统 | 无 | 任何 fs 写接口 |

`agents` 用 `ctx.get('agents')` 软取，不进 `inject`：没挂 agent registry 的部署必须仍能加载本插件。

## 规则改动时

| 规则 | 改动后 |
| --- | --- |
| 追问上限 | 代码常量，改了要重启 dsh。在途请求按旧值走完 |
| 图片白名单 | 改了要重启 dsh。已经发出的请求按旧白名单判完 |
| 额度与超时 | 同上 |
| 转写提示词 | 代码常量，改了要重启 dsh |

插件不声明 Config，所以没有「热更新」这条路径；所有可调项都是 `index.js` 里的常量，生效点在进程启动。

## 不完成时

| 情况 | 状态 | 谁处理 | 界面怎么区分 |
| --- | --- | --- | --- |
| 粗糙文本为空 | `error` + `polish/empty-input` | 用户补文本 | 显示原因，下面是可以改的文本框 |
| 没有可用模型 | `error` + `polish/no-model` | 用户在模型选择器里选一个 | 同上，可重试 |
| 模型不支持图片 | `error` + `polish/no-vision` | 用户换模型或移除图片 | 同上，文案带模型名 |
| 图片读不出 | `error` + `polish/bad-image` | 用户重新添加 | 同上，不静默丢图 |
| 模型返回不可解析 | `error` + `polish/bad-output` | 用户重试 | 同上 |
| 模型报错 | `error` + `polish/llm-error` | 用户重试 | 同上，文案用模型给的原因 |
| 超时 | `error` + `polish/timeout` | 用户重试 | 同上，文案写秒数 |
| 用户关掉浮层 | `polish/aborted`，静默 | — | 浮层已关闭，不展示 |
| 问满 3 轮仍在追问 | `error` + `polish/round-limit` | 用户重试，Host 会让模型直接出稿 | 同上 |

任何错误都不清空用户已输入的粗糙文本。
