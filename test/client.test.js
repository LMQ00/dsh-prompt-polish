/**
 * Client-half tests for `/polish`.
 *
 * `client.js` is a browser artifact: it registers a factory with
 * `window.__ModuleLoader__` instead of exporting ES bindings. The harness below
 * installs that global, imports the file, and takes the factory apart with a
 * React double — which is the only seam the browser loader offers. The pure
 * state machine and the serialization helpers are then reached through the
 * factory's documented `__internals` test seam.
 *
 * @module test/client.test
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(path.join(HERE, '..', 'client.js'), 'utf8');
const SESSION = 'session-1';

let registration;
globalThis.window = {
	__ModuleLoader__: {
		load(definition) {
			registration = definition;
		},
	},
};

await import('../client.js');

assert.ok(registration, 'client.js must register itself with the module loader');
assert.equal(registration.id, '@local/dsh-polish');

/** Minimal React double: the factory only needs `createElement` at module scope. */
const React = {
	createElement: (type, props, ...children) => ({ type, props, children }),
	useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
	useEffect: () => {},
};

const client = registration.factory((specifier) => {
	if (specifier === 'react') return React;
	throw new Error(`unexpected require: ${specifier}`);
});
const internals = client.__internals;

/** Settle every pending microtask and timer callback scheduled so far. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Replace `globalThis.fetch` with a manual promise queue.
 * @returns the queue plus settle/restore helpers.
 */
function createFetchControl() {
	const original = globalThis.fetch;
	const calls = [];
	globalThis.fetch = (url, init) =>
		new Promise((resolve, reject) => {
			calls.push({ url, init, resolve, reject });
		});
	return {
		calls,
		restore() {
			globalThis.fetch = original;
		},
		async settle(index, payload, { ok = true, status = 200 } = {}) {
			calls[index].resolve({ ok, status, json: async () => payload });
			await tick();
		},
		async fail(index, error) {
			calls[index].reject(error);
			await tick();
		},
	};
}

/**
 * Force one Session into a state without going through a request.
 * @param state - the state to install.
 * @returns the installed state.
 */
function seed(state) {
	internals.writeState(SESSION, state);
	return internals.readState(SESSION);
}

/**
 * Install the Client half against a fake context and capture its registrations.
 * @returns the registered slot keys/options and the registered event listeners.
 */
function installClient() {
	const slots = [];
	const listeners = [];
	client.apply({
		effect(callback) {
			callback();
			return () => {};
		},
		slots: {
			inject(key, callback) {
				callback();
				slots.push(key);
				return () => {};
			},
			register(options) {
				slots.push(options);
				return () => {};
			},
		},
		on(name, handler) {
			listeners.push([name, handler]);
			return () => {};
		},
	});
	return { slots, listeners };
}

// ── command parsing ───────────────────────────────────────────────────────────

test('command parsing: the /polish token is removed from either end', () => {
	assert.equal(internals.stripCommand('/polish 帮我写个登录页'), '帮我写个登录页');
	assert.equal(internals.stripCommand('帮我写个登录页 /polish'), '帮我写个登录页');
	assert.equal(internals.stripCommand('/polish'), '');
	assert.equal(internals.stripCommand('   /polish    多行\n文本   '), '多行\n文本');
	assert.equal(internals.stripCommand('没有命令'), '没有命令');
});

test('command parsing: only the first token is removed and non-strings are empty', () => {
	assert.equal(internals.stripCommand('/polish a /polish b'), 'a /polish b');
	assert.equal(internals.stripCommand(undefined), '');
	assert.equal(internals.stripCommand(null), '');
	assert.equal(internals.stripCommand(42), '');
});

// ── serialization ─────────────────────────────────────────────────────────────

test('serialization: multi-choice is read from either spelling', () => {
	assert.equal(internals.isMulti({ multi: true }), true);
	assert.equal(internals.isMulti({ multiSelect: true }), true);
	assert.equal(internals.isMulti({ multi: false }), false);
	assert.equal(internals.isMulti({}), false);
	assert.equal(internals.isMulti(undefined), false);
});

test('serialization: options and free text join into the single Host string', () => {
	assert.equal(internals.serializeAnswer({ options: ['A', 'B'], custom: '' }), 'A、B');
	assert.equal(internals.serializeAnswer({ options: ['A'], custom: '  C  ' }), 'A、C');
	assert.equal(internals.serializeAnswer({ options: [], custom: '  只有自由填  ' }), '只有自由填');
	assert.equal(internals.serializeAnswer({ options: [], custom: '  ' }), '');
	assert.equal(internals.serializeAnswer(undefined), '');
});

