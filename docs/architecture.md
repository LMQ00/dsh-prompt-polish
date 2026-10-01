# 架构

> 状态：设计已定，代码待实现。所有「已核实」条目来自读 DSH `0.2.0-rc.2` 的契约与打包产物，不是推测。

## 一句话

用户触发 `/polish` 或输入框工具条按钮 → Client 取粗糙文本 → 经调用桥交给 Host → Host 用 `ctx.llm` 转写（必要时先追问）→ 结果回到 Client 的浮层 → 用户「采用」→ Client 调 `setDraft` 写入输入框。

## 目录结构

源码放仓库根目录（规则 D6）；整个仓库根目录就是可安装 bundle，`plugin_manager install_bundle` 的 target 即 `/home/LMQ/github/提示词`。

```
/home/LMQ/github/提示词/
├── AGENTS.md          # 文档索引 + 开发规范规则
├── package.json       # bundle 清单
├── cordis.patch.yml   # 插件行 + Config
├── index.js           # Host 半边
├── client.js          # Client 半边
├── docs/
└── tmp/               # 临时文件（规则 D1）
```

## 为什么必须是两半

命令 handler 运行在 **Host**，拿不到浏览器的输入框；`setDraft` 只在 **Client** 的 session 作用域 slot 组件里可用。所以「取草稿」和「写输入框」只能在 Client，而「调 `ctx.llm`」和「注册命令」只能在 Host。中间必须有一条调用桥。

## 模块职责

### Host（`index.js`）

- `inject = ['commands', 'llm', 'agentDefaultModel', 'connection', 'webServer']`。`webServer` 是 `connection.rpc.handle` 的硬要求（见下）。
- 注册 `/polish` 命令，声明 `input.hint`，`recordInput: false`，handler 只返回 `{kind:'success'}`（**不返回任何文本**）——命令仅用于让 `/polish` 在 `/` 菜单里可见，并给 Client 一个可靠的触发信号。
- 提供转写：组装提示词 → `ctx.llm` 调用 → 解析模型返回（追问 / 出稿）→ 经 RPC 回给调用方。
- 模型来源：`ctx.agentDefaultModel.currentSelection()`（v1 无 Config，见 [api.md](api.md)）。
- **不注入** `agentLoop`、不追加任何会话事件、不调用任何 fs 写接口（产品边界，见 [decisions.md](decisions.md)）。

### Client（`client.js`）

- 在 `conversation.input.right` 注册触发按钮。已核实：该 slot 在 `client.js:17532` 渲染于 `conversation.input.model` **之前**，即模型选择器左侧，与用户圈定位置一致。
- 在 `conversation.input.dock` 注册浮层。已核实：该 slot 在 `client.js:16309` 渲染于 `inputBar`（输入框卡片）**之前**，即输入框正上方，与用户要求一致。
- 取粗糙文本：
  - 点按钮 → 当前草稿（`useInput(s => s.draft)`）；
  - 打 `/polish` → 监听 `command/executed(sessionId, name, result)`；粗糙文本来自按钮组件在草稿变化时记下的、含 `/polish` 的最近一行（命令提交会把草稿清空，所以只能在清空前记）。命令 token 可能在行首也可能在行尾，用 `stripCommand` 去掉它，其余原样保留。
- 「采用」时调 `inputActions.setDraft(text)`，然后关闭浮层。**代码里不出现 `submit`**。
- 样式只用 DSH 主题 token，保证深色/浅色主题都成立。

## 调用桥

**已定：Connection 的通用 RPC 通道。**

- Host：`ctx.connection.rpc.handle('/polish', handler)`，端点 `translate`。
- Client：`ctx.connection.rpc.call('/polish', 'translate', payload, signal)`。

为什么是它：

- 它是 Host 与 Client 之间唯一不需要代码生成的通用调用路径（`ctx.remote.*` 命名空间需要 Typert 生成产物，本仓库是普通 JS、无构建步骤）。
- 请求与响应走 HTTP，**不落会话日志**，符合产品边界。
- 代价：`rpc.handle` 把物理路由挂在**读取该服务的 Context 自己的 `webServer`** 上，所以 Host 半边的 `inject` 必须包含 `webServer`，否则注册直接抛 `cannot get property "webServer" without inject`（实测踩过）。

约束：

- 桥只承载「请求转写」与「返回结果」两类消息，不做流式渲染。
- 在途请求的作废靠 **AbortController + 状态对象身份比较**（响应回来时若 `readState(sessionId)` 已不是发起时那个对象，直接丢弃），不额外造请求 id。
- 浮层中途切换会话：丢弃在途结果，不写进新会话的输入框。

## 数据流（时序）

```
Client 浮层/按钮
  └─ 取粗糙文本（草稿，或从含 /polish 的最近一行里 stripCommand）
      └─ 桥 → Host: call('/polish', 'translate', { text, transcript, feedback })
          └─ 组装提示词 → ctx.llm（不带 sessionId、不带 purpose）
              ├─ 模型要澄清 → { kind:'questions', questions[] } → 浮层渲染选项
              │     └─ 用户回答 → transcript 追加一轮 → 桥再调一次（≤3 轮）
              └─ 模型给稿 → { kind:'prompt', prompt, assumptions[] }
                  └─ 浮层只读展示 → 采用 / 带反馈重试 / 放弃
                      ├─ 采用 → inputActions.setDraft(prompt) → 关闭
                      ├─ 重试 → 带 feedback 重新请求（feedback 必填）
                      └─ 放弃 → 关闭，不改输入框
```

## 不变量

1. 浮层是唯一的输出展示面：结果不进对话流、不进会话历史。
2. 输入框只在「采用」时被写一次，且是整段替换。
3. 任何失败都不清空用户已输入的粗糙文本。
4. 插件运行期不写任何文件。
