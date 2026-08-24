/**
 * todo - branch-safe todo list for pi
 *
 * State lives in tool-result details, NOT external files: every `todo` tool
 * call stores the full list in its result details, and state is reconstructed
 * by replaying the session branch. Branching/forking therefore automatically
 * shows the todos exactly as they were at that point in history.
 *
 * Features:
 *   - `todo` tool for the LLM: list / add / toggle / clear
 *     (description nudges the agent to track multi-step work and mark items
 *     done immediately)
 *   - Footer widget above the editor: "[todo] [###-------] 2/5" plus the
 *     current (first open) task; hidden entirely when there are no todos.
 *     ASCII three-state markers: "[x]" done (dim), "> [ ]" current (accent),
 *     "[ ]" pending.
 *   - Completion ceremony: transitioning to all-done fires a one-time
 *     notification and auto-hides the widget after ~4s.
 *   - `/todos` opens a lazygit/telescope-style centered overlay viewer
 *     (scrollable: up/down line, pgup/pgdn page, home/end, esc or q closes).
 *   - Ctrl+Shift+T toggles widget visibility; persisted as session entries so
 *     it survives restarts and branches (reuses the "plan-todo-state" entry
 *     type for backward compatibility with the previous plan-todo extension).
 *
 * ASCII-only glyphs are used throughout on purpose (user's terminal mangles
 * some non-ASCII output); emphasis comes from theme colors instead.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const WIDGET_ID = "todo";
const STATE_TYPE = "plan-todo-state";
const HIDE_DELAY_MS = 4_000;
const VIEWPORT_ROWS = 12;

interface Todo {
	id: number;
	text: string;
	done: boolean;
}

interface TodoDetails {
	action: "list" | "add" | "toggle" | "clear";
	todos: Todo[];
	nextId: number;
	error?: string;
}

const TodoParams = Type.Object({
	action: Type.Union(
		[Type.Literal("list"), Type.Literal("add"), Type.Literal("toggle"), Type.Literal("clear")],
		{ description: "Action to perform" },
	),
	text: Type.Optional(Type.String({ description: "Todo text (required for add)" })),
	id: Type.Optional(Type.Number({ description: "Todo ID (required for toggle)" })),
});

// --- overlay viewer ---------------------------------------------------------

/**
 * Centered, scrollable, bordered todo list (lazygit/telescope style).
 * Rendered inside ctx.ui.custom({ overlay: true }); closes on esc/q.
 */
class TodoViewer {
	private closed = false;
	private selected = 0;
	private offset = 0;

	constructor(
		private readonly entries: Todo[],
		private readonly theme: Theme,
		private readonly tui: TUI,
		private readonly done: (result: undefined) => void,
	) {}

	finish(): void {
		if (this.closed) return;
		this.closed = true;
		this.done(undefined);
	}

	handleInput(data: string): void {
		if (this.closed) return;
		const count = this.entries.length;

		if (matchesKey(data, Key.escape) || data === "q") {
			this.finish();
			return;
		}
		if (count === 0) return;

		const before = this.selected;
		if (matchesKey(data, Key.up) || data === "k") {
			this.selected = Math.max(0, this.selected - 1);
		} else if (matchesKey(data, Key.down) || data === "j") {
			this.selected = Math.min(count - 1, this.selected + 1);
		} else if (matchesKey(data, Key.pageUp)) {
			this.selected = Math.max(0, this.selected - VIEWPORT_ROWS);
		} else if (matchesKey(data, Key.pageDown)) {
			this.selected = Math.min(count - 1, this.selected + VIEWPORT_ROWS);
		} else if (matchesKey(data, Key.home)) {
			this.selected = 0;
		} else if (matchesKey(data, Key.end)) {
			this.selected = count - 1;
		}
		if (this.selected !== before) {
			this.clampOffset();
			this.tui.requestRender();
		}
	}

	private clampOffset(): void {
		if (this.offset > this.selected) this.offset = this.selected;
		if (this.selected >= this.offset + VIEWPORT_ROWS) this.offset = this.selected - VIEWPORT_ROWS + 1;
		this.offset = Math.max(0, Math.min(this.offset, Math.max(0, this.entries.length - VIEWPORT_ROWS)));
	}

