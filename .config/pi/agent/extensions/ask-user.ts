/**
 * ask-user — global pi extension providing a Claude Code-style AskUserQuestion tool
 *
 * Registers a custom tool `ask_user` that lets the agent ask the user 1-4
 * clarifying questions, each with 2-4 concrete options shown in an interactive
 * TUI selector (arrow-key navigation, optional multi-select, automatic
 * free-text escape hatch).
 *
 * Schema (per question):
 *   - question     full question text
 *   - header       very short tab/chip label (truncated to 12 chars)
 *   - multiSelect  allow choosing several options (default: false)
 *   - options[2-4] { label, description?, recommended? }
 *
 * UX:
 *   - Single question → flat options list; Enter submits immediately
 *   - Multiple questions → tab wizard with answered-state checkboxes and a
 *     gated "✓ Submit" tab (all questions must be answered)
 *   - multiSelect questions: Space toggles options, Enter finishes the question
 *   - Every question gets an automatic "Type something." free-text row
 *     (inline editor; Esc returns to the options, Esc on the list cancels)
 *   - `recommended: true` options are marked "(recommended)" in accent color
 *
 * Cancellation (Esc) returns a well-formed "cancelled" tool result rather than
 * throwing, so the agent can gracefully fall back to its best judgment.
 *
 * Non-TUI modes (print/json/rpc) return an explicit "UI not available" result.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

// --- types -----------------------------------------------------------------

interface AskOption {
	label: string;
	description?: string;
	recommended?: boolean;
}

type DisplayOption = AskOption & { isOther?: boolean };

interface AskQuestion {
	id: string;
	header: string;
	question: string;
	multiSelect: boolean;
	options: AskOption[];
}

interface SelectedValue {
	label: string;
	wasCustom: boolean;
	index?: number;
}

interface QuestionAnswer {
	id: string;
	header: string;
	question: string;
	multiSelect: boolean;
	values: SelectedValue[];
}

interface AskUserDetails {
	questions: AskQuestion[];
	answers: QuestionAnswer[];
	cancelled: boolean;
}

// --- schema ----------------------------------------------------------------

const OptionSchema = Type.Object({
	label: Type.String({ description: "Concise display label, 1-5 words" }),
	description: Type.Optional(
		Type.String({ description: "Trade-offs / implications shown under the label" }),
	),
	recommended: Type.Optional(
		Type.Boolean({ description: "Mark this option as the suggested default" }),
	),
});

const QuestionSchema = Type.Object({
	id: Type.Optional(
		Type.String({ description: "Stable identifier used in the returned answers (default: q1, q2, ...)" }),
	),
	question: Type.String({
		description: "The full question text; include any context the user needs to decide",
	}),
	header: Type.Optional(
		Type.String({ description: "Very short tab/chip label, e.g. 'Auth method' (max ~12 chars)" }),
	),
	multiSelect: Type.Optional(
		Type.Boolean({ description: "Allow selecting multiple options (default: false)" }),
	),
	options: Type.Array(OptionSchema, {
		minItems: 2,
		maxItems: 4,
		description: "2-4 concrete options to choose from",
	}),
});

const AskUserParams = Type.Object({
	questions: Type.Array(QuestionSchema, {
		minItems: 1,
		maxItems: 4,
		description: "1-4 questions to ask the user",
	}),
});

// --- helpers ---------------------------------------------------------------

function errorResult(message: string): { content: { type: "text"; text: string }[]; details: AskUserDetails } {
	return {
		content: [{ type: "text", text: message }],
		details: { questions: [], answers: [], cancelled: true },
	};
}

/** Normalize raw params: defaults for id/header, unique ids, capped headers. */
function normalizeQuestions(raw: Array<{
	id?: string;
	question: string;
	header?: string;
	multiSelect?: boolean;
	options: AskOption[];
}>): AskQuestion[] {
	const seen = new Set<string>();
	return raw.map((q, i) => {
		let id = q.id?.trim() || `q${i + 1}`;
		while (seen.has(id)) id = `${id}_${i + 1}`;
		seen.add(id);
		const header = (q.header?.trim() || `Q${i + 1}`).slice(0, 12);
		return {
			id,
			header,
			question: q.question,
			multiSelect: q.multiSelect === true,
			options: q.options,
		};
	});
}

function formatAnswerLine(a: QuestionAnswer): string {
	const parts = a.values.map((v) =>
		v.wasCustom ? `(wrote) ${v.label}` : v.index ? `${v.index}. ${v.label}` : v.label,
	);
	if (a.multiSelect && parts.length > 1) {
		return `${a.header}: user selected: ${parts.join(", ")}`;
	}
	return `${a.header}: user selected: ${parts[0]}`;
}