// ── state machine ─────────────────────────────────────────────────────────────

test('state machine: text in hand goes drafting, then review', async () => {
	const control = createFetchControl();
	try {
		internals.start({}, SESSION, '写个登录页');
		assert.equal(internals.readState(SESSION).phase, 'drafting');
		assert.equal(control.calls.length, 1);
		assert.equal(control.calls[0].url, internals.ROUTE);
		assert.deepEqual(JSON.parse(control.calls[0].init.body), {
			sessionId: SESSION,
			text: '写个登录页',
			transcript: [],
			rounds: 0,
			feedback: '',
		});
		await control.settle(0, { ok: true, value: { kind: 'prompt', prompt: 'P', assumptions: ['A'] } });
		const state = internals.readState(SESSION);
		assert.equal(state.phase, 'review');
		assert.equal(state.prompt, 'P');
		assert.deepEqual(state.assumptions, ['A']);
	} finally {
		control.restore();
	}
});

test('state machine: no text opens the input phase and spends nothing', () => {
	const control = createFetchControl();
	try {
		internals.start({}, SESSION, '   ');
		assert.equal(internals.readState(SESSION).phase, 'input');
		assert.equal(control.calls.length, 0);
	} finally {
		control.restore();
	}
});

test('state machine: questions move to clarifying, and answers resume the same request', async () => {
	const control = createFetchControl();
	try {
		internals.start({}, SESSION, '写个登录页');
		await control.settle(0, { ok: true, value: { kind: 'questions', questions: [{ id: 'q1', text: '给谁用？' }] } });
		const clarifying = internals.readState(SESSION);
		assert.equal(clarifying.phase, 'clarifying');
		assert.equal(clarifying.questions.length, 1);

		internals.submitAnswers({}, SESSION, ['内部员工']);
		const drafting = internals.readState(SESSION);
		assert.equal(drafting.phase, 'drafting');
		assert.equal(drafting.transcript.length, 1);
		assert.deepEqual(drafting.transcript[0].answers, ['内部员工']);
		const body = JSON.parse(control.calls[1].init.body);
		assert.equal(body.text, '写个登录页');
		assert.equal(body.transcript.length, 1);
	} finally {
		control.restore();
	}
});

test('state machine: rejecting a draft re-asks with the reason and keeps the rounds', async () => {
	const control = createFetchControl();
	try {
		internals.start({}, SESSION, '写个登录页');
		await control.settle(0, { ok: true, value: { kind: 'questions', questions: [{ id: 'q1', text: 't' }] } });
		internals.submitAnswers({}, SESSION, ['答']);
		await control.settle(1, { ok: true, value: { kind: 'prompt', prompt: 'P' } });
		assert.equal(internals.readState(SESSION).phase, 'review');

		internals.retry({}, SESSION, '  太啰嗦  ');
		const drafting = internals.readState(SESSION);
		assert.equal(drafting.phase, 'drafting');
		assert.equal(drafting.feedback, '太啰嗦');
		assert.equal(drafting.transcript.length, 1);
		const body = JSON.parse(control.calls[2].init.body);
		assert.equal(body.feedback, '太啰嗦');
		assert.equal(body.transcript.length, 1);
	} finally {
		control.restore();
	}
});

test('state machine: an error retry keeps the clarification rounds already earned', async () => {
	const control = createFetchControl();
	try {
		internals.start({}, SESSION, 'x');
		await control.settle(0, { ok: true, value: { kind: 'questions', questions: [{ id: 'q1', text: 't' }] } });
		internals.submitAnswers({}, SESSION, ['答']);
		await control.settle(1, { ok: false, error: { code: 'polish/llm-error', message: 'boom' } });
		assert.equal(internals.readState(SESSION).phase, 'error');

		internals.translateWith({}, SESSION, 'x 改过', internals.readState(SESSION).transcript, internals.readState(SESSION).rounds);
		const drafting = internals.readState(SESSION);
		assert.equal(drafting.phase, 'drafting');
		assert.equal(drafting.transcript.length, 1);
		assert.equal(drafting.rounds, 1, 'an error must not hand back a fresh budget');
		const body = JSON.parse(control.calls[2].init.body);
		assert.equal(body.text, 'x 改过');
		assert.equal(body.transcript.length, 1);
	} finally {
		control.restore();
	}
});