	render(width: number): string[] {
		const th = this.theme;
		const w = Math.max(20, width);
		const innerW = w - 2;
		const lines: string[] = [];
		const padRow = (content: string): string => {
			const padLen = Math.max(0, innerW - visibleWidth(content));
			return th.fg("border", "|") + content + " ".repeat(padLen) + th.fg("border", "|");
		};

		// Title row embedded in the top border: +-- Todos  2/5 ----------+
		const total = this.entries.length;
		const doneCount = total - this.entries.filter((t) => !t.done).length;
		const title = ` Todos  ${doneCount}/${total} `;
		const titleDashes = Math.max(0, innerW - 4 - title.length);
		lines.push(th.fg("border", `+--${title}${"-".repeat(titleDashes)}+`));

		if (total === 0) {
			lines.push(padRow(` ${th.fg("dim", "No todos yet. Ask the agent to add some!")}`));
		} else {
			const firstOpen = this.entries.findIndex((t) => !t.done);
			const viewport = Math.min(VIEWPORT_ROWS, this.entries.length);
			this.offset = Math.max(0, Math.min(this.offset, Math.max(0, total - viewport)));
			for (let row = 0; row < viewport; row++) {
				const index = this.offset + row;
				const todo = this.entries[index];
				const isCurrent = index === firstOpen;
				let marker: string;
				let text: string;
				if (todo.done) {
					marker = th.fg("dim", "[x]");
					text = th.fg("dim", todo.text);
				} else if (isCurrent) {
					marker = th.fg("accent", "> [ ]");
					text = th.fg("text", todo.text);
				} else {
					marker = th.fg("muted", "[ ]");
					text = th.fg("text", todo.text);
				}
				let content = ` ${marker} #${todo.id} ${text}`;
				if (index === this.selected) {
					// ANSI-aware highlight: measure with visibleWidth, not String.padEnd
					// (padEnd counts escape codes and misaligns the border).
					const pad = Math.max(0, innerW - 1 - visibleWidth(content));
					content = th.bg("selectedBg", content + " ".repeat(pad));
				}
				lines.push(truncateToWidth(padRow(content), w));
			}
			// Scroll indicator when the list overflows the viewport
			if (total > viewport) {
				lines.push(padRow(` ${th.fg("dim", `- ${this.offset + 1}-${Math.min(this.offset + viewport, total)} of ${total} -`)}`));
			}
		}

		lines.push("");
		lines.push(padRow(` ${th.fg("dim", "j/k or up/down move | pgup/pgdn page | home/end jump | esc or q close")}`));
		lines.push(th.fg("border", `+${"-".repeat(innerW)}+`));
		return lines;
	}

	invalidate(): void {}
}

// --- extension --------------------------------------------------------------