// --- extension -------------------------------------------------------------

export default function askUser(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description:
			"Ask the user one or more clarifying questions with multiple-choice options. " +
			"Use when there is genuine ambiguity with 2+ viable approaches, a trade-off decision, " +
			"or a preference you must not assume. Batch related questions (up to 4) into one call " +
			"instead of interrupting repeatedly. The user can always pick an option, type a custom " +
			"answer, or cancel.",
		promptSnippet: "Ask the user clarifying questions with multiple-choice options",
		promptGuidelines: [
			"Use ask_user when genuine ambiguity blocks progress and plain guessing would be wrong; batch up to 4 related questions into one call.",
			"In ask_user options, keep labels to 1-5 words, put trade-offs in descriptions, and mark exactly one option recommended when one stands out.",
			"Do not use ask_user for trivia answerable from repo context or for questions with one obviously-correct choice.",
		],
		parameters: AskUserParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") {
				return errorResult("Error: UI not available (running in non-interactive mode)");
			}
			if (signal?.aborted) {
				return errorResult("Cancelled");
			}

			const questions = normalizeQuestions(params.questions);

			const result = await ctx.ui.custom<AskUserDetails>((tui, theme, _kb, done) => {
				// State
				let currentTab = 0;
				let optionIndex = 0;
				let inputMode = false;
				let inputQuestionId: string | null = null;
				let cachedLines: string[] | undefined;
				const finished = new Map<string, QuestionAnswer>();
				// multiSelect toggle state, per question id -> selected option indices
				const toggled = new Map<string, Set<number>>();
				// free-text answers collected before finishing a multiSelect question
				const customs = new Map<string, string[]>();

				const totalTabs = questions.length + 1; // questions + Submit

				const editorTheme: EditorTheme = {
					borderColor: (s) => theme.fg("accent", s),
					selectList: {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					},
				};
				const editor = new Editor(tui, editorTheme);

				function refresh() {
					cachedLines = undefined;
					tui.requestRender();
				}

				function submit(cancelled: boolean) {
					const answers: QuestionAnswer[] = [];
					for (const q of questions) {
						const answer = finished.get(q.id);
						if (answer) answers.push(answer);
					}
					done({ questions, answers, cancelled });
				}

				function currentQuestion(): AskQuestion | undefined {
					return questions[currentTab];
				}

				function currentOptions(): DisplayOption[] {
					const q = currentQuestion();
					if (!q) return [];
					const opts: DisplayOption[] = [...q.options];
					opts.push({ label: "Type something.", isOther: true });
					return opts;
				}

				function allAnswered(): boolean {
					return questions.every((q) => finished.has(q.id));
				}

				function buildAnswer(q: AskQuestion): QuestionAnswer {
					const values: SelectedValue[] = [];
					const picks = toggled.get(q.id);
					if (picks) {
						for (const i of [...picks].sort((a, b) => a - b)) {
							values.push({ label: q.options[i].label, wasCustom: false, index: i + 1 });
						}
					}
					for (const label of customs.get(q.id) ?? []) {
						values.push({ label, wasCustom: true });
					}
					return {
						id: q.id,
						header: q.header,
						question: q.question,
						multiSelect: q.multiSelect,
						values,
					};
				}

				function finishQuestion(q: AskQuestion) {
					finished.set(q.id, buildAnswer(q));
					toggled.delete(q.id);
					customs.delete(q.id);
				}

				function advanceAfterAnswer() {
					if (questions.length === 1) {
						submit(false);
						return;
					}
					if (currentTab < questions.length - 1) {
						currentTab++;
					} else {
						currentTab = questions.length; // Submit tab
					}
					optionIndex = 0;
					refresh();
				}

				editor.onSubmit = (value) => {
					if (!inputQuestionId) return;
					const trimmed = value.trim();
					if (!trimmed) {
						inputMode = false;
						inputQuestionId = null;
						editor.setText("");
						refresh();
						return;
					}
					const q = questions.find((cand) => cand.id === inputQuestionId);
					if (!q) return;
					if (q.multiSelect) {
						const list = customs.get(q.id) ?? [];
						list.push(trimmed);
						customs.set(q.id, list);
						inputMode = false;
						inputQuestionId = null;
						editor.setText("");
						refresh();
					} else {
						finished.set(q.id, {
							id: q.id,
							header: q.header,
							question: q.question,
							multiSelect: false,
							values: [{ label: trimmed, wasCustom: true }],
						});
						inputMode = false;
						inputQuestionId = null;
						editor.setText("");
						advanceAfterAnswer();
					}
				};

				function handleInput(data: string) {
					// Free-text editing mode routes to the inline editor
					if (inputMode) {
						if (matchesKey(data, Key.escape)) {
							inputMode = false;
							inputQuestionId = null;
							editor.setText("");
							refresh();
							return;
						}
						editor.handleInput(data);
						refresh();
						return;
					}

					const q = currentQuestion();

					// Tab navigation (multi-question only)
					if (questions.length > 1) {
						if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
							currentTab = (currentTab + 1) % totalTabs;
							optionIndex = 0;
							refresh();
							return;
						}
						if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
							currentTab = (currentTab - 1 + totalTabs) % totalTabs;
							optionIndex = 0;
							refresh();
							return;
						}
					}

					// Submit tab
					if (currentTab === questions.length) {
						if (matchesKey(data, Key.enter) && allAnswered()) {
							submit(false);
						} else if (matchesKey(data, Key.escape)) {
							submit(true);
						}
						return;
					}

					const opts = currentOptions();

					if (matchesKey(data, Key.up)) {
						optionIndex = Math.max(0, optionIndex - 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.down)) {
						optionIndex = Math.min(opts.length - 1, optionIndex + 1);
						refresh();
						return;
					}

					if (matchesKey(data, Key.space) && q?.multiSelect) {
						const opt = opts[optionIndex];
						if (!opt.isOther) {
							const picks = toggled.get(q.id) ?? new Set<number>();
							if (picks.has(optionIndex)) {
								picks.delete(optionIndex);
							} else {
								picks.add(optionIndex);
							}
							toggled.set(q.id, picks);
							refresh();
						}
						return;
					}

					if (matchesKey(data, Key.enter) && q) {
						const opt = opts[optionIndex];
						if (opt.isOther) {
							inputMode = true;
							inputQuestionId = q.id;
							editor.setText("");
							refresh();
							return;
						}
						if (q.multiSelect) {
							// Enter finishes a multiSelect question: current toggles +
							// collected free-text; if nothing toggled, take the highlighted one
							const picks = toggled.get(q.id);
							if ((!picks || picks.size === 0) && (customs.get(q.id)?.length ?? 0) === 0) {
								const set = new Set<number>([optionIndex]);
								toggled.set(q.id, set);
							}
							finishQuestion(q);
							advanceAfterAnswer();
						} else {
							finished.set(q.id, {
								id: q.id,
								header: q.header,
								question: q.question,
								multiSelect: false,
								values: [{ label: opt.label, wasCustom: false, index: optionIndex + 1 }],
							});
							advanceAfterAnswer();
						}
						return;
					}

					if (matchesKey(data, Key.escape)) {
						submit(true);
					}
				}

				function render(width: number): string[] {
					if (cachedLines) return cachedLines;

					const lines: string[] = [];
					const renderWidth = Math.max(1, width);
					const q = currentQuestion();
					const opts = currentOptions();
					const isMultiQuestion = questions.length > 1;

					function addWrapped(text: string) {
						lines.push(...wrapTextWithAnsi(text, renderWidth));
					}

					function addWrappedWithPrefix(prefix: string, text: string) {
						const prefixWidth = visibleWidth(prefix);
						if (prefixWidth >= renderWidth) {
							addWrapped(prefix + text);
							return;
						}
						const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
						const continuationPrefix = " ".repeat(prefixWidth);
						for (let i = 0; i < wrapped.length; i++) {
							lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
						}
					}

					lines.push(theme.fg("accent", "─".repeat(renderWidth)));

					// Tab bar (multi-question only)
					if (isMultiQuestion) {
						const tabs: string[] = ["← "];
						for (let i = 0; i < questions.length; i++) {
							const isActive = i === currentTab;
							const isAnswered = finished.has(questions[i].id);
							const box = isAnswered ? "■" : "□";
							const color = isAnswered ? "success" : "muted";
							const text = ` ${box} ${questions[i].header} `;
							const styled = isActive
								? theme.bg("selectedBg", theme.fg("text", text))
								: theme.fg(color, text);
							tabs.push(`${styled} `);
						}
						const canSubmit = allAnswered();
						const isSubmitTab = currentTab === questions.length;
						const submitStyled = isSubmitTab
							? theme.bg("selectedBg", theme.fg("text", " ✓ Submit "))
							: theme.fg(canSubmit ? "success" : "dim", " ✓ Submit ");
						tabs.push(`${submitStyled} →`);
						addWrappedWithPrefix(" ", tabs.join(""));
						lines.push("");
					}

					function renderOptions() {
						const picks = q ? toggled.get(q.id) : undefined;
						for (let i = 0; i < opts.length; i++) {
							const opt = opts[i];
							const selected = i === optionIndex;
							const isOther = opt.isOther === true;
							let marker: string;
							if (isOther) {
								marker = "";
							} else if (q?.multiSelect) {
								marker = picks?.has(i) ? "[x] " : "[ ] ";
							} else {
								marker = "";
							}
							const prefix = selected ? theme.fg("accent", "> ") : "  ";
							const recommendedSuffix =
								opt.recommended && !isOther ? theme.fg("success", " (recommended)") : "";
							const label = `${i + 1}. ${marker}${opt.label}${isOther && inputMode ? " ✎" : ""}${recommendedSuffix}`;
							const color = selected || (isOther && inputMode) ? "accent" : "text";

							addWrappedWithPrefix(prefix, theme.fg(color, label));
							if (opt.description) {
								addWrappedWithPrefix("      ", theme.fg("muted", opt.description));
							}
						}
					}

					// Content
					if (inputMode && q) {
						addWrappedWithPrefix(" ", theme.fg("text", q.question));
						lines.push("");
						renderOptions();
						lines.push("");
						addWrappedWithPrefix(" ", theme.fg("muted", "Your answer:"));
						for (const line of editor.render(Math.max(1, renderWidth - 2))) {
							lines.push(` ${line}`);
						}
						lines.push("");
						addWrappedWithPrefix(" ", theme.fg("dim", "Enter to submit • Esc to go back"));
					} else if (currentTab === questions.length && isMultiQuestion) {
						addWrappedWithPrefix(" ", theme.fg("accent", theme.bold("Ready to submit")));
						lines.push("");
						for (const question of questions) {
							const answer = finished.get(question.id);
							if (answer) {
								const summary = `${theme.fg("muted", `${question.header}: `)}${theme.fg(
									"text",
									answer.values.map((v) => (v.wasCustom ? `(wrote) ${v.label}` : v.label)).join(", "),
								)}`;
								addWrappedWithPrefix(" ", summary);
							}
						}
						lines.push("");
						if (allAnswered()) {
							addWrappedWithPrefix(" ", theme.fg("success", "Press Enter to submit"));
						} else {
							const missing = questions
								.filter((cand) => !finished.has(cand.id))
								.map((cand) => cand.header)
								.join(", ");
							addWrappedWithPrefix(" ", theme.fg("warning", `Unanswered: ${missing}`));
						}
					} else if (q) {
						addWrappedWithPrefix(" ", theme.fg("text", q.question));
						lines.push("");
						renderOptions();
					}

					lines.push("");
					if (!inputMode) {
						const multiHint = q?.multiSelect ? " • Space toggle" : "";
						const help = isMultiQuestion
							? `Tab/←→ navigate • ↑↓ select${multiHint} • Enter confirm • Esc cancel`
							: `↑↓ navigate${multiHint} • Enter select • Esc cancel`;
						addWrappedWithPrefix(" ", theme.fg("dim", help));
					}
					lines.push(theme.fg("accent", "─".repeat(renderWidth)));

					cachedLines = lines;
					return lines;
				}

				return {
					render,
					invalidate: () => {
						cachedLines = undefined;
					},
					handleInput,
				};
			});

			if (!result || result.cancelled) {
				return {
					content: [
						{
							type: "text",
							text: "User cancelled — proceed with best judgment or ask again later.",
						},
					],
					details: result ?? { questions, answers: [], cancelled: true },
				};
			}

			const answerLines = result.answers.map(formatAnswerLine);
			return {
				content: [{ type: "text", text: answerLines.join("\n") }],
				details: result,
			};
		},

		renderCall(args, theme, _context) {
			const qs = (args.questions as Array<{ question: string; header?: string }>) ?? [];
			let text = theme.fg("toolTitle", theme.bold("ask_user "));
			text += theme.fg("muted", `${qs.length} question${qs.length !== 1 ? "s" : ""}`);
			const headers = qs.map((q) => q.header || q.question.slice(0, 12)).join(", ");
			if (headers) {
				text += theme.fg("dim", ` (${headers})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as AskUserDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const lines = details.answers.map((a) => {
				const values = a.values
					.map((v) => (v.wasCustom ? `${theme.fg("muted", "(wrote) ")}${theme.fg("accent", v.label)}` : v.label))
					.join(", ");
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.header)}: ${values}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
