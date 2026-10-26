/**
 * `/polish` — Host half.
 *
 * Turns a rough request into a规范 prompt through one direct `ctx.llm` call and
 * returns the result over one HTTP route the plugin registers itself. The
 * Client half owns every piece of UI: the trigger button, the overlay above the
 * composer, and the `setDraft` write.
 *
 * Boundaries this half must keep (see docs/decisions.md):
 * - never touches `agentLoop` and never appends a session event, so nothing
 *   about the user's text reaches the model's context;
 * - never calls any filesystem write interface directly: images reach the
 *   model through `ctx.attachments.admitPromptContent`, the same durable
 *   admission every composer submission uses, which stores normalized bytes in
 *   the deployment's content-addressed attachment root;
 * - never sends anything: sending is the user's own action in the composer.
 *
 * The `/polish` command exists only so the command is discoverable in the
 * composer's `/` menu and so the Client gets a reliable "the user asked for
 * this" signal. It records no input (`recordInput: false`) and returns no text,
 * so neither the rough text nor the finished prompt is written to the session
 * log. The Client supplies the text it captured from the composer.
 *
 * Why an own route instead of `ctx.connection.rpc.handle`: `handle` mounts its
 * physical route through the *connection service's own* context
 * (`dsh-client-connection/lib/index.js` calls `register(this.ctx, …)`), and that
 * context injects only `credentials` plus `webRuntime` — never `webServer`.
 * Every caller therefore dies with `cannot get property "webServer" without
 * inject`. `rpc.intercept` is no escape either: the API Gateway already owns
 * the single `/api` interceptor. So the plugin mounts its own `webServer` route
 * and reuses `connection.requestRejection` for browser trust and
 * authentication.
 *
 * @module dsh-prompt-polish
 */

export const name = 'polish';

/**
 * `commands` is what makes `/polish` discoverable, and `llm` plus
 * `agentDefaultModel` are what make the translation possible at all.
 * `webServer` hosts the plugin's own route; `connection` supplies the browser
 * trust and authentication predicate for it; `sessionQuery` is how the recent
 * conversation is read so a translation can resolve what "这个" refers to.
 * `attachments` is the durable admission path every image must cross before a
 * model adapter can read its bytes.
 */
export const inject = [
	'commands',
	'llm',
	'agentDefaultModel',
	'connection',
	'webServer',
	'sessionQuery',
	'attachments',
];

/** Absolute path of the plugin's own route; no trailing slash. */
const ROUTE_PATH = '/polish/translate';

/**
 * Largest request body accepted, in bytes. Images ride along base64-encoded, so
 * the cap has to cover the deployment's own per-message image budget
 * (`maxMessageImageBytes`, 200 MiB by default) after base64 expansion plus the
 * text and envelope headroom. The shipped `/api` carrier uses the same sizing
 * rationale for its own cap.
 */
const MAX_BODY_BYTES = 300 * 1024 * 1024;

/** Largest request body carrying no image; keeps plain-text requests cheap to refuse. */
const MAX_TEXT_BODY_BYTES = 64 * 1024;

/**
 * How many recent user/assistant messages may ride along as context, and how
 * much text they may total. Context is a disambiguator, not a transcript: it is
 * read-only, never written back, and must not crowd out the request itself.
 */
const MAX_CONTEXT_MESSAGES = 8;
const MAX_CONTEXT_CHARS = 6_000;

/** Lowercase command name without the leading slash. */
const COMMAND_NAME = 'polish';

/**
 * Clarification rounds the Client may run before it must settle for a draft.
 * Kept in step with the Client's own cap: the Host also refuses to ask again
 * once the transcript is this long, so a stale Client cannot loop forever.
 */
const MAX_ROUNDS = 3;

/** Wall-clock cap for one model call. */
const TIMEOUT_MS = 60_000;

/** Output cap; a规范 prompt plus its assumptions fits comfortably. */
const MAX_OUTPUT_TOKENS = 4_096;