export default function todoExtension(pi: ExtensionAPI) {
	let todos: Todo[] = [];
	let nextId = 1;
	let visible = true;
	/** One-shot guard for the all-done ceremony (reset when new work is added). */
	let celebrated = false;
	let hideTimer: ReturnType<typeof setTimeout> | undefined;
	let widgetTui: TUI | undefined;

	const openCount = (): number => todos.filter((t) => !t.done).length;

	/** Shared progress header: `[todo] [###-------] 3/15` */
	function headerLine(theme: Theme, width: number): string {
		const total = todos.length;
		const done = total - openCount();
		const filled = total > 0 ? Math.round((done / total) * 10) : 0;
		const bar = "#".repeat(filled) + "-".repeat(10 - filled);
		const suffix = total > 0 && done === total ? " all done!" : "";
		return truncateToWidth(
			theme.fg("accent", "[todo] ") + theme.fg("muted", `[${bar}] ${done}/${total}${suffix}`),
			width,
		);
	}

	function refresh(): void {
		widgetTui?.requestRender();
	}

	function clearHideTimer(): void {
		if (hideTimer !== undefined) {
			clearTimeout(hideTimer);
			hideTimer = undefined;
		}
	}

	/** Re-register the widget for the current session's UI. */
	function registerWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		try {
			ctx.ui.setWidget(WIDGET_ID, (tui, theme) => {
				widgetTui = tui;
				return {
					render(width: number): string[] {
						if (!visible || todos.length === 0) return [];
						const lines = [headerLine(theme, width)];
						const current = todos.find((t) => !t.done);
						if (current) {
							lines.push(
								truncateToWidth(theme.fg("accent", "> [ ] ") + theme.fg("text", current.text), width),
							);
						}
						return lines;
					},
					invalidate(): void {},
				};
			});
			// Factory captures tui on first paint; nudge a render with fresh state.
			setTimeout(() => refresh(), 0);
		} catch {
			// UI stream may be mid-teardown during /reload - ignore
		}
	}

	/**
	 * Reconstruct state by replaying the session branch: tool results carry the
	 * full todo list, so branching naturally rewinds state. Visibility comes
	 * from custom entries interleaved on the same branch.
	 */
	function replay(ctx: ExtensionContext): void {
		todos = [];
		nextId = 1;
		visible = true;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "todo") {
				const details = entry.message.details as TodoDetails | undefined;
				if (details && Array.isArray(details.todos)) {
					todos = details.todos.map((t) => ({ ...t }));
					nextId = typeof details.nextId === "number" ? details.nextId : todos.length + 1;
				}
			} else if (entry.type === "custom" && entry.customType === STATE_TYPE) {
				const data = entry.data as { visible?: unknown } | undefined;
				if (data && typeof data.visible === "boolean") visible = data.visible;
			}
		}
		celebrated = todos.length > 0 && openCount() === 0;
	}

	/** Post-mutation bookkeeping: completion ceremony + repaint. */
	function afterMutation(ctx: ExtensionContext, prevOpen: number): void {
		const nowOpen = openCount();
		if (nowOpen > 0) {
			celebrated = false;
		} else if (todos.length > 0 && prevOpen > 0 && !celebrated) {
			celebrated = true;
			if (ctx.hasUI) ctx.ui.notify(`All ${todos.length} todos complete`, "info");
			clearHideTimer();
			hideTimer = setTimeout(() => {
				hideTimer = undefined;
				visible = false;
				refresh();
			}, HIDE_DELAY_MS);
		}
		refresh();
	}

	// --- lifecycle -----------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		replay(ctx);
		registerWidget(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		replay(ctx);
		registerWidget(ctx);
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		// Do not touch widgets here (streams may already be destroyed during
		// /reload); just make sure no timer outlives the session.
		clearHideTimer();
		widgetTui = undefined;
	});

	pi.registerEntryRenderer(STATE_TYPE, (entry, _context, theme) => {
		const data = entry.data as { visible?: unknown } | undefined;
		const shown = data && typeof data.visible === "boolean" ? data.visible : true;
		return new Text(theme.fg("dim", shown ? "todo widget shown" : "todo widget hidden"), 0, 0);
	});

	// --- todo tool ------------------------------------------------------------

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Manage the shared todo list. Actions: list, add (text), toggle (id), clear. " +
			"Use it to track multi-step work: create todos before starting a multi-step task, " +
			"keep exactly one task in progress conceptually, and mark tasks done immediately " +
			"after finishing them rather than batching.",
		parameters: TodoParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			switch (params.action) {
				case "list":
					return {
						content: [
							{
								type: "text",
								text: todos.length
									? todos.map((t) => `[${t.done ? "x" : " "}] #${t.id}: ${t.text}`).join("\n")
									: "No todos",
							},
						],
						details: { action: "list", todos: [...todos], nextId } satisfies TodoDetails,
					};

				case "add": {
					const text = params.text?.trim();
					if (!text) {
						return {
							content: [{ type: "text", text: "Error: text required for add" }],
							details: { action: "add", todos: [...todos], nextId, error: "text required" } satisfies TodoDetails,
						};
					}
					const prevOpen = openCount();
					todos = [...todos, { id: nextId++, text, done: false }];
					clearHideTimer(); // new work arrived - cancel any pending auto-hide
					celebrated = false;
					visible = true;
					afterMutation(ctx, prevOpen);
					return {
						content: [{ type: "text", text: `Added todo #${nextId - 1}: ${text}` }],
						details: { action: "add", todos: [...todos], nextId } satisfies TodoDetails,
					};
				}

				case "toggle": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text", text: "Error: id required for toggle" }],
							details: { action: "toggle", todos: [...todos], nextId, error: "id required" } satisfies TodoDetails,
						};
					}
					const todo = todos.find((t) => t.id === params.id);
					if (!todo) {
						return {
							content: [{ type: "text", text: `Todo #${params.id} not found` }],
							details: {
								action: "toggle",
								todos: [...todos],
								nextId,
								error: `#${params.id} not found`,
							} satisfies TodoDetails,
						};
					}
					const prevOpen = openCount();
					todo.done = !todo.done;
					afterMutation(ctx, prevOpen);
					return {
						content: [
							{
								type: "text",
								text: `Todo #${todo.id} ${todo.done ? "completed" : "reopened"}: ${todo.text}`,
							},
						],
						details: { action: "toggle", todos: [...todos], nextId } satisfies TodoDetails,
					};
				}

				case "clear": {
					const count = todos.length;
					const prevOpen = openCount();
					todos = [];
					nextId = 1;
					celebrated = false;
					afterMutation(ctx, prevOpen);
					return {
						content: [{ type: "text", text: `Cleared ${count} todo(s)` }],
						details: { action: "clear", todos: [], nextId: 1 } satisfies TodoDetails,
					};
				}
			}
		},

		renderCall(args, theme, _context) {
			const action = (args as { action?: string }).action ?? "";
			return new Text(theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", action), 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as TodoDetails | undefined;
			if (!details) {
				const block = result.content[0];
				return new Text(block?.type === "text" ? block.text : "", 0, 0);
			}
			if (details.error) {
				return new Text(theme.fg("warning", `error: ${details.error}`), 0, 0);
			}
			const open = details.todos.filter((t) => !t.done).length;
			return new Text(theme.fg("muted", `${open} open / ${details.todos.length} total`), 0, 0);
		},
	});

	// --- user controls --------------------------------------------------------

	pi.registerCommand("todos", {
		description: "Open the todo list viewer",
		getArgumentCompletions: () => null,
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			if (todos.length === 0) {
				ctx.ui.notify("No todos yet - ask the agent to add some!", "info");
				return;
			}
			try {
				await ctx.ui.custom<undefined>(
					(tui, theme, _keybindings, done) =>
						new TodoViewer(todos.map((t) => ({ ...t })), theme, tui, done),
					{
						overlay: true,
						overlayOptions: { width: "60%", maxHeight: "50%", anchor: "center" },
					},
				);
			} catch {
				// Overlay unavailable (e.g. terminal too small) - non-fatal
			}
		},
	});

	pi.registerShortcut("ctrl+shift+t", {
		description: "Toggle todo widget visibility",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;
			visible = !visible;
			try {
				pi.appendEntry(STATE_TYPE, { visible });
			} catch {
				// Session may not accept entries during shutdown - non-fatal
			}
			refresh();
		},
	});
}
