/**
 * `/polish` — Client half.
 *
 * Owns every piece of UI and every write to the composer:
 * - a compact trigger button in the composer tool row, immediately left of the
 *   model selector (`conversation.input.right`);
 * - a preview panel above the composer card (`conversation.input.dock`);
 * - the only write into the composer, `inputActions.setDraft`.
 *
 * It never submits: `inputActions.submit` is deliberately never referenced, so
 * the user always presses send themselves.
 *
 * The translation itself runs on the Host over the plugin's own Connection RPC
 * channel, so no part of the user's text or the finished prompt is appended to
 * the session log.
 *
 * @module @local/dsh-polish/client
 */

window.__ModuleLoader__.load({
	id: '@local/dsh-polish',
	factory(require) {
		const React = require('react');
		const h = React.createElement;

		/** Absolute logical RPC channel owned by the Host half. */
		const CHANNEL = '/polish';
		/** The single endpoint on that channel. */
		const ENDPOINT = 'translate';
		/** Lowercase command name without the leading slash. */
		const COMMAND = 'polish';
		/** Clarification rounds allowed before the Host is told to settle. */
		const MAX_ROUNDS = 3;

		/** The closed overlay state. */
		const IDLE = { phase: 'idle' };

		/**
		 * One overlay state per Session. Kept outside React so the trigger button
		 * and the overlay read the same value without prop drilling.
		 */
		const states = new Map();
		/** Subscribers re-read the whole map on any change. */
		const subscribers = new Set();
		/** Last composer line that named `/polish`, per Session. */
		const commandLines = new Map();

		/**
		 * Read one Session's overlay state.
		 * @param sessionId - the Session.
		 * @returns the current state, or the closed state.
		 */
		function readState(sessionId) {
			return states.get(sessionId) ?? IDLE;
		}

		/**
		 * Replace one Session's overlay state and notify every subscriber.
		 * @param sessionId - the Session.
		 * @param next - the new state.
		 */
		function writeState(sessionId, next) {
			states.set(sessionId, next);
			for (const notify of [...subscribers]) notify();
		}

		/**
		 * Subscribe to overlay state changes.
		 * @param notify - called after any state write.
		 * @returns the unsubscribe function.
		 */
		function subscribe(notify) {
			subscribers.add(notify);
			return () => {
				subscribers.delete(notify);
			};
		}

		/**
		 * Subscribe one component to a Session's overlay state.
		 * @param sessionId - the Session.
		 * @returns the current state.
		 */
		function usePolishState(sessionId) {
			const [snapshot, setSnapshot] = React.useState(() => readState(sessionId));
			React.useEffect(() => {
				setSnapshot(readState(sessionId));
				return subscribe(() => setSnapshot(readState(sessionId)));
			}, [sessionId]);
			return snapshot;
		}

		/**
		 * Remove a `/polish` token from a composer line, keeping the rest verbatim.
		 * The command token can sit at either end, because the composer inserts it
		 * where the user typed it and leaves the rest of the draft alone.
		 * @param line - the captured composer line.
		 * @returns the rough text that remains.
		 */
		function stripCommand(line) {
			const text = typeof line === 'string' ? line : '';
			const at = text.indexOf(`/${COMMAND}`);
			if (at === -1) return text.trim();
			return `${text.slice(0, at)} ${text.slice(at + COMMAND.length + 1)}`.trim();
		}

		/**
		 * Run one translation and settle the overlay into its next state.
		 * @param ctx - Client plugin context.
		 * @param sessionId - the Session.
		 * @param state - the state this request belongs to; a newer state discards the reply.
		 */
		async function run(ctx, sessionId, state) {
			try {
				const result = await ctx.connection.rpc.call(
					CHANNEL,
					ENDPOINT,
					{
						text: state.source,
						transcript: state.transcript,
						feedback: state.feedback ?? '',
					},
					state.controller.signal,
				);
				if (readState(sessionId) !== state) return;
				if (!result.ok) {
					writeState(sessionId, { ...state, phase: 'error', code: result.error.code, message: result.error.message });
					return;
				}
				const value = result.value;
				if (value?.kind === 'questions') {
					writeState(sessionId, { ...state, phase: 'clarifying', questions: value.questions, round: state.transcript.length });
				} else if (value?.kind === 'prompt') {
					writeState(sessionId, {
						...state,
						phase: 'review',
						prompt: value.prompt,
						assumptions: Array.isArray(value.assumptions) ? value.assumptions : [],
					});
				} else {
					writeState(sessionId, { ...state, phase: 'error', code: 'polish/bad-output', message: '模型返回了无法识别的结构' });
				}
			} catch (error) {
				if (state.controller.signal.aborted) return;
				if (readState(sessionId) !== state) return;
				writeState(sessionId, {
					...state,
					phase: 'error',
					code: 'polish/transport-error',
					message: error instanceof Error ? error.message : String(error),
				});
			}
		}

		/**
		 * Open the overlay for one Session and start the first translation.
		 * @param ctx - Client plugin context.
		 * @param sessionId - the Session.
		 * @param text - the rough text.
		 */
		function start(ctx, sessionId, text) {
			const source = typeof text === 'string' ? text.trim() : '';
			if (source === '') {
				writeState(sessionId, { phase: 'error', code: 'polish/empty-input', message: '先写点东西再触发转写', source: '' });
				return;
			}
			const previous = readState(sessionId);
			if (previous.controller !== undefined) previous.controller.abort();
			const state = { phase: 'drafting', source, transcript: [], feedback: '', controller: new AbortController() };
			writeState(sessionId, state);
			void run(ctx, sessionId, state);
		}

		/**
		 * Continue after one clarification round.
		 * @param ctx - Client plugin context.
		 * @param sessionId - the Session.
		 * @param answers - one answer string per question, in question order.
		 */
		function submitAnswers(ctx, sessionId, answers) {
			const state = readState(sessionId);
			if (state.phase !== 'clarifying') return;
			const transcript = [...state.transcript, { questions: state.questions, answers }];
			const next = {
				phase: 'drafting',
				source: state.source,
				transcript,
				feedback: '',
				controller: new AbortController(),
			};
			writeState(sessionId, next);
			void run(ctx, sessionId, next);
		}

		/**
		 * Ask for another draft, carrying the user's reason for rejecting the last one.
		 * @param ctx - Client plugin context.
		 * @param sessionId - the Session.
		 * @param feedback - why the previous draft was rejected; may be empty for an error retry.
		 */
		function retry(ctx, sessionId, feedback) {
			const state = readState(sessionId);
			if (state.phase !== 'review' && state.phase !== 'error') return;
			const next = {
				phase: 'drafting',
				source: state.source,
				transcript: state.transcript ?? [],
				feedback: typeof feedback === 'string' ? feedback.trim() : '',
				controller: new AbortController(),
			};
			writeState(sessionId, next);
			void run(ctx, sessionId, next);
		}

		/**
		 * Close the overlay, cancelling any request still in flight.
		 * @param sessionId - the Session.
		 */
		function dismiss(sessionId) {
			const state = readState(sessionId);
			if (state.controller !== undefined) state.controller.abort();
			writeState(sessionId, IDLE);
		}

		/**
		 * Write the accepted draft into the composer and close.
		 *
		 * This is the plugin's only composer write, and it never submits.
		 * @param sessionId - the Session.
		 * @param inputActions - the Session's stable input action face.
		 */
		function adopt(sessionId, inputActions) {
			const state = readState(sessionId);
			if (state.phase !== 'review') return;
			inputActions.setDraft(state.prompt);
			writeState(sessionId, IDLE);
		}

		/** Shared style fragments, all built from host theme tokens. */
		const styles = {
			button: {
				display: 'inline-flex',
				alignItems: 'center',
				justifyContent: 'center',
				width: '28px',
				height: '28px',
				padding: '0',
				border: '1px solid transparent',
				borderRadius: 'var(--dsw-radius-lg, 8px)',
				background: 'transparent',
				color: 'var(--dsw-alias-label-secondary)',
				cursor: 'pointer',
			},
			buttonActive: {
				color: 'var(--dsw-alias-brand-primary)',
				borderColor: 'var(--dsw-alias-border-l2)',
			},
			buttonBusy: {
				color: 'var(--dsw-alias-brand-primary)',
				cursor: 'progress',
			},
			panel: {
				display: 'flex',
				flexDirection: 'column',
				gap: '10px',
				margin: '0 0 8px',
				padding: '12px 14px',
				border: '1px solid var(--dsw-alias-border-l1)',
				borderRadius: 'var(--dsw-radius-xl, 12px)',
				background: 'var(--dsw-alias-bg-layer-1)',
				color: 'var(--dsw-alias-label-primary)',
				fontSize: '13px',
				lineHeight: '20px',
			},
			header: {
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'space-between',
				gap: '8px',
				color: 'var(--dsw-alias-label-secondary)',
				fontSize: '12px',
			},
			pre: {
				margin: '0',
				padding: '10px 12px',
				border: '1px solid var(--dsw-alias-border-l1)',
				borderRadius: 'var(--dsw-radius-lg, 8px)',
				background: 'var(--dsw-alias-bg-layer-2)',
				fontFamily: 'inherit',
				fontSize: '13px',
				lineHeight: '20px',
				whiteSpace: 'pre-wrap',
				overflowWrap: 'anywhere',
				maxHeight: '260px',
				overflowY: 'auto',
			},
			row: {
				display: 'flex',
				flexWrap: 'wrap',
				gap: '6px',
			},
			option: {
				padding: '3px 10px',
				border: '1px solid var(--dsw-alias-border-l1)',
				borderRadius: '999px',
				background: 'transparent',
				color: 'var(--dsw-alias-label-primary)',
				fontSize: '12px',
				cursor: 'pointer',
			},
			optionOn: {
				borderColor: 'var(--dsw-alias-brand-primary)',
				color: 'var(--dsw-alias-brand-primary)',
			},
			input: {
				width: '100%',
				boxSizing: 'border-box',
				padding: '6px 10px',
				border: '1px solid var(--dsw-alias-border-l1)',
				borderRadius: 'var(--dsw-radius-lg, 8px)',
				background: 'var(--dsw-alias-bg-layer-2)',
				color: 'var(--dsw-alias-label-primary)',
				fontFamily: 'inherit',
				fontSize: '13px',
				resize: 'vertical',
			},
			primary: {
				padding: '4px 12px',
				border: '1px solid var(--dsw-alias-brand-primary)',
				borderRadius: 'var(--dsw-radius-lg, 8px)',
				background: 'var(--dsw-alias-brand-primary)',
				color: 'var(--dsw-alias-bg-base)',
				fontSize: '12px',
				cursor: 'pointer',
			},
			ghost: {
				padding: '4px 12px',
				border: '1px solid var(--dsw-alias-border-l1)',
				borderRadius: 'var(--dsw-radius-lg, 8px)',
				background: 'transparent',
				color: 'var(--dsw-alias-label-primary)',
				fontSize: '12px',
				cursor: 'pointer',
			},
			disabled: { opacity: 0.5, cursor: 'not-allowed' },
			hint: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
			error: { color: 'var(--dsw-alias-state-error-primary)' },
		};

		/** The trigger glyph: a small sparkle, drawn in currentColor. */
		function TriggerIcon() {
			return h(
				'svg',
				{ viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true, fill: 'currentColor' },
				h('path', {
					d: 'M8 1.2l1.5 4.1 4.1 1.5-4.1 1.5L8 12.4 6.5 8.3 2.4 6.8l4.1-1.5L8 1.2z',
				}),
				h('path', { d: 'M12.9 10.4l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7.7-1.9z' }),
			);
		}

		/**
		 * One labelled action button.
		 * @param props - label, click handler, emphasis, and disabled flag.
		 * @returns the button element.
		 */
		function Action({ label, onClick, primary = false, disabled = false }) {
			return h(
				'button',
				{
					type: 'button',
					onClick,
					disabled,
					style: { ...(primary ? styles.primary : styles.ghost), ...(disabled ? styles.disabled : {}) },
				},
				label,
			);
		}

		/**
		 * Mount both composer seats and the `/polish` command listener.
		 * @param ctx - Client plugin context.
		 */
		function apply(ctx) {
			/** Trigger button: reads the draft, opens the overlay. */
			function PolishButton({ sessionId, useInput }) {
				const draft = useInput((state) => state.draft);
				const state = usePolishState(sessionId);
				const [hover, setHover] = React.useState(false);
				const busy = state.phase !== 'idle' && state.phase !== 'error';

				React.useEffect(() => {
					// Remember the line only while it names the command: clearing the
					// composer must not erase the text the command was submitted with.
					if (typeof draft === 'string' && draft.includes(`/${COMMAND}`)) commandLines.set(sessionId, draft);
				}, [draft, sessionId]);

				return h(
					'button',
					{
						type: 'button',
						title: '规范提示词（/polish）',
						'aria-label': '规范提示词',
						disabled: busy,
						onMouseEnter: () => setHover(true),
						onMouseLeave: () => setHover(false),
						onClick: () => start(ctx, sessionId, stripCommand(draft)),
						style: {
							...styles.button,
							...(hover || state.phase !== 'idle' ? styles.buttonActive : {}),
							...(busy ? styles.buttonBusy : {}),
						},
					},
					h(TriggerIcon),
				);
			}

			/** Preview panel: clarification, draft review, and failure states. */
			function PolishOverlay({ sessionId, useInput, inputActions }) {
				const state = usePolishState(sessionId);
				const draft = useInput((current) => current.draft);
				const [answers, setAnswers] = React.useState([]);
				const [feedback, setFeedback] = React.useState('');
				const [rejecting, setRejecting] = React.useState(false);
				const questionKey = state.phase === 'clarifying' ? JSON.stringify(state.questions) : '';

				React.useEffect(() => {
					setAnswers([]);
					setFeedback('');
					setRejecting(false);
				}, [questionKey, state.phase]);

				if (state.phase === 'idle') return null;

				/**
				 * Replace one answer.
				 * @param index - question index.
				 * @param value - the whole answer text.
				 */
				const setAnswer = (index, value) => {
					setAnswers((previous) => {
						const next = [...previous];
						next[index] = value;
						return next;
					});
				};

				/**
				 * Toggle one offered option inside an answer.
				 * @param index - question index.
				 * @param option - the option label.
				 * @param multi - whether the question accepts several options.
				 */
				const toggleOption = (index, option, multi) => {
					setAnswers((previous) => {
						const next = [...previous];
						const current = next[index] ?? '';
						if (!multi) {
							next[index] = current === option ? '' : option;
							return next;
						}
						const parts = current === '' ? [] : current.split('、');
						const at = parts.indexOf(option);
						if (at === -1) parts.push(option);
						else parts.splice(at, 1);
						next[index] = parts.join('、');
						return next;
					});
				};

				const body = [];
				if (state.phase === 'drafting') {
					body.push(h('div', { key: 'busy', style: styles.hint }, '正在转写…'));
				} else if (state.phase === 'clarifying') {
					body.push(h('div', { key: 'lead', style: styles.hint }, '信息还差一点，回答后继续：'));
					state.questions.forEach((question, index) => {
						const options = Array.isArray(question.options) ? question.options : [];
						const answer = answers[index] ?? '';
						body.push(
							h(
								'div',
								{ key: `q${index}`, style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
								h('div', null, question.text ?? question.id ?? `问题 ${index + 1}`),
								options.length === 0
									? null
									: h(
											'div',
											{ style: styles.row },
											options.map((option) =>
												h(
													'button',
													{
														key: option,
														type: 'button',
														onClick: () => toggleOption(index, option, question.multi === true),
														style: {
															...styles.option,
															...(answer.split('、').includes(option) ? styles.optionOn : {}),
														},
													},
													option,
												),
											),
										),
								h('textarea', {
									rows: 2,
									value: answer,
									placeholder: '也可以直接写',
									onChange: (event) => setAnswer(index, event.target.value),
									style: styles.input,
								}),
							),
						);
					});
					body.push(
						h(
							'div',
							{ key: 'actions', style: styles.row },
							h(Action, {
								label: '继续',
								primary: true,
								onClick: () => submitAnswers(ctx, sessionId, state.questions.map((_, index) => answers[index] ?? '')),
							}),
							h(Action, { label: '放弃', onClick: () => dismiss(sessionId) }),
							h('span', { style: styles.hint }, `最多再问 ${Math.max(0, MAX_ROUNDS - state.transcript.length - 1)} 轮`),
						),
					);
				} else if (state.phase === 'review') {
					body.push(h('pre', { key: 'prompt', style: styles.pre }, state.prompt));
					if (state.assumptions.length > 0) {
						body.push(
							h(
								'div',
								{ key: 'assumptions', style: styles.hint },
								`AI 的假设：${state.assumptions.join('；')}`,
							),
						);
					}
					if (typeof draft === 'string' && draft.trim() !== '') {
						body.push(h('div', { key: 'overwrite', style: styles.hint }, '采用后会覆盖输入框现有内容。'));
					}
					if (rejecting) {
						body.push(
							h('textarea', {
								key: 'feedback',
								rows: 2,
								value: feedback,
								placeholder: '哪里不满意？（必填，会带进下一次转写）',
								onChange: (event) => setFeedback(event.target.value),
								style: styles.input,
							}),
						);
					}
					body.push(
						h(
							'div',
							{ key: 'actions', style: styles.row },
							h(Action, { label: '采用', primary: true, onClick: () => adopt(sessionId, inputActions) }),
							rejecting
								? h(Action, {
										label: '重新生成',
										disabled: feedback.trim() === '',
										onClick: () => retry(ctx, sessionId, feedback),
									})
								: h(Action, { label: '不满意，重试', onClick: () => setRejecting(true) }),
							h(Action, { label: '放弃', onClick: () => dismiss(sessionId) }),
						),
					);
				} else if (state.phase === 'error') {
					body.push(h('div', { key: 'message', style: styles.error }, state.message));
					body.push(
						h(
							'div',
							{ key: 'actions', style: styles.row },
							state.code === 'polish/empty-input'
								? null
								: h(Action, { label: '重试', primary: true, onClick: () => retry(ctx, sessionId, '') }),
							h(Action, { label: '关闭', onClick: () => dismiss(sessionId) }),
						),
					);
				}

				return h(
					'div',
					{ style: styles.panel, 'data-polish-overlay': '' },
					h(
						'div',
						{ style: styles.header },
						h('span', null, state.phase === 'review' ? '规范提示词' : '规范提示词 · 转写中'),
						h(
							'button',
							{
								type: 'button',
								onClick: () => dismiss(sessionId),
								style: { ...styles.button, width: '20px', height: '20px' },
								'aria-label': '关闭',
							},
							'✕',
						),
					),
					...body,
				);
			}

			ctx.slots.inject('conversation.input.right', () =>
				ctx.slots.register(
					{
						name: 'conversation.input.right',
						id: 'polish',
						order: 20,
						inject: (sessionId) => ({ sessionId }),
					},
					PolishButton,
				),
			);

			ctx.slots.inject('conversation.input.dock', () =>
				ctx.slots.register(
					{
						name: 'conversation.input.dock',
						id: 'polish',
						order: 20,
						inject: (sessionId) => ({ sessionId }),
					},
					PolishOverlay,
				),
			);

			ctx.on('command/executed', (sessionId, commandName) => {
				if (commandName !== COMMAND) return;
				const line = commandLines.get(sessionId) ?? '';
				commandLines.delete(sessionId);
				start(ctx, sessionId, stripCommand(line));
			});
		}

		return {
			inject: ['slots', 'connection'],
			apply,
		};
	},
});
