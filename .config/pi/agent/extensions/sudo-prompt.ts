/**
 * sudo-prompt — masked sudo password dialog for pi
 *
 * When the AI runs a bash command containing `sudo`, this extension:
 *   1. Checks whether sudo credentials are usable (`sudo -n true`)
 *   2. If not, shows a masked password dialog (TUI) via ctx.ui.custom()
 *   3. Validates it via `sudo -S -v`, then makes it stick for this session by
 *      wiring SUDO_ASKPASS: rewritten commands call `sudo -A`, and the askpass
 *      helper feeds the password from a 0600 file in a 0700 temp dir.
 *
 * Security properties:
 *   - The password NEVER enters the chat/session context
 *   - Never on a command line (no ps leak) — stdin pipes and files only
 *   - Temp files live in a 0700 dir, removed on session_shutdown
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { matchesKey, Key, type Component } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_ATTEMPTS = 3;
const SUDO_TIMEOUT_MS = 20_000;

interface UiTheme {
	fg(color: string, text: string): string;
}

// ---------------------------------------------------------------------------
// Password dialog component (masked input)
// ---------------------------------------------------------------------------

class PasswordDialog implements Component {
	private buffer = "";

	constructor(
		private opts: {
			theme: UiTheme;
			command: string;
			attempt: number;
			onChange: () => void;
			onSubmit: (value: string) => void;
			onCancel: () => void;
		},
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.enter) || data === "\r" || data === "\n") {
			this.opts.onSubmit(this.buffer);
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.opts.onCancel();
			return;
		}
		if (matchesKey(data, Key.backspace) || matchesKey(data, Key.ctrl("h"))) {
			this.buffer = this.buffer.slice(0, -1);
			this.opts.onChange();
			return;
		}
		if (data.length === 1 && data >= " " && data !== "\x7f") {
			this.buffer += data;
			this.opts.onChange();
		}
	}

	render(_width: number): string[] {
		const t = this.opts.theme;
		const dots = t.fg("accent", "•".repeat(this.buffer.length));
		const lines: string[] = [];
		lines.push("");
		lines.push("  " + t.fg("toolTitle", "🔒 Sudo password required"));
		lines.push("  " + t.fg("muted", "for: ") + t.fg("dim", truncate(this.opts.command, 66)));
		if (this.opts.attempt > 1) {
			lines.push(
				"  " +
					t.fg("error", "Sorry, try again.") +
					t.fg("dim", ` (attempt ${this.opts.attempt}/${MAX_ATTEMPTS})`),
			);
		}
		lines.push("");
		lines.push("  " + t.fg("muted", "[sudo] password: ") + dots + t.fg("dim", "_"));
		lines.push("");
		lines.push("  " + t.fg("dim", "Enter confirm · Esc cancel · goes to sudo only, never to the chat"));
		lines.push("");
		return lines;
	}

	invalidate(): void {}
}

function truncate(s: string, n: number): string {
	const oneLine = s.replace(/\s+/g, " ").trim();
	return oneLine.length > n ? oneLine.slice(0, n - 1) + "…" : oneLine;
}

// ---------------------------------------------------------------------------
// Session-scoped askpass plumbing
// ---------------------------------------------------------------------------

let askpassDir: string | null = null;
let cachedPassword: string | null = null;

function ensureAskpass(password: string): string {
	if (!askpassDir) {
		askpassDir = mkdtempSync(join(tmpdir(), "pi-sudo-"), { recursive: true });
		process.on("exit", cleanupAskpass);
	}
	writeFileSync(join(askpassDir, "pw"), password + "\n", { mode: 0o600 });
	const script = "#!/bin/sh\ncat '" + join(askpassDir, "pw") + "'\n";
	const askpass = join(askpassDir, "askpass.sh");
	writeFileSync(askpass, script, { mode: 0o700 });
	return askpass;
}

function cleanupAskpass() {
	if (askpassDir) {
		try {
			rmSync(askpassDir, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
		askpassDir = null;
		cachedPassword = null;
	}
}

/** Rewrite `sudo …` → `SUDO_ASKPASS=… sudo -A …` (idempotent). */
function withAskpass(command: string, askpassPath: string): string {
	let out = command.replace(/(^|[\s;&|(])sudo(\s)/g, (_m, pre: string, ws: string) => `${pre}sudo -A${ws}`);
	if (!out.startsWith("export SUDO_ASKPASS=")) {
		out = `export SUDO_ASKPASS='${askpassPath}'\n${out}`;
	}
	return out;
}

// ---------------------------------------------------------------------------
// sudo helpers
// ---------------------------------------------------------------------------

function sudoCached(): Promise<boolean> {
	return new Promise((resolve) => {
		const child = spawn("sudo", ["-n", "true"], { stdio: "ignore" });
		child.on("error", () => resolve(false));
		child.on("close", (code) => resolve(code === 0));
	});
}

/** Validate a password by feeding it to `sudo -S -v` via stdin. Never logs. */
function sudoValidate(password: string): Promise<boolean> {
	return new Promise((resolve) => {
		const child = spawn("sudo", ["-S", "-v", "-p", ""], {
			stdio: ["pipe", "ignore", "ignore"],
		});
		let settled = false;
		const done = (ok: boolean) => {
			if (!settled) {
				settled = true;
				resolve(ok);
			}
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			done(false);
		}, SUDO_TIMEOUT_MS);
		child.stdin.on("error", () => {});
		child.stdin.write(password + "\n");
		child.stdin.end();
		password = "";
		child.on("close", (code) => {
			clearTimeout(timer);
			done(code === 0);
		});
	});
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.notify("🔒 sudo-prompt active", "info");
	});

	pi.on("session_shutdown", async () => {
		cleanupAskpass();
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		const command: string = event.input.command ?? "";
		if (!/(?:^|[\s;&|(])sudo(?:\s|$)/.test(command)) return;

		// Askpass already wired for this session? Just make sure it applies.
		if (cachedPassword !== null && askpassDir !== null) {
			event.input.command = withAskpass(command, join(askpassDir, "askpass.sh"));
			return;
		}

		// System-level cached credentials are good enough on their own.
		if (await sudoCached()) return;

		if (ctx.mode !== "tui" || !ctx.hasUI) {
			return {
				block: true,
				reason:
					"This command needs sudo. Run '! sudo -v' yourself in the terminal to cache credentials, then retry.",
			};
		}

		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			const pw = await ctx.ui.custom<string | null>(
				(tui, theme, _keybindings, done) =>
					new PasswordDialog({
						theme,
						command,
						attempt,
						onChange: () => tui.requestRender(),
						onSubmit: (value) => done(value),
						onCancel: () => done(null),
					}),
			);

			if (pw === null) {
				return { block: true, reason: "User cancelled the sudo password dialog." };
			}

			if (await sudoValidate(pw)) {
				ctx.ui.notify("Sudo authenticated — wiring askpass for this session", "info");
				const askpassPath = ensureAskpass(pw);
				cachedPassword = pw;
				event.input.command = withAskpass(command, askpassPath);
				return; // allow
			}
			// Wrong password → loop and re-prompt ("Sorry, try again.")
		}

		return { block: true, reason: `Sudo authentication failed after ${MAX_ATTEMPTS} attempts.` };
	});
}