test('state machine: the clarification cap is enforced, not merely requested', async () => {
	const control = createFetchControl();
	try {
		internals.start({}, SESSION, 'x');
		for (let round = 0; round < internals.MAX_ROUNDS; round += 1) {
			await control.settle(round, { ok: true, value: { kind: 'questions', questions: [{ id: 'q', text: 't' }] } });
			assert.equal(internals.readState(SESSION).phase, 'clarifying', `round ${round + 1} must still be offered`);
			internals.submitAnswers({}, SESSION, [`答${round}`]);
		}
		assert.equal(internals.readState(SESSION).transcript.length, internals.MAX_ROUNDS);

		await control.settle(internals.MAX_ROUNDS, {
			ok: true,
			value: { kind: 'questions', questions: [{ id: 'q', text: 't' }] },
		});
		const state = internals.readState(SESSION);
		assert.equal(state.phase, 'error');
		assert.equal(state.code, 'polish/round-limit');

		// The retry keeps the earned rounds, which is the state where the Host
		// instructs the model to settle instead of asking again.
		internals.retry({}, SESSION, '');
		const retried = internals.readState(SESSION);
		assert.equal(retried.phase, 'drafting');
		assert.equal(retried.transcript.length, internals.MAX_ROUNDS);
	} finally {
		control.restore();
	}
});

test('state machine: rejecting an output reopens the clarification budget', async () => {
	const control = createFetchControl();
	try {
		internals.start({}, SESSION, 'x');
		for (let round = 0; round < internals.MAX_ROUNDS; round += 1) {
			await control.settle(round, { ok: true, value: { kind: 'questions', questions: [{ id: 'q', text: 't' }] } });
			internals.submitAnswers({}, SESSION, [`答${round}`]);
		}
		assert.equal(internals.readState(SESSION).rounds, internals.MAX_ROUNDS);

		// The model settles, as the Host asked it to once the budget ran out.
		await control.settle(internals.MAX_ROUNDS, { ok: true, value: { kind: 'prompt', prompt: 'P' } });
		assert.equal(internals.readState(SESSION).phase, 'review');

		// Rejecting that output starts a fresh attempt: the budget resets, while
		// every answer already given stays in the transcript.
		internals.retry({}, SESSION, '不对，再问几个问题');
		const drafting = internals.readState(SESSION);
		assert.equal(drafting.rounds, 0, 'a rejection must reopen the budget');
		assert.equal(drafting.transcript.length, internals.MAX_ROUNDS);

		// So the model is allowed to ask again instead of being stuck.
		await control.settle(internals.MAX_ROUNDS + 1, {
			ok: true,
			value: { kind: 'questions', questions: [{ id: 'q', text: '再问一个' }] },
		});
		assert.equal(internals.readState(SESSION).phase, 'clarifying');
	} finally {
		control.restore();
	}
});

test('state machine: the budget is reported to the Host on every request', async () => {
	const control = createFetchControl();
	try {
		internals.start({}, SESSION, 'x');
		assert.equal(JSON.parse(control.calls[0].init.body).rounds, 0);
		await control.settle(0, { ok: true, value: { kind: 'questions', questions: [{ id: 'q', text: 't' }] } });
		internals.submitAnswers({}, SESSION, ['答']);
		assert.equal(JSON.parse(control.calls[1].init.body).rounds, 1);
	} finally {
		control.restore();
	}
});

test('state machine: a superseded reply is discarded', async () => {
	const control = createFetchControl();
	try {
		internals.start({}, SESSION, '第一版');
		internals.start({}, SESSION, '第二版');
		assert.equal(control.calls.length, 2);
		await control.settle(0, { ok: true, value: { kind: 'prompt', prompt: '旧' } });
		assert.equal(internals.readState(SESSION).phase, 'drafting', 'the stale reply must not settle the overlay');
		await control.settle(1, { ok: true, value: { kind: 'prompt', prompt: '新' } });
		assert.equal(internals.readState(SESSION).prompt, '新');
	} finally {
		control.restore();
	}
});

test('state machine: dismissing aborts the request in flight', async () => {
	const control = createFetchControl();
	try {
		internals.start({}, SESSION, 'x');
		const controller = internals.readState(SESSION).controller;
		assert.equal(controller.signal.aborted, false);
		internals.dismiss(SESSION);
		assert.equal(controller.signal.aborted, true);
		assert.equal(internals.readState(SESSION).phase, 'idle');
	} finally {
		control.restore();
	}
});

