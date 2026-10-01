/**
 * Host-half tests for `/polish`.
 *
 * They drive the real registration path — `apply(ctx)` with a fake Host context —
 * and then call the registered HTTP handler, so the assertions cover the
 * contract the Client actually talks to rather than private helpers.
 *
 * @module test/host.test
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { apply, inject, name } from '../index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(path.join(HERE, '..', 'index.js'), 'utf8');

/** Settle every pending microtask and timer callback scheduled so far. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Build the chunk list a fake model call yields.
 * @param text - the text the model produces.
 * @param reason - the finish reason.
 * @returns ordered stream chunks.
 */
function textChunks(text, reason = { kind: 'stop' }) {
	return [
		{ type: 'block-start', index: 0, blockType: 'text' },
		{ type: 'text-delta', index: 0, text },
		{ type: 'finish', reason },
	];
}

/**
 * Build one Node-shaped request.
 * @param options - method, headers, and raw body.
 * @returns an async-iterable request.
 */
function makeRequest({ method = 'POST', headers = { host: '127.0.0.1:3080' }, body = '' } = {}) {
	const chunks = body === '' ? [] : [Buffer.from(body, 'utf8')];
	return {
		method,
		headers,
		async *[Symbol.asyncIterator]() {
			for (const chunk of chunks) yield chunk;
		},
	};
}

/**
 * Build one Node-shaped response that records what the handler wrote.
 * @returns the response double.
 */
function makeResponse() {
	const listeners = new Map();
	const res = {
		status: undefined,
		headers: undefined,
		body: undefined,
		writeHead(status, headers) {
			res.status = status;
			res.headers = headers;
			return res;
		},
		end(text) {
			res.body = text;
			return res;
		},
		on(event, listener) {
			const list = listeners.get(event) ?? [];
			list.push(listener);
			listeners.set(event, list);
			return res;
		},
		emit(event) {
			for (const listener of listeners.get(event) ?? []) listener();
		},
	};
	return res;
}

/**
 * Install the plugin against a fake Host context and expose what it registered.
 *
 * The context carries exactly the six Services the plugin injects, plus
 * `effect`. Nothing else exists, so a translation that quietly reached for
 * `agentLoop`, a filesystem, or a session append would fail here.
 *
 * @param options - per-test knobs: rejection, model selection, observation, gate, respond.
 * @returns the fake context and the captured registrations.
 */
function createHost(options = {}) {
	const commands = [];
	const routes = [];
	const llmCalls = [];
	const observed = [];
	const ctx = {
		effect(callback) {
			callback();
			return () => {};
		},
		commands: {
			register(definition) {
				commands.push(definition);
				return () => {};
			},
		},
		webServer: {
			register(route) {
				routes.push(route);
				return () => {};
			},
		},
		connection: { requestRejection: () => options.rejection },
		agentDefaultModel: {
			currentSelection: () =>
				options.selection === undefined ? { provider: 'test-provider', model: 'test-model' } : options.selection,
		},
		sessionQuery: {
			async observeSession(sessionId, observeOptions) {
				observed.push({ sessionId, options: observeOptions });
				if (options.observeError) throw options.observeError;
				return options.observation ?? { events: [], [Symbol.dispose]() {} };
			},
		},
		llm: {
			stream(llmOptions) {
				llmCalls.push(llmOptions);
				return (async function* fakeStream() {
					if (options.gate) await options.gate;
					// A real adapter surfaces cancellation; the fake must too, or the
					// aborted-mapping test would pass for the wrong reason.
					if (llmOptions.signal?.aborted) {
						const aborted = new Error('model call aborted');
						aborted.name = 'AbortError';
						throw aborted;
					}
					const chunks = typeof options.respond === 'function' ? options.respond(llmOptions) : [];
					for (const chunk of chunks) yield chunk;
				})();
			},
		},
	};
	apply(ctx);
	return { ctx, commands, routes, llmCalls, observed };
}

/**
 * Call the plugin's registered route.
 * @param host - the value returned by {@link createHost}.
 * @param init - request options.
 * @returns the response double.
 */