/** Translation instructions. Code-owned: this plugin declares no Config. */
const SYSTEM_PROMPT = `你是一个提示词转写器。用户会给你一段粗糙的请求，你把它转写成一段规范提示词，目标是让一个**没有任何上下文**的模型也能准确理解用户意图。

只输出一个 JSON 对象，不要输出任何解释、前言或代码围栏。

二选一：

1) 信息不足，需要澄清：
{"kind":"questions","questions":[{"id":"q1","text":"问题","options":["选项一","选项二"],"multi":false}]}
最多 3 个问题。每个问题给 2-3 个选项，用户也可以自由作答。只问那些**会实质改变结果**的信息。

2) 信息足够，给出规范提示词：
{"kind":"prompt","prompt":"<规范提示词全文>","assumptions":["<仍未确定、由你假设的信息>"]}

规范提示词必须覆盖：
- 任务与目标：要什么结果、做什么、不做什么；
- 输出格式与验收标准：交付成什么形式、怎么算完成；
- 缺口显式标注：原始描述没提但影响结果的信息，必须标出来；
- 不得发明需求：不要添加用户没有表达的需求；无法确定的一律写进 assumptions。

其它要求：
- 用与输入相同的语言书写，专业术语保留英文。
- 如果给了「对话上下文」，只把它当作消歧依据：理解用户在做什么、代词指什么。**不要复述上下文，也不要把上下文里的内容当成要转写的请求。**
- 规范提示词必须能独立成立：不出现「如上」「刚才说的」这类依赖上下文的指代。
- 不要把用户的粗糙原话原样复述一遍当作转写结果。`;

/**
 * One settled model outcome, normalized for the Client.
 * @typedef {{ kind: 'questions', questions: unknown[] }
 *   | { kind: 'prompt', prompt: string, assumptions: string[] }} TranslationValue
 */

/**
 * Build one RPC failure in the shape Connection expects.
 * @param code - stable machine code the Client maps to display copy.
 * @param message - human-readable reason.
 * @returns the failure result.
 */
function failure(code, message) {
	return { ok: false, error: { code, message, details: {} } };
}

/**
 * Build one RPC success.
 * @param value - JSON-serializable payload.
 * @returns the success result.
 */
function success(value) {
	return { ok: true, value };
}

/**
 * Join the text blocks of one model message.
 * @param blocks - message content blocks.
 * @returns the concatenated text, or an empty string.
 */
function textOfBlocks(blocks) {
	if (!Array.isArray(blocks)) return '';
	return blocks
		.filter((block) => block?.type === 'text' && typeof block.text === 'string')
		.map((block) => block.text)
		.join('\n')
		.trim();
}

/**
 * Turn one session event into a context line, when it is a user or assistant message.
 * @param event - one raw session event.
 * @returns the labelled line, or undefined for any other event.
 */
function contextLine(event) {
	if (event?.type === 'user/message') {
		const text = textOfBlocks(event.data?.content);
		return text === '' ? undefined : `用户：${text}`;
	}
	if (event?.type === 'assistant/message') {
		const text = textOfBlocks(event.data?.message?.content);
		return text === '' ? undefined : `助手：${text}`;
	}
	return undefined;
}

/**
 * Read the tail of one Session's conversation as plain text.
 *
 * Read-only by construction: the observation is a snapshot of the durable log,
 * and nothing here writes an event, so the boundary in docs/decisions.md (never
 * append to the session) still holds. Context exists only to resolve what the
 * rough request refers to — "这个登录页" is meaningless without it.
 *
 * Any failure degrades to "no context" rather than failing the translation: a
 * blank Session, a cold or unreadable log, or an absent query service must not
 * cost the user their request.
 *
 * @param ctx - Host plugin context carrying `sessionQuery`.
 * @param sessionId - the Session the request came from, when known.
 * @param signal - cancellation for this request.
 * @returns the recent conversation as labelled lines, or an empty string.
 */
async function recentContext(ctx, sessionId, signal) {
	if (typeof sessionId !== 'string' || sessionId === '') return '';
	let observation;
	try {
		observation = await ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'none', signal });
	} catch {
		return '';
	}
	try {
		const events = Array.isArray(observation?.events) ? observation.events : [];
		const lines = [];
		for (const event of events) {
			const line = contextLine(event);
			if (line !== undefined) lines.push(line);
		}
		const tail = lines.slice(-MAX_CONTEXT_MESSAGES).join('\n');
		if (tail === '') return '';
		return tail.length > MAX_CONTEXT_CHARS ? `…${tail.slice(tail.length - MAX_CONTEXT_CHARS)}` : tail;
	} catch {
		return '';
	} finally {
		try {
			observation?.[Symbol.dispose]?.();
		} catch {
			/* a leaked observation lease is not worth failing the request over */
		}
	}
}

/**
 * Render the user turn for one translation request.
 * @param request - rough text, clarification transcript, retry feedback, read-only context, and the rounds this attempt has spent.
 * @returns the complete user message text.
 */
