/**
 * Ask User Question tool
 *
 * Registers an `askUser` tool that pi can call whenever it lacks the
 * information or context needed to complete a task. Instead of guessing,
 * the agent asks the user: the question is shown with a list of options,
 * plus an "Other (type)" option that lets the user type a free-form answer.
 *
 * Install: ~/.pi/agent/extensions/ask-user-question.ts (global)
 *          or .pi/extensions/ask-user-question.ts (project-local)
 * Then /reload in pi. The agent will be able to call `askUser`.
 *
 * Behavior:
 *  - TUI mode:     full options list + inline editor for "Other"
 *  - RPC mode:     falls back to select/input dialogs
 *  - No UI:        returns a note that it cannot prompt, agent decides next step
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

interface AskUserDetails {
	question: string;
	reason?: string;
	options: string[];
	answer: string | null;
	selectedIndex?: number;
	wasCustom: boolean;
	cancelled: boolean;
}

const AskUserParams = Type.Object({
	question: Type.String({ description: "The question to ask the user" }),
	reason: Type.Optional(
		Type.String({
			description:
				"Optional short explanation of why you are asking. Shown above the options so the user understands the context.",
		}),
	),
	options: Type.Optional(
		Type.Array(Type.String({ description: "Short answer option, e.g. 'Use Postgres'" }), {
			description:
				"Optional answer choices. An 'Other (type)' option is always added automatically for free-form answers. Pass an empty list to only get a typed answer.",
		}),
	),
});

const OTHER_LABEL = "Other (type)";

function makeResult(text: string, details: AskUserDetails) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

export default function askUserQuestion(pi: ExtensionAPI) {
	pi.registerTool({
		name: "askUser",
		label: "Ask User",
		description:
			"Ask the user a question when you lack the information, context, or confirmation needed to complete the task. " +
			"Shows the question with answer options plus an 'Other' option the user can type into. " +
			"Prefer this over guessing whenever the user's intent, preferences, credentials, or requirements are ambiguous.",
		parameters: AskUserParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const options = (params.options ?? []).map((o) => o.trim()).filter(Boolean);
			const question = params.question.trim();

			// No interactive UI (print/json modes): cannot prompt.
			if (!ctx.hasUI) {
				return makeResult("(Could not ask the user: pi is running non-interactively.)", {
					question,
					reason: params.reason,
					options,
					answer: null,
					wasCustom: false,
					cancelled: true,
				});
			}

			// Non-TUI (e.g. RPC): custom() is unavailable, fall back to plain dialogs.
			if (ctx.mode !== "tui") {
				let answer: string | undefined;
				if (options.length === 0) {
					answer = await ctx.ui.input(question);
				} else {
					answer = await ctx.ui.select(question, [...options, OTHER_LABEL]);
					if (answer === OTHER_LABEL) {
						answer = await ctx.ui.input(`${question} (your own answer)`);
					}
				}
				if (!answer) {
					return makeResult("(User cancelled the question.)", {
						question,
						reason: params.reason,
						options,
						answer: null,
						wasCustom: false,
						cancelled: true,
					});
				}
				const pickedIndex = options.indexOf(answer) + 1;
				const wasCustom = pickedIndex === 0;
				return makeResult(
					wasCustom ? `User answered (typed): ${answer}` : `User selected: ${pickedIndex}. ${answer}`,
					{
						question,
						reason: params.reason,
						options,
						answer,
						selectedIndex: wasCustom ? undefined : pickedIndex,
						wasCustom,
						cancelled: false,
					},
				);
			}

			// TUI: full custom component (options list + inline editor for Other).
			const allOptions = [...options, OTHER_LABEL];

			const result = await ctx.ui.custom<{
				answer: string;
				wasCustom: boolean;
				selectedIndex: number | null;
			} | null>((tui, theme, _kb, done) => {
				let optionIndex = 0;
				let editMode = false;
				let cachedLines: string[] | undefined;

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

				editor.onSubmit = (value) => {
					const trimmed = value.trim();
					if (trimmed) {
						done({ answer: trimmed, wasCustom: true, selectedIndex: null });
					} else {
						editMode = false;
						editor.setText("");
						refresh();
					}
				};

				function refresh() {
					cachedLines = undefined;
					tui.requestRender();
				}

				function pickOption(index: number) {
					if (index === allOptions.length - 1) {
						editMode = true;
						refresh();
						return;
					}
					done({ answer: allOptions[index], wasCustom: false, selectedIndex: index + 1 });
				}

				function handleInput(data: string) {
					if (editMode) {
						if (matchesKey(data, Key.escape)) {
							editMode = false;
							editor.setText("");
							refresh();
							return;
						}
						editor.handleInput(data);
						refresh();
						return;
					}

					if (matchesKey(data, Key.up) || matchesKey(data, Key.k)) {
						optionIndex = Math.max(0, optionIndex - 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.down) || matchesKey(data, Key.j)) {
						optionIndex = Math.min(allOptions.length - 1, optionIndex + 1);
						refresh();
						return;
					}

					// Number keys 1-9 as quick shortcuts
					const num = parseInt(data, 10);
					if (!Number.isNaN(num) && num >= 1 && num <= allOptions.length && allOptions[num - 1] !== undefined) {
						pickOption(num - 1);
						return;
					}

					if (matchesKey(data, Key.enter)) {
						pickOption(optionIndex);
						return;
					}

					if (matchesKey(data, Key.escape)) {
						done(null);
					}
				}

				function render(width: number): string[] {
					if (cachedLines) return cachedLines;

					const lines: string[] = [];
					const renderWidth = Math.max(1, width);

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
					addWrappedWithPrefix(" ", theme.fg("accent", theme.bold("Question ")));
					addWrappedWithPrefix(" ", theme.fg("text", params.question));
					if (params.reason) {
						lines.push("");
						addWrappedWithPrefix(" ", theme.fg("muted", params.reason));
					}
					lines.push("");

					for (let i = 0; i < allOptions.length; i++) {
						const isOther = i === allOptions.length - 1;
						const selected = i === optionIndex;
						const prefix = selected ? theme.fg("accent", "> ") : "  ";
						const color = selected || (isOther && editMode) ? "accent" : "text";
						const label = `${i + 1}. ${allOptions[i]}${isOther && editMode ? " ✎" : ""}`;
						addWrappedWithPrefix(prefix, theme.fg(color, label));
					}

					if (editMode) {
						lines.push("");
						addWrappedWithPrefix(" ", theme.fg("muted", "Your answer:"));
						for (const line of editor.render(Math.max(1, renderWidth - 2))) {
							lines.push(` ${line}`);
						}
					}

					lines.push("");
					addWrappedWithPrefix(
						" ",
						editMode
							? theme.fg("dim", "Enter to submit • Esc back to options")
							: theme.fg("dim", "↑↓/jk or 1-9 to pick • Enter to select • Esc to cancel"),
					);
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

			if (!result) {
				return makeResult("(User cancelled the question.)", {
					question,
					reason: params.reason,
					options,
					answer: null,
					wasCustom: false,
					cancelled: true,
				});
			}

			if (result.wasCustom) {
				return makeResult(`User answered (typed): ${result.answer}`, {
					question,
					reason: params.reason,
					options,
					answer: result.answer,
					wasCustom: true,
					cancelled: false,
				});
			}

			return makeResult(`User selected: ${result.selectedIndex}. ${result.answer}`, {
				question,
				reason: params.reason,
				options,
				answer: result.answer,
				selectedIndex: result.selectedIndex ?? undefined,
				wasCustom: false,
				cancelled: false,
			});
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("askUser ")) + theme.fg("muted", args.question ?? "");
			const opts = Array.isArray(args.options) ? args.options : [];
			if (opts.length > 0) {
				const numbered = [...opts, OTHER_LABEL].map((o: string, i: number) => `${i + 1}. ${o}`);
				text += `\n${theme.fg("dim", `Options: ${numbered.join(", ")}`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as AskUserDetails | undefined;
			if (!details) {
				const part = result.content[0];
				return new Text(part?.type === "text" ? part.text : "", 0, 0);
			}
			if (details.cancelled || details.answer === null) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const display = details.wasCustom
				? `${theme.fg("muted", "(typed) ")}${theme.fg("accent", details.answer)}`
				: theme.fg(
						"accent",
						`${details.selectedIndex ? `${details.selectedIndex}. ` : ""}${details.answer}`,
					);
			return new Text(`${theme.fg("success", "✓ ")}${display}`, 0, 0);
		},
	});
}