async function callRoute(host, init) {
	const res = makeResponse();
	await host.routes[0].handler(makeRequest(init), res);
	return res;
}

/**
 * Call the route and parse the JSON envelope it wrote.
 * @param host - the value returned by {@link createHost}.
 * @param payload - request payload.
 * @returns the parsed envelope.
 */
async function translate(host, payload) {
	const res = await callRoute(host, { body: JSON.stringify(payload) });
	assert.equal(res.status, 200);
	return JSON.parse(res.body);
}

/** The prompt text handed to the model by the first call. */
function userText(host) {
	return host.llmCalls[0].messages[0].content[0].text;
}

test('registration: the plugin declares its identity and every Service it needs', () => {
	assert.equal(name, 'polish');
	assert.deepEqual(inject, ['commands', 'llm', 'agentDefaultModel', 'connection', 'webServer', 'sessionQuery']);
});

test('registration: one exact route at the documented path', () => {
	const host = createHost();
	assert.equal(host.routes.length, 1);
	assert.equal(host.routes[0].kind, 'exact');
	assert.equal(host.routes[0].path, '/polish/translate');
	assert.equal(typeof host.routes[0].handler, 'function');
});

test('registration: the command is discovery-only — no recorded input, no result text', () => {
	const host = createHost();
	assert.equal(host.commands.length, 1);
	const command = host.commands[0];
	assert.equal(command.name, 'polish');
	assert.equal(command.recordInput, false);
	assert.equal(typeof command.description, 'string');
	assert.equal(typeof command.input?.hint, 'string');
	const result = command.handler();
	assert.deepEqual(result, { kind: 'success' });
	assert.equal(result.text, undefined, 'the command must not carry the prompt into the session log');
});

test('http: a refused request never reaches the model', async () => {
	const unauthorized = createHost({ rejection: 401 });
	const unauthorizedRes = await callRoute(unauthorized, { body: JSON.stringify({ text: 'x' }) });
	assert.equal(unauthorizedRes.status, 401);
	assert.equal(unauthorizedRes.body, 'unauthorized');
	assert.equal(unauthorized.llmCalls.length, 0);

	const forbidden = createHost({ rejection: 403 });
	const forbiddenRes = await callRoute(forbidden, { body: JSON.stringify({ text: 'x' }) });
	assert.equal(forbiddenRes.status, 403);
	assert.equal(forbiddenRes.body, 'forbidden');
	assert.equal(forbidden.llmCalls.length, 0);
});

test('http: a non-POST method is refused with 405', async () => {
	const host = createHost();
	const res = await callRoute(host, { method: 'GET' });
	assert.equal(res.status, 405);
	assert.equal(res.headers.allow, 'POST');
	assert.equal(host.llmCalls.length, 0);
});

test('http: a body over the 64 KiB cap is refused with 413', async () => {
	const host = createHost();
	const res = await callRoute(host, { body: JSON.stringify({ text: 'x'.repeat(70_000) }) });
	assert.equal(res.status, 413);
	assert.equal(JSON.parse(res.body).error.code, 'polish/bad-request');
	assert.equal(host.llmCalls.length, 0);
});

test('http: a malformed body is refused with 400', async () => {
	const host = createHost();
	const res = await callRoute(host, { body: '{not json' });
	assert.equal(res.status, 400);
	assert.equal(JSON.parse(res.body).error.code, 'polish/bad-request');
	assert.equal(host.llmCalls.length, 0);
});

test('http: an empty body behaves like an empty payload', async () => {
	const host = createHost();
	const res = await callRoute(host, { body: '' });
	assert.equal(res.status, 200);
	assert.equal(JSON.parse(res.body).error.code, 'polish/empty-input');
});

test('http: success is a JSON envelope with the documented content type', async () => {
	const host = createHost({ respond: () => textChunks('{"kind":"prompt","prompt":"P","assumptions":[]}') });
	const res = await callRoute(host, { body: JSON.stringify({ text: '写个登录页' }) });
	assert.equal(res.status, 200);
	assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
	assert.deepEqual(JSON.parse(res.body), { ok: true, value: { kind: 'prompt', prompt: 'P', assumptions: [] } });
});