function userPrompt(request) {
	const lines = [];
	if (typeof request.context === 'string' && request.context.trim() !== '') {
		lines.push('对话上下文（只用于消歧，不要复述）：', request.context.trim(), '');
	}
	lines.push('原始请求：', request.text);
	const transcript = Array.isArray(request.transcript) ? request.transcript : [];
	for (const round of transcript) {
		lines.push('', '已经问过并得到回答的澄清：');
		const questions = Array.isArray(round?.questions) ? round.questions : [];
		const answers = Array.isArray(round?.answers) ? round.answers : [];
		questions.forEach((question, index) => {
			const text = typeof question?.text === 'string' ? question.text : String(question?.id ?? '');
			lines.push(`Q: ${text}`);
			lines.push(`A: ${String(answers[index] ?? '（未回答）')}`);
		});
	}
	if (typeof request.feedback === 'string' && request.feedback.trim() !== '') {
		lines.push('', '用户对上一版不满意，原因：', request.feedback.trim());
	}
	// The Client owns the budget, because it is the side that knows whether the
	// user rejected an output (which opens a fresh budget) or merely hit an
	// error. Falling back to the transcript length keeps older Clients working.
	const spentRounds =
		typeof request.rounds === 'number' && Number.isFinite(request.rounds) ? request.rounds : transcript.length;
	if (spentRounds >= MAX_ROUNDS) {
		lines.push('', '已经问满澄清轮次：不要再返回 questions，直接给出规范提示词，把仍未确定的信息写进 assumptions。');
	}
	return lines.join('\n');
}

/**
 * The media types the composer can turn into an image draft, mirroring the
 * shipped browser intake. Anything else never arrives as an image part.
 */
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/**
 * Normalize the images the Client sent into the wire parts the attachment
 * service admits.
 *
 * The Client is untrusted input, so a part that is structurally unusable
 * (unknown media type, no payload, not an object) is dropped rather than
 * failing the request — but a dropped part is never silent: {@link imageParts}
 * reports it, and the caller surfaces that to the user. Silently translating
 * text while the user believes the model saw the picture is exactly the
 * failure this feature exists to remove.
 *
 * Every surviving part is still validated by the attachment service itself
 * (canonical base64, media type, byte and pixel limits), so filtering here only
 * narrows what reaches admission, it never bypasses it.
 *
 * @param images - the request's `images` array, of unknown shape.
 * @returns the parts ready for `admitPromptContent`, and how many were dropped.
 */
function imageParts(images) {
	if (!Array.isArray(images)) return { parts: [], dropped: 0 };
	const parts = [];
	let dropped = 0;
	for (const image of images) {
		if (image === null || typeof image !== 'object') {
			dropped += 1;
			continue;
		}
		const mediaType = typeof image.mediaType === 'string' ? image.mediaType : '';
		const data = typeof image.data === 'string' ? image.data : '';
		// An empty payload is the shape a zero-byte or unreadable file produces.
		// Counting it as dropped is what turns it into a visible refusal instead
		// of a translation that quietly ignored the picture.
		if (!IMAGE_MEDIA_TYPES.has(mediaType) || data === '') {
			dropped += 1;
			continue;
		}
		const name = typeof image.name === 'string' && image.name !== '' ? image.name : undefined;
		parts.push(name === undefined ? { type: 'image', mediaType, data } : { type: 'image', mediaType, data, name });
	}
	return { parts, dropped };
}

/**
 * Whether one exact model route can accept image content.
 *
 * The answer mirrors what the shipped adapters actually do, which is **not**
 * the same as "unknown means yes":
 * - a route that declares modalities including `image` accepts images;
 * - a route that declares modalities without `image` refuses them;
 * - a route that declares no `inputModalities` is treated as unable to take
 *   images, because the shipped adapters gate on exactly that field: the
 *   DeepSeek adapter throws `UNSUPPORTED_CONTENT` unless the resolved model
 *   lists `image`, and the pi-ai adapter does the same for
 *   `model.input.includes('image')`. Pretending an unknown route supports
 *   images would not make the request succeed — it would only turn this
 *   plugin's clear `polish/no-vision` into a downstream `polish/llm-error`.
 *
 * A capability lookup that *fails* is different from one that reports no
 * images: the failure says nothing about the route, so images are attempted
 * and the adapter stays authoritative. That case keeps the user's pictures.
 *
 * @param ctx - Host plugin context carrying `llm`.
 * @param selection - the resolved provider/model route.
 * @param signal - cancellation for the capability lookup.
 * @returns true when images may be sent on this route.
 */
