# 008 手册

这份手册教在这个插件里加一种新东西：一个新的错误码、一种新的图片类型、一种新的浮层状态、换一个转写模型来源。它用 [001 领域模型](001-domain.md) 的词、[002 规则与权限](002-rules.md) 的准入表、[003 生命周期](003-lifecycle.md) 的阶段和 [007 架构](007-architecture.md) 的模块划分。

每种新东西都贯穿两侧：Host 或 Client 的代码、文档、测试。只改一侧，另一侧会静默失效。

## 加一个错误码

### 1. 在出错的地方抛

Host 抛带 `code` 的 `Error`，由 `failureOf` 包成 `{ ok:false, error }`；也可以在 `handleHttp` 里直接返回 `failure(...)`。

```js
const error = new Error('模型返回的规范提示词里出现了未替换的占位符');
error.code = 'polish/placeholder';
throw error;
```

- **`message` 就是浮层上显示的那句话。** Client 不按 `code` 查文案表，它渲染 `state.message`。这句话要写成用户读得懂的原因与下一步。
- **`code` 只给人和测试看。** 它是稳定标识，用于断言与排障；改文案不必改 `code`。
- **Client 侧的错误要同时写 `code` 与 `message`。** `writeState(sessionId, { ...state, phase:'error', code, message })`，漏写 `message` 浮层会是空的。

### 2. 补三处文档

| 文档 | 补什么 |
| --- | --- |
| [001 领域模型](001-domain.md) §枚举值 | 错误码列表里加一条：`code` · 一句中文 |
| [002 规则与权限](002-rules.md) §不完成时 | 状态表的行：情况、状态、谁处理、界面怎么区分 |
| [006 部署](006-deployment.md) §排障 | 现象列抄**真实文案**（带反引号），原因与修法一句 |

### 3. 写测试

`test/host.test.js` 里的假 ctx 由 `createHost({ respond })` 构造，`translate(host, payload)` 会调真实注册的路由并返回解析后的信封：

```js
test('errors: a placeholder left in the prompt maps to polish/placeholder', async () => {
	const host = createHost({ respond: () => textChunks('{"kind":"prompt","prompt":"写到 {{变量}} 里"}') });
	const result = await translate(host, { text: '帮我写个登录页' });
	assert.equal(result.ok, false);
	assert.equal(result.error.code, 'polish/placeholder');
});
```

至少要覆盖：

- 触发条件成立时 `error.code` 是新的码。
- 触发条件不成立时不会误报。
- 如果是 Client 侧判定的，`test/client.test.js` 里断言 `internals.readState(SESSION).code`。

## 支持一种新的图片类型

图片类型是插件与上游共享的白名单：插件只过滤结构，附件服务与模型适配器才是真正的闸门。

### 1. 两侧白名单一起改

`index.js`：

```js
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']);
```

`client.js`：

```js
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']);
```

- **两处必须一致。** Host 的白名单决定什么能过结构过滤，Client 的白名单决定什么会被采集；只改一侧的效果是「输入框里有图，转写时说没有图」。
- **先确认宿主认这个类型。** 附件准入与模型适配器各自有自己的类型集合。它们不认的类型，插件放行后仍会在准入或适配器处失败，用户看到的是 `polish/bad-image` 或 `polish/llm-error`。
- **模型能力仍需声明。** 新类型不改变 `inputModalities` 的判定：模型没声明 `image` 输入时照样报 `polish/no-vision`。

### 2. 补文档

| 文档 | 补什么 |
| --- | --- |
| [002 规则与权限](002-rules.md) §准入表 | 图片类型那一行的「接受」列 |

### 3. 写测试

```js
test('images: the new media type passes the structural filter', async () => {
	const host = createHost({ respond: () => textChunks('{"kind":"prompt","prompt":"ok","assumptions":[]}') });
	const result = await translate(host, {
		text: '看图写前端',
		images: [{ mediaType: 'image/avif', data: 'AAAA' }],
	});
	assert.equal(result.ok, true);
	assert.equal(host.admissions.length, 1);
});
```