test('errors: an empty request maps to polish/empty-input', async () => {
	const host = createHost();
	assert.deepEqual((await translate(host, { text: '   ' })).error.code, 'polish/empty-input');
	assert.equal(host.llmCalls.length, 0);
});

test('errors: a missing default model maps to polish/no-model', async () => {
	const host = createHost({ selection: undefined });
	host.ctx.agentDefaultModel.currentSelection = () => undefined;
	assert.equal((await translate(host, { text: 'x' })).error.code, 'polish/no-model');
	assert.equal(host.llmCalls.length, 0);
});

test('errors: output without a JSON object maps to polish/bad-output', async () => {
	const host = createHost({ respond: () => textChunks('抱歉，我需要更多信息。') });
	assert.equal((await translate(host, { text: 'x' })).error.code, 'polish/bad-output');
});

test('errors: unparsable JSON maps to polish/bad-output', async () => {
	const host = createHost({ respond: () => textChunks('{ "kind": "prompt", }') });
	assert.equal((await translate(host, { text: 'x' })).error.code, 'polish/bad-output');
});

test('errors: a fenced JSON object is still accepted', async () => {
	const host = createHost({ respond: () => textChunks('```json\n{"kind":"prompt","prompt":"P","assumptions":[]}\n```') });
	const envelope = await translate(host, { text: 'x' });
	assert.equal(envelope.ok, true);
	assert.equal(envelope.value.prompt, 'P');
});

test('errors: a questions reply with no questions maps to polish/bad-output', async () => {
	const host = createHost({ respond: () => textChunks('{"kind":"questions","questions":[]}') });
	assert.equal((await translate(host, { text: 'x' })).error.code, 'polish/bad-output');
});

test('errors: an empty prompt maps to polish/bad-output', async () => {
	const host = createHost({ respond: () => textChunks('{"kind":"prompt","prompt":"   "}') });
	assert.equal((await translate(host, { text: 'x' })).error.code, 'polish/bad-output');
});

test('errors: an unrecognized shape maps to polish/bad-output', async () => {
	const host = createHost({ respond: () => textChunks('{"kind":"nonsense"}') });
	assert.equal((await translate(host, { text: 'x' })).error.code, 'polish/bad-output');
});

test('errors: a missing finish marker maps to polish/llm-error', async () => {
	const host = createHost({ respond: () => [{ type: 'text-delta', index: 0, text: '{}' }] });
	assert.equal((await translate(host, { text: 'x' })).error.code, 'polish/llm-error');
});

for (const reason of [
	{ kind: 'error', failure: { message: 'provider exploded' } },
	{ kind: 'aborted', failure: { message: 'upstream abort' } },
	{ kind: 'max-tokens' },
	{ kind: 'something-new' },
]) {
	test(`errors: finish reason ${JSON.stringify(reason.kind)} maps to polish/llm-error`, async () => {
		const host = createHost({ respond: () => textChunks('{}', reason) });
		const envelope = await translate(host, { text: 'x' });
		assert.equal(envelope.error.code, 'polish/llm-error');
		assert.equal(typeof envelope.error.message, 'string');
	});
}

test('errors: a thrown TimeoutError maps to polish/timeout', async () => {
	const host = createHost({
		respond: () => {
			const timeout = new Error('the operation was aborted due to timeout');
			timeout.name = 'TimeoutError';
			throw timeout;
		},
	});
	assert.equal((await translate(host, { text: 'x' })).error.code, 'polish/timeout');
});

test('errors: an unknown thrown value maps to polish/llm-error', async () => {
	const host = createHost({
		respond: () => {
			throw new Error('no code on this one');
		},
	});
	assert.equal((await translate(host, { text: 'x' })).error.code, 'polish/llm-error');
});

test('errors: a socket closed mid-flight aborts the call and maps to polish/aborted', async () => {
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const host = createHost({ gate, respond: () => textChunks('{"kind":"prompt","prompt":"P"}') });
	const res = makeResponse();
	const pending = host.routes[0].handler(makeRequest({ body: JSON.stringify({ text: 'x' }) }), res);
	await tick();
	res.emit('close');
	release();
	await pending;
	assert.equal(JSON.parse(res.body).error.code, 'polish/aborted');
});