async function acceptsImages(ctx, selection, signal) {
	let info;
	try {
		info = await ctx.llm.resolveModelInfo(selection.provider, selection.model, signal);
	} catch {
		// The lookup itself failed: that is no evidence about the route, so let
		// the model call decide. Losing the user's pictures to a transient lookup
		// failure would be the worse error.
		return true;
	}
	const modalities = info?.inputModalities;
	if (!Array.isArray(modalities)) return false;
	return modalities.includes('image');
}

/**
 * Build the user content for one translation request.
 *
 * Text comes first and images follow, which is the order every adapter and the
 * browser composer use. Images are admitted through the same durable service a
 * composer submission uses, so the blocks carry the references the adapters
 * read bytes through — the plugin never touches those bytes itself.
 *
 * @param ctx - Host plugin context carrying `attachments`.
 * @param text - the rendered user prompt.
 * @param images - already-normalized encoded image parts.
 * @returns the ordered content blocks for the user turn.
 */
async function userContent(ctx, text, images) {
	if (images.length === 0) return [{ type: 'text', text }];
	const admitted = await ctx.attachments.admitPromptContent(images);
	return [
		{ type: 'text', text },
		...admitted.map((part) => ({ type: 'image', attachment: part.attachment })),
	];
}


/**
 * Strip a code fence and any surrounding prose, then parse the first JSON object.
 * @param text - raw model text.
 * @returns the parsed value.
 * @throws {Error} with a `code` when no JSON object can be parsed.
 */
function parseModelJson(text) {
	const withoutFence = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
	const start = withoutFence.indexOf('{');
	const end = withoutFence.lastIndexOf('}');
	if (start === -1 || end <= start) {
		const error = new Error('模型没有返回 JSON 对象');
		error.code = 'polish/bad-output';
		throw error;
	}
	try {
		return JSON.parse(withoutFence.slice(start, end + 1));
	} catch (cause) {
		const error = new Error('模型返回的 JSON 无法解析');
		error.code = 'polish/bad-output';
		error.cause = cause;
		throw error;
	}
}

/**
 * Normalize one parsed model value, or throw when it is not a usable shape.
 * @param value - parsed JSON from the model.
 * @returns the translation value the Client renders.
 */
function normalizeModelValue(value) {
	if (value !== null && typeof value === 'object' && value.kind === 'questions') {
		const questions = Array.isArray(value.questions) ? value.questions : [];
		if (questions.length === 0) {
			const error = new Error('模型要求澄清，却没有给出问题');
			error.code = 'polish/bad-output';
			throw error;
		}
		return { kind: 'questions', questions: questions.slice(0, MAX_ROUNDS) };
	}
	if (value !== null && typeof value === 'object' && value.kind === 'prompt') {
		const prompt = typeof value.prompt === 'string' ? value.prompt.trim() : '';
		if (prompt === '') {
			const error = new Error('模型返回了空的规范提示词');
			error.code = 'polish/bad-output';
			throw error;
		}
		const assumptions = Array.isArray(value.assumptions)
			? value.assumptions.filter((item) => typeof item === 'string' && item.trim() !== '')
			: [];
		return { kind: 'prompt', prompt, assumptions };
	}
	const error = new Error('模型返回了无法识别的结构');
	error.code = 'polish/bad-output';
	throw error;
}

/**
 * Run one translation call against the shared LLM service.
 *
 * Nothing here is session-scoped: the request carries no `sessionId` and no
 * `purpose`, so the call cannot land in any session's history.
 *
 * @param ctx - Host plugin context carrying `llm`, `agentDefaultModel`, and `attachments`.
 * @param request - rough text plus optional transcript, feedback, and images.
 * @param signal - caller cancellation from the RPC invocation.
 * @returns the translation value.
 */