至少要覆盖：

- 新类型能过结构过滤并到达准入。
- 一个仍未支持的类型依旧报 `polish/bad-image`。
- Client 侧采集函数把新类型收进来：`internals.imageDraftsOf([...])`。

## 加一种浮层状态

浮层状态是 Client 的事，Host 完全不知道它。

### 1. 定状态与迁移

在 `client.js` 里找一个现有状态的写入点照抄形状。每个状态至少要能回答：谁写它、从哪些状态进来、能去哪些状态。

```js
function startPickModel(ctx, sessionId) {
	const previous = readState(sessionId);
	if (previous.controller !== undefined) previous.controller.abort();
	writeState(sessionId, { phase: 'pick-model', source: previous.source ?? '', controller: new AbortController() });
}
```

- **状态对象整体替换。** 不要就地改字段：响应回来时靠对象身份判断是否过期。
- **带上 `controller`。** 进入一个会发请求的状态就要新建 `AbortController`；漏了的话用户点「✕」时请求还活着。
- **`imageFiles` 要接着传。** 图片在整次尝试里全程携带，漏传等于静默丢图。

### 2. 让浮层渲染它

`PolishOverlay` 里加一个分支，并在 `heading` 里给出标题：

```js
} else if (state.phase === 'pick-model') {
	body.push(h('div', { key: 'hint', className: 'polish-hint' }, '选一个能看图的模型'));
	body.push(h('div', { key: 'actions', className: 'polish-foot' }, [
		h(Action, { key: 'close', label: '关闭', onClick: () => dismiss(sessionId) }),
	]));
}
```

- **`heading` 的三元链要补一层。** 漏了会落到最后的 `规范提示词 · 未完成`，用户以为是出错了。
- **触发按钮的 `disabled` 判定要复查。** 现在是 `phase !== 'idle' && phase !== 'error'`，新状态默认会置灰按钮；要允许重新发起就在那里放开。

### 3. 补三张表

| 文档 | 补什么 |
| --- | --- |
| [001 领域模型](001-domain.md) §枚举值 | 浮层状态列表 |
| [003 生命周期](003-lifecycle.md) §阶段 | 阶段表的行：阶段、成立条件、界面文字 |
| [005 界面](005-interface.md) §浮层各阶段 | 标题、显示什么、底部按钮 |

### 4. 写测试

`test/client.test.js` 的 `internals` 是模块级常量，`seed(state)` 直接写一个状态，`createFetchControl()` 拦下网络：

```js
test('state machine: picking a model sends nothing', () => {
	const control = createFetchControl();
	try {
		internals.startPickModel({}, SESSION);
		assert.equal(internals.readState(SESSION).phase, 'pick-model');
		assert.equal(control.calls.length, 0);
	} finally {
		control.restore();
	}
});
```

纯状态机函数用 `{}` 当 ctx 就够；需要读 composer 快照的函数（`composerDraft`、`composerImageFiles`、`restoreDraftImages`）要传 `installClient({ conversation, sessions })` 造出来的假 ctx。新函数要被测试够得着，就加进工厂返回的 `__internals` 对象。

至少要覆盖：

- 新状态的进入与离开各一条迁移。
- 新状态不发请求（或发请求时断言请求体）。
- 新状态下 `dismiss` 能回 `idle`。
- 旧状态的行为没被改动（跑一遍现有用例即可）。

## 换转写模型来源

模型来源只有一处：`index.js` 的 `resolveSelection`。改它就是在改「转写跑在哪个模型上」。

```js
function resolveSelection(ctx, sessionId, recorded) {
	return liveSelection(ctx, sessionId) ?? recorded ?? usableSelection(ctx.agentDefaultModel.currentSelection());
}
```