test('prompt: the rough text and the four hard constraints are present', async () => {
	const host = createHost({ respond: () => textChunks('{"kind":"prompt","prompt":"P"}') });
	await translate(host, { text: '帮我写个登录页' });
	assert.match(userText(host), /原始请求：\n帮我写个登录页/);
	const system = host.llmCalls[0].system;
	assert.match(system, /任务与目标/);
	assert.match(system, /输出格式与验收标准/);
	assert.match(system, /缺口显式标注/);
	assert.match(system, /不得发明需求/);
	assert.match(system, /用与输入相同的语言书写/);
});

test('prompt: clarification rounds and retry feedback are rendered', async () => {
	const host = createHost({ respond: () => textChunks('{"kind":"prompt","prompt":"P"}') });
	await translate(host, {
		text: '写个登录页',
		transcript: [{ questions: [{ id: 'q1', text: '给谁用？' }], answers: ['内部员工'] }],
		feedback: '太啰嗦',
	});
	const prompt = userText(host);
	assert.match(prompt, /Q: 给谁用？/);
	assert.match(prompt, /A: 内部员工/);
	assert.match(prompt, /用户对上一版不满意，原因：\n太啰嗦/);
});

test('prompt: an unanswered question renders as such, and the round cap is announced', async () => {
	const host = createHost({ respond: () => textChunks('{"kind":"prompt","prompt":"P"}') });
	const round = (index) => ({ questions: [{ id: `q${index}`, text: `问题${index}` }], answers: [] });
	await translate(host, { text: 'x', transcript: [round(1), round(2), round(3)] });
	const prompt = userText(host);
	assert.match(prompt, /A: （未回答）/);
	assert.match(prompt, /已经问满澄清轮次/);
});

test('prompt: the settle instruction follows the Client budget, not the transcript length', async () => {
	const threeRounds = [
		{ questions: [{ id: 'q1', text: 't1' }], answers: ['a1'] },
		{ questions: [{ id: 'q2', text: 't2' }], answers: ['a2'] },
		{ questions: [{ id: 'q3', text: 't3' }], answers: ['a3'] },
	];
	const spent = createHost({ respond: () => textChunks('{"kind":"prompt","prompt":"P"}') });
	await translate(spent, { text: 'x', rounds: 3, transcript: threeRounds });
	assert.match(userText(spent), /已经问满澄清轮次/);

	const legacy = createHost({ respond: () => textChunks('{"kind":"prompt","prompt":"P"}') });
	await translate(legacy, { text: 'x', transcript: threeRounds });
	assert.match(userText(legacy), /已经问满澄清轮次/, 'an absent budget falls back to the transcript length');

	// The rejection path resets the budget while keeping every answer, so the
	// model must be free to ask again instead of being told to settle.
	const reopened = createHost({ respond: () => textChunks('{"kind":"prompt","prompt":"P"}') });
	await translate(reopened, { text: 'x', rounds: 0, transcript: threeRounds });
	assert.doesNotMatch(userText(reopened), /已经问满澄清轮次/);
	assert.match(userText(reopened), /Q: t3/);
});

test('prompt: no context block when the Session is unknown', async () => {
	const host = createHost({ respond: () => textChunks('{"kind":"prompt","prompt":"P"}') });
	await translate(host, { text: 'x' });
	assert.doesNotMatch(userText(host), /对话上下文/);
	assert.equal(host.observed.length, 0, 'an absent sessionId must not trigger a read');
});