async function translate(ctx, request, signal) {
	const text = typeof request?.text === 'string' ? request.text.trim() : '';
	const { parts: images, dropped } = imageParts(request?.images);
	if (text === '') {
		const error = new Error('先写点东西再触发转写');
		error.code = 'polish/empty-input';
		throw error;
	}
	// A picture the user attached but that cannot be represented is a refusal,
	// not something to swallow: translating the text alone would show a prompt
	// that silently ignores the image the user was asking about.
	if (dropped > 0) {
		const error = new Error(
			dropped === 1
				? '有一张图片无法读取（可能已损坏或类型不受支持），请重新添加后再试'
				: `有 ${dropped} 张图片无法读取（可能已损坏或类型不受支持），请重新添加后再试`,
		);
		error.code = 'polish/bad-image';
		throw error;
	}

	const selection = ctx.agentDefaultModel.currentSelection();
	const provider = selection?.provider;
	const model = selection?.model;
	if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') {
		const error = new Error('当前没有可用的默认模型，请先在设置里选一个模型');
		error.code = 'polish/no-model';
		throw error;
	}

	const deadline = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
	if (images.length > 0 && !(await acceptsImages(ctx, selection, deadline))) {
		const error = new Error(`当前模型（${model}）不支持图片输入，请换一个支持图片的模型，或先从输入框移除图片`);
		error.code = 'polish/no-vision';
		throw error;
	}

	const context = await recentContext(ctx, request?.sessionId, deadline);
	const prompt = userPrompt({ ...request, text, context });
	let content;
	try {
		content = await userContent(ctx, prompt, images);
	} catch (cause) {
		// Admission owns every image policy (format, bytes, pixels, count). Its
		// refusal is the user's answer, not an internal fault, so it keeps its own
		// message instead of becoming a generic model failure.
		const error = new Error(cause instanceof Error ? cause.message : String(cause));
		error.code = 'polish/bad-image';
		throw error;
	}
	const messages = [{ role: 'user', content }];

	let output = '';
	let finish;
	for await (const chunk of ctx.llm.stream({
		provider,
		model,
		messages,
		system: SYSTEM_PROMPT,
		maxTokens: MAX_OUTPUT_TOKENS,
		signal: deadline,
	})) {
		if (chunk.type === 'text-delta') output += chunk.text;
		else if (chunk.type === 'finish') finish = chunk.reason;
	}

	if (finish === undefined) {
		const error = new Error('模型调用没有返回结束标记');
		error.code = 'polish/llm-error';
		throw error;
	}
	if (finish.kind === 'error' || finish.kind === 'aborted') {
		const error = new Error(finish.failure?.message ?? '模型调用失败');
		error.code = 'polish/llm-error';
		throw error;
	}
	if (finish.kind === 'max-tokens') {
		const error = new Error('模型输出被 maxTokens 截断');
		error.code = 'polish/llm-error';
		throw error;
	}
	if (finish.kind !== 'stop') {
		const error = new Error(`未知的结束原因：${String(finish.kind)}`);
		error.code = 'polish/llm-error';
		throw error;
	}

	return normalizeModelValue(parseModelJson(output));
}

/**
 * Map one thrown value to the RPC failure the Client displays.
 * @param error - the thrown value.
 * @param signal - the caller's own signal, to tell cancellation from timeout.
 * @returns the failure result.
 */
function failureOf(error, signal) {
	if (signal.aborted) return failure('polish/aborted', '已取消');
	const code = typeof error?.code === 'string' && error.code !== '' ? error.code : 'polish/llm-error';
	const message = error instanceof Error ? error.message : String(error);
	if (code === 'polish/llm-error' && error?.name === 'TimeoutError') {
		return failure('polish/timeout', `超过 ${TIMEOUT_MS / 1000} 秒仍未返回`);
	}
	return failure(code, message);
}

/**
 * Run one translation request and normalize the outcome into the result shape
 * the Client reads.
 * @param ctx - Host plugin context.
 * @param payload - request payload: `{ text, transcript, feedback }`.
 * @param signal - cancellation for this request.
 * @returns the result envelope.
 */
async function handleRequest(ctx, payload, signal) {
	try {
		return success(await translate(ctx, payload ?? {}, signal));
	} catch (error) {
		return failureOf(error, signal);
	}
}

/**
 * Write one JSON response.
 * @param res - the Node response to own.
 * @param status - HTTP status code.
 * @param body - JSON-serializable body.
 */
function sendJson(res, status, body) {
	const text = JSON.stringify(body);
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
	res.end(text);
}

/**
 * Read the whole request body, refusing anything above the hard transport cap.
 *
 * Image requests legitimately carry base64 payloads measured in megabytes, so
 * the read itself is bounded by {@link MAX_BODY_BYTES} — the same reasoning the
 * shipped `/api` carrier uses. The much tighter {@link MAX_TEXT_BODY_BYTES}
 * bound is applied after parsing, where the payload is known to carry no
 * images; see {@link handleHttp}.
 *
 * @param req - the incoming request.
 * @returns the body text and its byte length, or undefined when it exceeded {@link MAX_BODY_BYTES}.
 */
async function readBody(req) {
	let size = 0;
	const chunks = [];
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) return undefined;
		chunks.push(chunk);
	}
	return { text: Buffer.concat(chunks).toString('utf8'), bytes: size };
}