test('state machine: a rejected fetch after an abort leaves the state untouched', async () => {
	const control = createFetchControl();
	try {
		internals.start({}, SESSION, 'x');
		const before = internals.readState(SESSION);
		before.controller.abort();
		await control.fail(0, new Error('boom'));
		assert.equal(internals.readState(SESSION), before);
	} finally {
		control.restore();
	}
});

// ── error mapping ─────────────────────────────────────────────────────────────

test('errors: a non-2xx response maps to polish/transport-error', async () => {
	const control = createFetchControl();
	try {
		internals.start({}, SESSION, 'x');
		await control.settle(0, undefined, { ok: false, status: 502 });
		const state = internals.readState(SESSION);
		assert.equal(state.phase, 'error');
		assert.equal(state.code, 'polish/transport-error');
		assert.match(state.message, /502/);
	} finally {
		control.restore();
	}
});

test('errors: a business failure keeps the Host code and message', async () => {
	const control = createFetchControl();
	try {
		internals.start({}, SESSION, 'x');
		await control.settle(0, { ok: false, error: { code: 'polish/no-model', message: '没有模型' } });
		const state = internals.readState(SESSION);
		assert.equal(state.code, 'polish/no-model');
		assert.equal(state.message, '没有模型');
	} finally {
		control.restore();
	}
});

test('errors: an unrecognized value maps to polish/bad-output', async () => {
	const control = createFetchControl();
	try {
		internals.start({}, SESSION, 'x');
		await control.settle(0, { ok: true, value: { kind: 'nonsense' } });
		assert.equal(internals.readState(SESSION).code, 'polish/bad-output');
	} finally {
		control.restore();
	}
});

test('errors: a transport rejection maps to polish/transport-error', async () => {
	const control = createFetchControl();
	try {
		internals.start({}, SESSION, 'x');
		await control.fail(0, new Error('network down'));
		const state = internals.readState(SESSION);
		assert.equal(state.code, 'polish/transport-error');
		assert.equal(state.message, 'network down');
	} finally {
		control.restore();
	}
});

// ── the composer write ────────────────────────────────────────────────────────

test('composer write: adopt calls setDraft once with the draft and never submits', () => {
	seed({ phase: 'review', prompt: 'P', assumptions: [], source: 's', transcript: [], feedback: '' });
	const calls = [];
	const inputActions = {
		setDraft: (text) => calls.push(['setDraft', text]),
		submit: () => calls.push(['submit']),
	};
	internals.adopt(SESSION, inputActions);
	assert.deepEqual(calls, [['setDraft', 'P']]);
	assert.equal(internals.readState(SESSION).phase, 'idle');
});

test('composer write: adopt does nothing outside review', () => {
	seed({ phase: 'drafting' });
	const calls = [];
	internals.adopt(SESSION, { setDraft: (text) => calls.push(text), submit: () => calls.push('submit') });
	assert.deepEqual(calls, []);
});

test('composer write: the source contains a setDraft call and no submit call', () => {
	assert.match(SOURCE, /\.setDraft\s*\(/);
	assert.doesNotMatch(SOURCE, /\.submit\s*\(/);
});

// ── registration ──────────────────────────────────────────────────────────────

test('apply: registers both composer seats and the command listener', () => {
	const { slots, listeners } = installClient();
	assert.deepEqual(
		slots.filter((entry) => typeof entry === 'object').map((entry) => entry.id),
		['polish', 'polish'],
	);
	assert.deepEqual(
		slots.filter((entry) => typeof entry === 'string'),
		['conversation.input.right', 'conversation.input.dock'],
	);
	assert.deepEqual(
		listeners.map(([name]) => name),
		['command/executed'],
	);
});

test('apply: another command name never opens the overlay', () => {
	const { listeners } = installClient();
	const [, handler] = listeners[0];
	internals.writeState('session-other', { phase: 'review', prompt: 'KEEP' });
	handler('session-other', 'compact');
	assert.equal(internals.readState('session-other').prompt, 'KEEP');
});

test('apply: /polish with nothing remembered opens the input phase', () => {
	const { listeners } = installClient();
	const [, handler] = listeners[0];
	handler('session-command', 'polish');
	assert.equal(internals.readState('session-command').phase, 'input');
});