test('context: only user and assistant text blocks become context lines', async () => {
	const host = createHost({
		respond: () => textChunks('{"kind":"prompt","prompt":"P"}'),
		observation: {
			events: [
				{ type: 'turn/start', data: {} },
				{ type: 'user/message', data: { content: [{ type: 'text', text: '第一问' }] } },
				{ type: 'user/message', data: { content: [{ type: 'image', mediaType: 'image/png' }] } },
				{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第一答' }] } } },
				{ type: 'tool/call', data: { name: 'bash' } },
			],
			[Symbol.dispose]() {},
		},
	});
	await translate(host, { sessionId: 'session-1', text: 'x' });
	const prompt = userText(host);
	assert.match(prompt, /用户：第一问/);
	assert.match(prompt, /助手：第一答/);
	assert.doesNotMatch(prompt, /bash/);
	assert.equal(host.observed[0].sessionId, 'session-1');
	assert.equal(host.observed[0].options.projectionMode, 'none');
	assert.ok(host.observed[0].options.signal instanceof AbortSignal);
});

test('context: the observation lease is released', async () => {
	let disposed = 0;
	const host = createHost({
		respond: () => textChunks('{"kind":"prompt","prompt":"P"}'),
		observation: { events: [], [Symbol.dispose]: () => { disposed += 1; } },
	});
	await translate(host, { sessionId: 'session-1', text: 'x' });
	assert.equal(disposed, 1);
});

test('context: only the last eight messages ride along', async () => {
	const events = [];
	for (let index = 1; index <= 10; index += 1) {
		events.push({ type: 'user/message', data: { content: [{ type: 'text', text: `第${index}条` }] } });
	}
	const host = createHost({
		respond: () => textChunks('{"kind":"prompt","prompt":"P"}'),
		observation: { events, [Symbol.dispose]() {} },
	});
	await translate(host, { sessionId: 'session-1', text: 'x' });
	const prompt = userText(host);
	assert.doesNotMatch(prompt, /第1条/);
	assert.doesNotMatch(prompt, /第2条/);
	assert.match(prompt, /第3条/);
	assert.match(prompt, /第10条/);
});

test('context: an oversized history is truncated from the front', async () => {
	const host = createHost({
		respond: () => textChunks('{"kind":"prompt","prompt":"P"}'),
		observation: {
			events: [{ type: 'user/message', data: { content: [{ type: 'text', text: `${'开头'.repeat(4000)}结尾标记` }] } }],
			[Symbol.dispose]() {},
		},
	});
	await translate(host, { sessionId: 'session-1', text: 'x' });
	const contextBlock = userText(host).split('对话上下文（只用于消歧，不要复述）：\n')[1].split('\n\n原始请求')[0];
	assert.ok(contextBlock.length <= 6_001, `context must stay capped, got ${contextBlock.length}`);
	assert.ok(contextBlock.startsWith('…'));
	assert.ok(contextBlock.endsWith('结尾标记'));
});

test('context: a read failure degrades to no context instead of failing the request', async () => {
	const host = createHost({
		respond: () => textChunks('{"kind":"prompt","prompt":"P"}'),
		observeError: new Error('session is not readable'),
	});
	const envelope = await translate(host, { sessionId: 'session-1', text: 'x' });
	assert.equal(envelope.ok, true);
	assert.doesNotMatch(userText(host), /对话上下文/);
});

test('context: the model call carries no sessionId and no purpose', async () => {
	const host = createHost({
		respond: () => textChunks('{"kind":"prompt","prompt":"P"}'),
		observation: {
			events: [{ type: 'user/message', data: { content: [{ type: 'text', text: '上文' }] } }],
			[Symbol.dispose]() {},
		},
	});
	await translate(host, { sessionId: 'session-1', text: 'x' });
	assert.equal(host.llmCalls[0].sessionId, undefined);
	assert.equal(host.llmCalls[0].purpose, undefined);
});

test('boundaries: the Host half touches no session writer and no filesystem', async () => {
	const host = createHost({ respond: () => textChunks('{"kind":"prompt","prompt":"P"}') });
	assert.equal(host.ctx.agentLoop, undefined);
	assert.equal(host.ctx.fs, undefined);
	// The full request must succeed with exactly the injected Services present.
	const envelope = await translate(host, { text: 'x' });
	assert.equal(envelope.ok, true);
	assert.doesNotMatch(SOURCE, /\b(writeFile|appendFile|createWriteStream|mkdirSync|unlinkSync)\b/);
});