- **每个来源都要过 `usableSelection`。** 投影是持久化 JSON，Agent 的 options 可能带空字符串；缺一半的来源不是路由，要落到下一个。
- **只取 `provider` 与 `model`。** `reasoningEffort` 不透传：未声明推理等级的路由会被 `dsh-llm` 以 `UNSUPPORTED_REASONING_EFFORT` 直接拒绝。
- **保持只读。** 不调 `model.select()`、不调 `saveSelection()`、不追加会话事件。
- **判定与派发必须同源。** 图片能力探测和 `ctx.llm.stream` 用同一个 selection，否则会出现「判定说不能看图、实际要调的是能看图的模型」这类误报。

改完补测试：`test/host.test.js` 的 `model:` 前缀下有用例，`createHost({ agents })` 提供 live Agent，`createHost({ observation })` 提供记录值。至少要新增优先级、坏形状降级、全空报 `polish/no-model` 各一条。

## 注册

加完代码，四件事缺一不可：

| 事 | 位置 | 说明 |
| --- | --- | --- |
| 构建入口 | 无 | 没有构建步骤。源码就是可加载的 ESM |
| 导出 | `package.json` 的 `exports` 与 `dsh` | `exports` 给模块解析，`dsh.bundle.patch` 指向 `cordis.patch.yml`，`dsh.client.platform` 声明浏览器半边 |
| 配置文件 | `cordis.patch.yml` | 只有一行 Host 注册。加 Config 才会动它，而本插件不声明 Config |
| 重启 | `plugin_manager action=install_bundle` + 重启 dsh + 硬刷新页面 | `index.js` 被 ESM 缓存，重装 bundle 不会换模块 |

只改 `client.js` 时不需要 `install_bundle`，硬刷新页面即可。

## 测试

先跑一遍现有基线：

```bash
npm test          # = node --test，自动发现 test/*.test.js
```

基线是 103 项全绿。新加了东西之后，这个数字只会变大；变小说明有用例被删或没被收集到。

### 两个文件怎么搭的

`test/host.test.js` 用 `createHost(options)` 造一个只有七个 Service 的假 ctx，调 `apply(ctx)`，再经 `callRoute` / `translate` 调真实注册出来的 HTTP handler。假 ctx 里没有 `agentLoop`、没有文件系统，所以越界会当场失败。

`test/client.test.js` 先装 `globalThis.window.__ModuleLoader__`，动态 import `client.js` 抓住注册对象，用一个只有 `createElement` 的 React 替身调工厂，再从 `__internals` 取纯函数。`createFetchControl()` 换掉 `globalThis.fetch`，手动决定每个请求何时返回。

### 一个新错误码至少要覆盖

- 触发时 `error.code` 是新的码。
- 不触发时不会误报。
- 已有文本没被清空。

### 一个新状态至少要覆盖

- 进入与离开，各一条。
- 不该发请求的时候确实一个请求都没发。
- `dismiss` 能回 `idle`。

### 一种新图片类型至少要覆盖

- 新类型过结构过滤并到达准入。
- 仍未支持的类型报 `polish/bad-image`。
- 纯文本请求不碰附件服务。

## 检查清单

1. 在出错或改变状态的地方写新代码。
2. 两侧白名单或状态分支一起改，别只改一侧。
3. 补 [001 领域模型](001-domain.md) 的枚举值。
4. 补 [002 规则与权限](002-rules.md) 的准入表或不完成时表。
5. 补 [003 生命周期](003-lifecycle.md) 的阶段表。
6. 补 [005 界面](005-interface.md) 的浮层各阶段表。
7. 补 [006 部署](006-deployment.md) 的排障表，左列抄真实文案。
8. 在 `test/host.test.js` 或 `test/client.test.js` 里加用例。
9. `npm test` 全绿，用例数只增不减。
10. `install_bundle` + 重启 dsh + 硬刷新页面，在真实 GUI 上走一遍。
