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
 * The translation itself runs on the Host behind the plugin's own route, so no
 * part of the user's text or the finished prompt is appended to the session
 * log.
 *
 * The clarification choices deliberately mirror the shipped question composer
 * (`@deepseek-ai/dsh-client-ui-user-questions`): full-width option rows with a
 * number badge for a single choice and a checkbox for a multi choice, plus an
 * inline free-text row carrying the same affordance. That is the shape the user
 * already reads as "the assistant is asking me something".
 *
 * @module dsh-prompt-polish/client
 */

window.__ModuleLoader__.load({
	id: 'dsh-prompt-polish',
	factory(require) {
		const React = require('react');
		const h = React.createElement;

		/**
		 * Host route owned by this plugin. Relative on purpose: it resolves
		 * against the page exactly like the shipped `/api` channel does.
		 */
		const ROUTE = 'polish/translate';
		/** Lowercase command name without the leading slash. */
		const COMMAND = 'polish';
		/** Clarification rounds allowed before the Host is told to settle. */
		const MAX_ROUNDS = 3;

		/**
		 * Browser-declared image types the composer turns into image drafts, and
		 * the only types the Host admits. Anything else in the draft is ignored
		 * here: generic files cannot reach a model as pixels.
		 */
		const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

		/** The closed overlay state. */
		const IDLE = { phase: 'idle' };

		/** One untouched clarification answer. */
		const EMPTY_ANSWER = { options: [], custom: '' };

		/**
		 * Component-local stylesheet, injected once by {@link installStyles}.
		 *
		 * Sizing is deliberately tight: the panel sits directly above the composer
		 * and must not push the conversation around. Width is capped to the chat
		 * content column so it reads as part of the composer, not a page.
		 */
		const CSS = `
.polish-panel{display:flex;flex-direction:column;gap:6px;flex:0 0 auto;width:100%;max-width:var(--dsh-chat-content-width,748px);max-height:45vh;overflow-y:auto;margin:0 auto 6px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg,8px);background:var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.polish-panel *{box-sizing:border-box}
.polish-head{display:flex;align-items:center;justify-content:space-between;gap:6px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.polish-x{width:20px;height:20px;padding:0;border:0;border-radius:999px;background:0 0;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));cursor:pointer;display:grid;place-items:center;font-size:11px}
.polish-x:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary)}
.polish-q{margin:0;font-size:13px;font-weight:500;line-height:20px}
.polish-options{display:flex;flex-direction:column;gap:0;margin:0}
.polish-option{display:flex;align-items:flex-start;gap:6px;width:100%;min-height:26px;padding:3px 8px 3px 6px;border:1px solid transparent;border-radius:var(--dsw-radius-sm,6px);background:0 0;color:inherit;font:inherit;text-align:left;cursor:pointer;transition:background-color .12s,border-color .12s}
.polish-option:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.polish-option[data-selected="true"]{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));border-color:var(--dsw-alias-border-l2)}
.polish-mark{flex:0 0 16px;width:16px;height:16px;margin-top:2px;display:grid;place-items:center;border-radius:var(--dsw-radius-xs,3px);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-secondary);font-size:10px;font-weight:500;line-height:14px}
.polish-mark[data-checkbox="true"]{background:0 0;border:.5px solid var(--dsw-alias-border-l1)}
.polish-mark[data-checked="true"]{background:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base)}
.polish-label{flex:1;min-width:0;font-size:13px;line-height:20px}
.polish-custom{display:flex;align-items:flex-start;gap:6px;width:100%;min-height:26px;padding:3px 8px 3px 6px;border:1px solid transparent;border-radius:var(--dsw-radius-sm,6px);transition:background-color .12s,border-color .12s}
.polish-custom[data-active="true"],.polish-custom:focus-within{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));border-color:var(--dsw-alias-border-l2)}
.polish-input{flex:1;min-width:0;margin-top:2px;padding:0;border:0;outline:0;background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;resize:none}
.polish-input::placeholder{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
.polish-block{width:100%;padding:5px 8px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;outline:0;resize:vertical}
.polish-block:focus{border-color:var(--dsw-alias-brand-primary)}
.polish-pre{margin:0;padding:6px 8px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-2);font-family:inherit;font-size:13px;line-height:20px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:160px;overflow-y:auto}
.polish-hint{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.polish-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.polish-foot{display:flex;align-items:center;flex-wrap:wrap;gap:6px}
.polish-btn{padding:2px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,6px);background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.polish-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.polish-btn:disabled{opacity:.5;cursor:not-allowed}
.polish-btn-primary{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
.polish-trigger{width:26px;height:26px;padding:0;display:grid;place-items:center;border:1px solid transparent;border-radius:var(--dsw-radius-sm,6px);background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer}
.polish-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary)}
.polish-trigger[data-active="true"]{color:var(--dsw-alias-brand-primary)}
.polish-trigger:disabled{opacity:.5;cursor:progress}
`;

		/**
		 * Inject the stylesheet once per document, imperatively.
		 *
		 * It must NOT be a React element: a render-phase `document.querySelector`
		 * guard makes the tag appear on one render and disappear on the next, so
		 * every keystroke in the composer (which re-renders the trigger button)
		 * toggles the whole stylesheet — the visible symptom is a flickering
		 * button and a hover state that appears to stick.
		 *
		 * @param ctx - Client plugin context, for disposal.
		 */
		function installStyles(ctx) {
			ctx.effect(() => {
				if (typeof document === 'undefined') return () => {};
				if (document.querySelector('style[data-polish-css]') !== null) return () => {};
				const tag = document.createElement('style');
				tag.setAttribute('data-polish-css', '');
				tag.textContent = CSS;
				document.head.append(tag);
				return () => {
					tag.remove();
				};
			}, 'polish: stylesheet');
		}

		/**
		 * One overlay state per Session. Kept outside React so the trigger button
		 * and the overlay read the same value without prop drilling.
		 */
		const states = new Map();
		/** Subscribers re-read the whole map on any change. */
		const subscribers = new Set();
		/**
		 * Remember (or forget) the pictures an existing `/polish` line will carry.
		 *
		 * A command submission consumes the composer's draft rail, so the Files
		 * have to be captured while the line still names the command. An empty
		 * rail while the line is still typed means the user removed the pictures,
		 * and forgetting them is what stops a later submission from sending
		 * pictures the user had already taken back.
		 *
		 * @param memory - the per-Session picture map.
		 * @param sessionId - the Session.
		 * @param files - pictures currently in the rail.
		 */
		function rememberCommandImages(memory, sessionId, files) {
			if (Array.isArray(files) && files.length > 0) memory.set(sessionId, files);
			else memory.delete(sessionId);
		}

		/** Last composer line that named `/polish`, per Session. */
		const commandLines = new Map();
		/**
		 * Pictures that were attached when the last `/polish` line was typed, per
		 * Session. A submitted command consumes the draft rail, so the Files have
		 * to be captured before that hand-over; see the button component's effect.
		 */
		const commandImages = new Map();

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
		 * Resolve draft attachment ids to their live browser descriptors.
		 *
		 * The Conversation service owns the draft rail; a plugin only ever sees
		 * the ids. Any failure degrades to "no attachments" — a picture that
		 * cannot be read must not cost the user their text.
		 *
		 * The service is resolved lazily through `get` rather than injected, so
		 * this half keeps working if the Conversation bundle loads it in either
		 * order.
		 *
		 * @param ctx - Client plugin context.
		 * @param ids - attachment ids from the input state.
		 * @returns the live descriptors, in input order.
		 */
		function draftAttachmentsOf(ctx, ids) {
			if (!Array.isArray(ids) || ids.length === 0) return [];
			try {
				const resolved = ctx.get('conversation')?.resolveDraftAttachments?.(ids);
				return Array.isArray(resolved) ? resolved : [];
			} catch {
				return [];
			}
		}

		/**
		 * Keep only the pictures among the composer's draft attachments.
		 * @param attachments - live draft descriptors.
		 * @returns the image descriptors, in input order.
		 */
		function imageDraftsOf(attachments) {
			return (Array.isArray(attachments) ? attachments : []).filter(
				(attachment) =>
					attachment?.kind === 'image' && attachment.file !== undefined && IMAGE_MEDIA_TYPES.has(attachment.file.type),
			);
		}

		/**
		 * Canonical base64 of a byte array.
		 * @param bytes - the encoded file bytes.
		 * @returns base64 text without a data-URL prefix.
		 */
		function base64Of(bytes) {
			let binary = '';
			// Chunked so a large screenshot cannot blow the argument limit.
			const chunk = 0x8000;
			for (let index = 0; index < bytes.length; index += chunk) {
				binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
			}
			return btoa(binary);
		}

		/**
		 * Encode one browser image file into the wire part the Host admits.
		 * @param file - the browser File behind one image draft.
		 * @returns the encoded image part.
		 */
		async function encodeImageFile(file) {
			const bytes = new Uint8Array(await file.arrayBuffer());
			return {
				mediaType: file.type,
				data: base64Of(bytes),
				...(typeof file.name === 'string' && file.name !== '' ? { name: file.name } : {}),
			};
		}

		/**
		 * Encode already-captured image files.
		 * @param files - browser Files kept from an earlier draft snapshot.
		 * @returns encoded image parts, in input order.
		 */
		async function encodeImageFiles(files) {
			return await Promise.all((Array.isArray(files) ? files : []).map((file) => encodeImageFile(file)));
		}

		/**
		 * Read the composer draft straight from the Session input shell.
		 *
		 * Only the command action path needs this: the decoration runs after the
		 * trigger token was consumed, so it cannot read the draft from a rendered
		 * component. Failures degrade to an empty draft.
		 *
		 * @param ctx - Client plugin context.
		 * @param sessionId - the Session.
		 * @returns the draft text, or an empty string.
		 */
		function composerDraft(ctx, sessionId) {
			try {
				const actx = ctx.get('sessions')?.scope?.(sessionId);
				if (actx === undefined) return '';
				const snapshot = ctx.get('conversation')?.input?.for?.(actx)?.snapshot;
				return typeof snapshot?.draft === 'string' ? snapshot.draft : '';
			} catch {
				return '';
			}
		}

		/**
		 * Read the composer's current draft pictures straight from the input state.
		 * @param ctx - Client plugin context.
		 * @param sessionId - the Session.
		 * @returns browser Files for each image draft, in rail order.
		 */
		function composerImageFiles(ctx, sessionId) {
			try {
				const actx = ctx.get('sessions')?.scope?.(sessionId);
				if (actx === undefined) return [];
				const snapshot = ctx.get('conversation')?.input?.for?.(actx)?.snapshot;
				return imageDraftsOf(draftAttachmentsOf(ctx, snapshot?.attachmentIds)).map((draft) => draft.file);
			} catch {
				return [];
			}
		}

		/**
		 * Put pictures back into the composer after a command submission consumed
		 * them.
		 *
		 * The shipped submit transaction releases an accepting command's draft
		 * attachments once the handler settles, which would leave the user with a
		 * polished prompt and no pictures. Re-registering the same Files restores
		 * the rail; the retry covers the hand-over: the release happens inside the
		 * same settle tick, so the first attempt can still see a locked phase.
		 *
		 * @param ctx - Client plugin context.
		 * @param sessionId - the Session.
		 * @param files - browser Files captured from the consumed draft.
		 */
		function restoreDraftImages(ctx, sessionId, files) {
			if (!Array.isArray(files) || files.length === 0) return;
			let drafts;
			let attempts = 0;
			const attempt = () => {
				attempts += 1;
				try {
					const conversation = ctx.get('conversation');
					if (drafts === undefined) drafts = conversation?.createDrafts?.(sessionId, files) ?? [];
					if (drafts.length === 0) return;
					const actx = ctx.get('sessions')?.scope?.(sessionId);
					if (actx === undefined) return;
					if (conversation.input.for(actx).addAttachments(drafts.map((draft) => draft.id))) return;
				} catch {
					return;
				}
				if (attempts >= 4) return;
				setTimeout(attempt, 25);
			};
			setTimeout(attempt, 0);
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
		 * Whether one question accepts several options. The Host prompt asks for
		 * `multi`; the shipped question schema calls the same idea `multiSelect`,
		 * so both spellings are honored rather than trusting one.
		 * @param question - the question payload.
		 * @returns true when several options may be chosen.
		 */
		function isMulti(question) {
			return question?.multiSelect === true || question?.multi === true;
		}

		/**
		 * Flatten one answer slot into the single string the Host receives.
		 * @param answer - the slot, or undefined when untouched.
		 * @returns chosen options plus free text, joined.
		 */
		function serializeAnswer(answer) {
			const slot = answer ?? EMPTY_ANSWER;
			return [...slot.options, slot.custom.trim()].filter((part) => part !== '').join('、');
		}

		/**
		 * Run one translation and settle the overlay into its next state.
		 * @param ctx - Client plugin context.
		 * @param sessionId - the Session.
		 * @param state - the state this request belongs to; a newer state discards the reply.
		 */
		async function run(ctx, sessionId, state) {
			try {
				// Encoding happens per attempt, not once: the browser Files stay
				// readable for the life of the Session scope, so a retry or a
				// clarification round resends the same pictures without a second
				// capture, and a rejected request never leaves stale bytes behind.
				// The text-only path deliberately encodes nothing and stays
				// synchronous, so a plain request is not delayed by a microtask.
				let images = [];
				if (Array.isArray(state.imageFiles) && state.imageFiles.length > 0) {
					try {
						images = await encodeImageFiles(state.imageFiles);
					} catch (error) {
						if (state.controller.signal.aborted) return;
						if (readState(sessionId) !== state) return;
						writeState(sessionId, {
							...state,
							phase: 'error',
							code: 'polish/bad-image',
							message: error instanceof Error ? error.message : String(error),
						});
						return;
					}
				}
				const response = await fetch(ROUTE, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						sessionId,
						text: state.source,
						transcript: state.transcript,
						rounds: state.rounds ?? 0,
						feedback: state.feedback ?? '',
						...(images.length > 0 ? { images } : {}),
					}),
					signal: state.controller.signal,
				});
				if (!response.ok) {
					if (readState(sessionId) !== state) return;
					writeState(sessionId, {
						...state,
						phase: 'error',
						code: 'polish/transport-error',
						message: `转写接口返回 HTTP ${response.status}`,
					});
					return;
				}
				const result = await response.json();
				if (readState(sessionId) !== state) return;
				if (!result.ok) {
					writeState(sessionId, { ...state, phase: 'error', code: result.error.code, message: result.error.message });
					return;
				}
				const value = result.value;
				if (value?.kind === 'questions') {
					// The round cap is a product decision, so it is enforced here and
					// not merely requested in the prompt. It counts the rounds spent by
					// THIS attempt: rejecting an output resets the budget (see `retry`),
					// so a user who wants more clarification can always get it.
					if ((state.rounds ?? 0) >= MAX_ROUNDS) {
						writeState(sessionId, {
							...state,
							phase: 'error',
							code: 'polish/round-limit',
							message: `已经问满 ${MAX_ROUNDS} 轮澄清，模型仍在追问。重试会让它直接出稿。`,
						});
						return;
					}
					writeState(sessionId, {
						...state,
						phase: 'clarifying',
						questions: value.questions,
						rounds: (state.rounds ?? 0) + 1,
					});
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
		 * Start (or restart) a translation from one explicit source text.
		 *
		 * Keeping the transcript separate is what lets an error retry resume after
		 * clarification instead of throwing the rounds away.
		 *
		 * @param ctx - Client plugin context.
		 * @param sessionId - the Session.
		 * @param source - the rough text, already trimmed.
		 * @param transcript - clarification rounds to carry into this attempt.
		 * @param rounds - clarification rounds this attempt has already spent.
		 * @param imageFiles - browser Files captured from the composer's draft rail.
		 */
		function translateWith(ctx, sessionId, source, transcript, rounds = 0, imageFiles = []) {
			const previous = readState(sessionId);
			if (previous.controller !== undefined) previous.controller.abort();
			const state = {
				phase: 'drafting',
				source,
				transcript: Array.isArray(transcript) ? transcript : [],
				rounds: Number.isFinite(rounds) ? rounds : 0,
				feedback: '',
				imageFiles: Array.isArray(imageFiles) ? imageFiles : [],
				controller: new AbortController(),
			};
			writeState(sessionId, state);
			void run(ctx, sessionId, state);
		}

		/**
		 * Open the overlay for one Session.
		 *
		 * With text in hand it starts translating; with none it opens the panel in
		 * its input phase, so the rough request can be typed right there instead of
		 * sending the user back to the composer.
		 *
		 * Pictures already in the composer ride along either way: they are part of
		 * what the user is asking about, so opening the panel must not silently
		 * detach them.
		 *
		 * @param ctx - Client plugin context.
		 * @param sessionId - the Session.
		 * @param text - the rough text, possibly empty.
		 * @param imageFiles - browser Files captured from the composer's draft rail.
		 */
		function start(ctx, sessionId, text, imageFiles = []) {
			const source = typeof text === 'string' ? text.trim() : '';
			const files = Array.isArray(imageFiles) ? imageFiles : [];
			if (source === '') {
				const previous = readState(sessionId);
				if (previous.controller !== undefined) previous.controller.abort();
				writeState(sessionId, { phase: 'input', source: '', imageFiles: files });
				return;
			}
			translateWith(ctx, sessionId, source, [], 0, files);
		}

		/**
		 * Continue after one clarification round.
		 * @param ctx - Client plugin context.
		 * @param sessionId - the Session.
		 * @param answers - one serialized answer per question, in question order.
		 */
		function submitAnswers(ctx, sessionId, answers) {
			const state = readState(sessionId);
			if (state.phase !== 'clarifying') return;
			const transcript = [...state.transcript, { questions: state.questions, answers }];
			const next = {
				phase: 'drafting',
				source: state.source,
				transcript,
				// The budget was already charged when the questions were shown.
				rounds: state.rounds ?? 0,
				feedback: '',
				// The pictures were captured at trigger time; every later round of
				// the same attempt keeps them, so the model never loses the image it
				// is asking questions about.
				imageFiles: state.imageFiles ?? [],
				controller: new AbortController(),
			};
			writeState(sessionId, next);
			void run(ctx, sessionId, next);
		}

		/**
		 * Ask for another draft, carrying the user's reason for rejecting the last one.
		 *
		 * Rejecting an output also opens a **fresh clarification budget**. The cap
		 * exists to stop the model from interrogating forever; it must not stop the
		 * user from asking again after an output missed the mark. The transcript is
		 * still carried, so the model keeps every answer already given. An error
		 * retry is different: nothing was rejected, so the budget stays spent.
		 *
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
				rounds: state.phase === 'review' ? 0 : (state.rounds ?? 0),
				feedback: typeof feedback === 'string' ? feedback.trim() : '',
				// A retry is the same request, so the pictures stay with it.
				imageFiles: state.imageFiles ?? [],
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

		/** The trigger glyph: a small sparkle, drawn in currentColor. */
		function TriggerIcon() {
			return h(
				'svg',
				{ viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true, fill: 'currentColor' },
				h('path', { d: 'M8 1.2l1.5 4.1 4.1 1.5-4.1 1.5L8 12.4 6.5 8.3 2.4 6.8l4.1-1.5L8 1.2z' }),
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
					className: `polish-btn${primary ? ' polish-btn-primary' : ''}`,
					onClick,
					disabled,
				},
				label,
			);
		}

		/**
		 * Mount both composer seats and the `/polish` command listener.
		 * @param ctx - Client plugin context.
		 */
		function apply(ctx) {
			installStyles(ctx);

			/** Trigger button: reads the draft and its pictures, opens the overlay. */
			function PolishButton({ sessionId, useInput }) {
				const draft = useInput((state) => state.draft);
				const attachmentIds = useInput((state) => state.attachmentIds);
				const state = usePolishState(sessionId);
				const busy = state.phase !== 'idle' && state.phase !== 'error';

				React.useEffect(() => {
					// Remember the line only while it names the command: clearing the
					// composer must not erase the text the command was submitted with.
					if (typeof draft === 'string' && draft.includes(`/${COMMAND}`)) commandLines.set(sessionId, draft);
				}, [draft, sessionId]);

				React.useEffect(() => {
					// Pictures vanish from the rail once a command submission consumes
					// them, so the last set seen while the line still names `/polish` is
					// what that invocation should translate. Capturing the live Files
					// here (not the ids) is what survives the rail release.
					if (typeof draft !== 'string' || !draft.includes(`/${COMMAND}`)) return;
					rememberCommandImages(
						commandImages,
						sessionId,
						imageDraftsOf(draftAttachmentsOf(ctx, attachmentIds)).map((item) => item.file),
					);
				}, [draft, attachmentIds, sessionId]);

				return h(
					'button',
					{
						type: 'button',
						className: 'polish-trigger',
						'data-active': state.phase !== 'idle' ? 'true' : 'false',
						title: '规范提示词（/polish）',
						'aria-label': '规范提示词',
						disabled: busy,
						onClick: () =>
							start(
								ctx,
								sessionId,
								stripCommand(draft),
								imageDraftsOf(draftAttachmentsOf(ctx, attachmentIds)).map((item) => item.file),
							),
					},
					h(TriggerIcon),
				);
			}

			/** Preview panel: clarification, draft review, and failure states. */
			function PolishOverlay({ sessionId, useInput, inputActions }) {
				const state = usePolishState(sessionId);
				const draft = useInput((current) => current.draft);
				const [rejecting, setRejecting] = React.useState(false);
				const [feedback, setFeedback] = React.useState('');

				// Reset the per-question drafts and the editable source whenever the
				// question set or the phase changes. Done during render (React's
				// documented "adjust state when a prop changes" pattern) rather than in
				// an effect, so a keystroke can never race the reset and be swallowed.
				const signature =
					state.phase === 'clarifying'
						? `clarify:${JSON.stringify(state.questions)}`
						: state.phase === 'input' || state.phase === 'error'
							? `${state.phase}:${state.source ?? ''}`
							: state.phase;
				const [draftSignature, setDraftSignature] = React.useState(signature);
				const [answers, setAnswers] = React.useState([]);
				const [sourceDraft, setSourceDraft] = React.useState(state.source ?? '');
				if (draftSignature !== signature) {
					setDraftSignature(signature);
					setAnswers([]);
					setFeedback('');
					setRejecting(false);
					setSourceDraft(state.source ?? '');
				}

				if (state.phase === 'idle') return null;

				/**
				 * Replace one answer slot.
				 * @param index - question index.
				 * @param next - the whole slot.
				 */
				const setSlot = (index, next) => {
					setAnswers((previous) => {
						const updated = [...previous];
						updated[index] = next;
						return updated;
					});
				};

				/**
				 * Toggle one offered option inside an answer slot.
				 * @param index - question index.
				 * @param option - the option label.
				 * @param multi - whether the question accepts several options.
				 */
				const toggleOption = (index, option, multi) => {
					const slot = answers[index] ?? EMPTY_ANSWER;
					const chosen = slot.options.includes(option);
					const options = multi
						? chosen
							? slot.options.filter((item) => item !== option)
							: [...slot.options, option]
						: chosen
							? []
							: [option];
					setSlot(index, { ...slot, options });
				};

				const body = [];
				if (state.phase === 'drafting') {
					body.push(h('div', { key: 'busy', className: 'polish-hint' }, '正在转写…'));
				} else if (state.phase === 'clarifying') {
					state.questions.forEach((question, index) => {
						const options = Array.isArray(question.options) ? question.options : [];
						const multi = isMulti(question);
						const slot = answers[index] ?? EMPTY_ANSWER;
						const chosen = (option) => slot.options.includes(option);
						body.push(
							h('div', { key: `q${index}`, className: 'polish-options' }, [
								h('p', { key: 'text', className: 'polish-q' }, question.text ?? question.id ?? `问题 ${index + 1}`),
								...options.map((option, optionIndex) =>
									h(
										'button',
										{
											key: `opt${optionIndex}`,
											type: 'button',
											className: 'polish-option',
											'data-selected': !multi && chosen(option) ? 'true' : 'false',
											onClick: () => toggleOption(index, option, multi),
										},
										h(
											'span',
											{
												className: 'polish-mark',
												'data-checkbox': multi ? 'true' : 'false',
												'data-checked': multi && chosen(option) ? 'true' : 'false',
												'aria-hidden': true,
											},
											multi ? (chosen(option) ? '✓' : '') : String(optionIndex + 1),
										),
										h('span', { className: 'polish-label' }, option),
									),
								),
								h(
									'div',
									{
										key: 'custom',
										className: 'polish-custom',
										'data-active': slot.custom.trim() === '' ? 'false' : 'true',
									},
									h(
										'span',
										{
											className: 'polish-mark',
											'data-checkbox': multi ? 'true' : 'false',
											'data-checked': multi && slot.custom.trim() !== '' ? 'true' : 'false',
											'aria-hidden': true,
										},
										multi ? (slot.custom.trim() === '' ? '' : '✓') : '✎',
									),
									h('textarea', {
										className: 'polish-input',
										rows: 1,
										value: slot.custom,
										placeholder: options.length > 0 ? '也可以直接写' : '写下你的回答',
										onChange: (event) => setSlot(index, { ...slot, custom: event.target.value }),
									}),
								),
							]),
						);
					});
					body.push(
						h('div', { key: 'actions', className: 'polish-foot' }, [
							h(Action, {
								key: 'go',
								label: '继续',
								primary: true,
								onClick: () =>
									submitAnswers(
										ctx,
										sessionId,
										state.questions.map((_, index) => serializeAnswer(answers[index])),
									),
							}),
							h(Action, { key: 'drop', label: '放弃', onClick: () => dismiss(sessionId) }),
							h(
								'span',
								{ key: 'left', className: 'polish-hint' },
								`最多再问 ${Math.max(0, MAX_ROUNDS - state.transcript.length - 1)} 轮`,
							),
						]),
					);
				} else if (state.phase === 'review') {
					body.push(h('pre', { key: 'prompt', className: 'polish-pre' }, state.prompt));
					if (state.assumptions.length > 0) {
						body.push(h('div', { key: 'assumptions', className: 'polish-hint' }, `AI 的假设：${state.assumptions.join('；')}`));
					}
					if (typeof draft === 'string' && draft.trim() !== '') {
						body.push(h('div', { key: 'overwrite', className: 'polish-hint' }, '采用后会覆盖输入框现有内容。'));
					}
					if (rejecting) {
						body.push(
							h('textarea', {
								key: 'feedback',
								className: 'polish-block',
								rows: 2,
								value: feedback,
								placeholder: '哪里不满意？（必填，会带进下一次转写）',
								onChange: (event) => setFeedback(event.target.value),
							}),
						);
					}
					body.push(
						h('div', { key: 'actions', className: 'polish-foot' }, [
							h(Action, { key: 'adopt', label: '采用', primary: true, onClick: () => adopt(sessionId, inputActions) }),
							rejecting
								? h(Action, {
										key: 'regen',
										label: '重新生成',
										disabled: feedback.trim() === '',
										onClick: () => retry(ctx, sessionId, feedback),
									})
								: h(Action, { key: 'reject', label: '不满意，重试', onClick: () => setRejecting(true) }),
							h(Action, { key: 'drop', label: '放弃', onClick: () => dismiss(sessionId) }),
						]),
					);
				} else if (state.phase === 'input' || state.phase === 'error') {
					if (state.phase === 'error') {
						body.push(h('div', { key: 'message', className: 'polish-error' }, state.message));
					}
					body.push(
						h('textarea', {
							key: 'source',
							className: 'polish-block',
							rows: 2,
							value: sourceDraft,
							placeholder: '输入你的需求',
							onChange: (event) => setSourceDraft(event.target.value),
						}),
					);
					body.push(
						h('div', { key: 'actions', className: 'polish-foot' }, [
							h(Action, {
								key: 'go',
								label: '转写',
								primary: true,
								disabled: sourceDraft.trim() === '',
								// An error retry keeps the clarification rounds already earned;
								// a first attempt from the input phase starts with none. Either
								// way the pictures captured at trigger time stay attached.
								onClick: () =>
									translateWith(
										ctx,
										sessionId,
										sourceDraft.trim(),
										state.transcript ?? [],
										state.rounds ?? 0,
										state.imageFiles ?? [],
									),
							}),
							h(Action, { key: 'close', label: '关闭', onClick: () => dismiss(sessionId) }),
						]),
					);
				}

				const heading =
					state.phase === 'review'
						? '规范提示词'
						: state.phase === 'clarifying'
							? '规范提示词 · 需要澄清'
							: state.phase === 'drafting'
								? '规范提示词 · 转写中'
								: state.phase === 'input'
									? '规范提示词 · 输入请求'
									: '规范提示词 · 未完成';

				return h(
					'div',
					{ className: 'polish-panel', 'data-polish-overlay': '', onMouseDown: (event) => event.stopPropagation() },
					h(
						'div',
						{ className: 'polish-head' },
						h('span', null, heading),
						h('button', { type: 'button', className: 'polish-x', 'aria-label': '关闭', onClick: () => dismiss(sessionId) }, '✕'),
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

			// The Host command declares `input.attachments: true` so a submission
			// carrying pictures clears the composer's envelope gate, but a claiming
			// command is also what inserts a command chip and waits for the args —
			// the wrong shape for a one-shot action. This decoration makes the bare
			// `/polish` invocation an action instead: the token is consumed, nothing
			// is submitted, and the pictures therefore stay in the composer's rail.
			// An argued `/polish <text>` never reaches a decoration (the shipped
			// adjudicator only decorates the bare token), so that path still claims
			// the line and the remembered-pictures hand-over below covers it.
			//
			// Waiting on the service through `ctx.inject` (rather than reading
			// `ctx.commandUi`) is what the shipped plugins do: `commandUi` is not in
			// this plugin's `inject` list, and a bare property read of a service the
			// plugin never declared throws instead of yielding undefined.
			ctx.inject(['commandUi'], (scope) => {
				scope.effect(
					() =>
						scope.commandUi.decorate({
							name: COMMAND,
							available: (session) => session !== undefined,
							ui: {
								kind: 'action',
								run: (session) => {
									const sessionId = session?.sessionId;
									if (sessionId === undefined) return;
									// The token was just consumed, so the draft no longer names
									// the command; the remembered line is the one that did.
									const line = commandLines.get(sessionId) ?? composerDraft(ctx, sessionId);
									commandLines.delete(sessionId);
									const files = commandImages.get(sessionId) ?? composerImageFiles(ctx, sessionId);
									commandImages.delete(sessionId);
									start(ctx, sessionId, stripCommand(line), files);
								},
							},
						}),
					'polish: /polish action decoration',
				);
			});

			ctx.on('command/executed', (sessionId, commandName, result) => {
				if (commandName !== COMMAND) return;
				const line = commandLines.get(sessionId) ?? '';
				commandLines.delete(sessionId);
				const files = commandImages.get(sessionId) ?? [];
				commandImages.delete(sessionId);
				// Only a *successful* submission consumes the composer's pictures: the
				// shipped submit transaction clears the rail and releases the
				// attachments on success alone. Restoring on a failed submission would
				// register the same File a second time, so the user would see the
				// picture twice. On failure the rail still holds the originals, which
				// is exactly what the user needs to correct and retry.
				if (result?.kind !== 'error') restoreDraftImages(ctx, sessionId, files);
				start(ctx, sessionId, stripCommand(line), files);
			});
		}

		return {
			// No `connection`: the Host call is a plain same-origin fetch.
			inject: ['slots'],
			apply,
			// Test seam. The browser module loader hands out only this factory, so
			// the pure state machine and the serialization helpers have no other
			// way to be reached from `test/client.test.js`. Nothing in the running
			// app reads this property.
			__internals: {
				ROUTE,
				COMMAND,
				MAX_ROUNDS,
				IDLE,
				EMPTY_ANSWER,
				readState,
				writeState,
				subscribe,
				stripCommand,
				isMulti,
				serializeAnswer,
				imageDraftsOf,
				encodeImageFiles,
				rememberCommandImages,
				commandImages,
				run,
				start,
				translateWith,
				submitAnswers,
				retry,
				dismiss,
				adopt,
			},
		};
	},
});
