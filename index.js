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
 * - never calls any filesystem write interface;
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
 * @module @local/dsh-polish
 */

export const name = 'polish';

/**
 * `commands` is what makes `/polish` discoverable, and `llm` plus
 * `agentDefaultModel` are what make the translation possible at all.
 * `webServer` hosts the plugin's own route; `connection` supplies the browser
 * trust and authentication predicate for it; `sessionQuery` is how the recent
 * conversation is read so a translation can resolve what "这个" refers to.
 */
export const inject = ['commands', 'llm', 'agentDefaultModel', 'connection', 'webServer', 'sessionQuery'];

/** Absolute path of the plugin's own route; no trailing slash. */
const ROUTE_PATH = '/polish/translate';

/** Largest request body accepted, in bytes. */
const MAX_BODY_BYTES = 64 * 1024;

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
 * @param ctx - Host plugin context carrying `llm` and `agentDefaultModel`.
 * @param request - rough text plus optional transcript and feedback.
 * @param signal - caller cancellation from the RPC invocation.
 * @returns the translation value.
 */
async function translate(ctx, request, signal) {
	const text = typeof request?.text === 'string' ? request.text.trim() : '';
	if (text === '') {
		const error = new Error('先写点东西再触发转写');
		error.code = 'polish/empty-input';
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
	const context = await recentContext(ctx, request?.sessionId, deadline);
	const messages = [{ role: 'user', content: [{ type: 'text', text: userPrompt({ ...request, text, context }) }] }];

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
 * Read the whole request body, refusing anything oversized.
 * @param req - the incoming request.
 * @returns the body text, or undefined when it exceeded {@link MAX_BODY_BYTES}.
 */
async function readBody(req) {
	let size = 0;
	const chunks = [];
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) return undefined;
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString('utf8');
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
		sendJson(res, 413, failure('polish/bad-request', `请求体超过 ${MAX_BODY_BYTES} 字节`));
		return;
	}

	let payload;
	try {
		payload = JSON.parse(body === '' ? '{}' : body);
	} catch {
		settled = true;
		sendJson(res, 400, failure('polish/bad-request', '请求体不是合法 JSON'));
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
				input: { hint: '粗糙提示词（留空则用输入框当前内容）' },
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