/**
 * Build the refusal for one request body over its effective cap.
 * @param cap - the byte cap that applies to this request.
 * @returns the business failure envelope.
 */
function tooLarge(cap) {
	return failure('polish/bad-request', `请求体超过 ${cap} 字节`);
}

/**
 * The effective body cap for one parsed payload.
 *
 * The plain-text cap covers text, transcript, feedback and JSON envelope. Each
 * carried image legitimately adds its own base64 payload on top of that, so the
 * allowance is the plain-text cap plus exactly what this request's images
 * occupy. A request therefore cannot borrow headroom it does not use: one
 * 96-byte picture buys 96 base64 bytes of room, not the whole image tier.
 *
 * The `MAX_BODY_BYTES` ceiling is enforced separately while reading, so this
 * only ever narrows further.
 *
 * @param payload - the parsed request payload.
 * @returns the cap in bytes for this request.
 */
function bodyCapFor(payload) {
	const images = Array.isArray(payload?.images) ? payload.images : [];
	let imageBytes = 0;
	for (const image of images) {
		// Count the payload as sent: an unusable part still arrived, and letting it
		// inflate the allowance would reopen the same hole through a malformed body.
		if (typeof image?.data === 'string') imageBytes += image.data.length;
	}
	return Math.min(MAX_TEXT_BODY_BYTES + imageBytes, MAX_BODY_BYTES);
}

/**
 * Serve one HTTP request on the plugin's own route.
 *
 * Authentication is the shipped predicate, not a hand-rolled one: the route is
 * loopback-bound, but only a request that passes the Connection trust fence and
 * the browser session check may spend a model call.
 *
 * @param ctx - Host plugin context.
 * @param req - the incoming request.
 * @param res - the response this handler owns.
 */
async function handleHttp(ctx, req, res) {
	const rejection = ctx.connection.requestRejection({ headers: req.headers });
	if (rejection !== undefined) {
		res.writeHead(rejection);
		res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
		return;
	}
	if (req.method !== 'POST') {
		res.writeHead(405, { allow: 'POST' });
		res.end('method not allowed');
		return;
	}

	const controller = new AbortController();
	let settled = false;
	res.on('close', () => {
		// A closed socket before the reply means the Client gave up (overlay
		// dismissed, page unloaded): stop spending tokens on it.
		if (!settled) controller.abort();
	});

	const body = await readBody(req);
	if (body === undefined) {
		settled = true;
		sendJson(res, 413, tooLarge(MAX_BODY_BYTES));
		return;
	}

	let payload;
	try {
		payload = JSON.parse(body.text === '' ? '{}' : body.text);
	} catch {
		settled = true;
		sendJson(res, 400, failure('polish/bad-request', '请求体不是合法 JSON'));
		return;
	}

	// The body cap grows with the pictures actually carried, not with the mere
	// presence of one: a request's text and envelope may only exceed the
	// plain-text cap by what its images legitimately occupy. Without this a
	// single byte of image would buy a 300 MiB body.
	if (body.bytes > bodyCapFor(payload)) {
		settled = true;
		sendJson(res, 413, tooLarge(bodyCapFor(payload)));
		return;
	}

	const result = await handleRequest(ctx, payload, controller.signal);
	settled = true;
	sendJson(res, 200, result);
}

/**
 * Register the `/polish` command and the plugin's own HTTP route.
 * @param ctx - Host plugin context.
 */
export function apply(ctx) {
	ctx.effect(
		() =>
			ctx.commands.register({
				name: COMMAND_NAME,
				description: '把粗糙提示词转写成规范提示词，确认后写入输入框',
				// `attachments: true` is what lets a `/polish` submission carrying
				// images through the composer's envelope gate at all: without it the
				// composer refuses the whole submission before dispatch and the user
				// has to delete the pictures. The handler ignores the admitted blocks
				// (the Client re-reads its own draft pictures), so nothing about them
				// reaches the session log; only the lifecycle pair is recorded.
				input: { hint: '粗糙提示词（留空则用输入框当前内容）', attachments: true },
				// The rough text must not reach the session log; the Client holds it.
				recordInput: false,
				// Discovery signal only: the Client owns the text, the overlay, and the write.
				handler: () => ({ kind: 'success' }),
			}),
		'polish: /polish command',
	);

	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: 'exact',
				path: ROUTE_PATH,
				handler: (req, res) => handleHttp(ctx, req, res),
			}),
		'polish: translate route',
	);
}
