/**
 * paste-image — OpenCode-style clipboard image paste for pi on WSL2.
 *
 * Press Ctrl+Alt+V in the prompt editor to grab the image currently on the
 * WINDOWS clipboard (via powershell.exe interop — WSLg's bridge only carries
 * text). The extension saves it as PNG under the OS temp dir and inserts an
 * inline placeholder "[Image N]" at the editor caret. Placeholders can be
 * typed around freely ("compare [Image 2] with [Image 1]"); each successive
 * paste increments N for the whole session.
 *
 * On submit, the `input` handler splits the prompt at each [Image N] token
 * and sends the message as an ordered (TextContent | ImageContent)[] array,
 * so images land at their exact mid-text position. Saved images never
 * referenced by any placeholder are appended after the text so nothing is
 * silently dropped.
 *
 * Failure modes are non-fatal: no image / powershell missing / timeout /
 * save error all surface as a footer status or notify — typing is never
 * blocked beyond a bounded exec (5 s hard timeout, concurrent invocations
 * coalesced).
 */

import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Structural equivalents of pi-ai's TextContent/ImageContent (flat shape in
// installed 0.84.2): keeps this file free of extra package imports.
interface TextContent {
	type: "text";
	text: string;
}
interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

const IMAGE_DIR = join(tmpdir(), "pi-clipboard-images");
const EXEC_TIMEOUT_MS = 5_000;
const MARKER_RE = /\[Image (\d+)\]/g;

const latestStatus = new Map<string, string>();

/** Transient footer status that clears itself unless replaced meanwhile. */
function flashStatus(ctx: ExtensionContext, key: string, text: string, ttlMs = 2500): void {
	ctx.ui.setStatus(key, text);
	setTimeout(() => {
		// Only clear if nothing newer was written for this key.
		if (latestStatus.get(key) === text) {
			ctx.ui.setStatus(key, undefined);
			latestStatus.delete(key);
		}
	}, ttlMs);
	latestStatus.set(key, text);
}

/**
 * Read the Windows clipboard image inside WSL2 and save it as PNG.
 * Mirrors pi's own shipped WSL fallback (dist/utils/clipboard-image.js):
 * WinForms Clipboard.GetImage() -> Save(PNG) -> sentinel output.
 * Returns the saved file path, or null when the clipboard holds no image.
 * Throws on environment failures (powershell missing, timeout, save failed).
 */
async function readClipboardImage(pi: ExtensionAPI): Promise<string | null> {
	mkdirSync(IMAGE_DIR, { recursive: true });
	const linuxPath = join(IMAGE_DIR, `clip-${randomUUID()}.png`);

	const winPathRes = await pi.exec("wslpath", ["-w", linuxPath], { timeout: 1_000 });
	const winPath = winPathRes.stdout.trim();
	if (winPathRes.code !== 0 || !winPath) {
		throw new Error("wslpath failed — is this really running under WSL?");
	}

	const psQuotedWinPath = winPath.replaceAll("'", "''");
	const psScript = [
		"Add-Type -AssemblyName System.Windows.Forms",
		"Add-Type -AssemblyName System.Drawing",
		`$path = '${psQuotedWinPath}'`,
		"$img = [System.Windows.Forms.Clipboard]::GetImage()",
		"if ($img) { $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'ok' } else { Write-Output 'empty' }",
	].join("; ");

	// PowerShell exits 0 even when the clipboard has no image — trust the
	// sentinel stdout, never the exit code alone.
	const candidates = ["powershell.exe", "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"];
	let lastErr = "";
	for (const exe of candidates) {
		let res;
		try {
			res = await pi.exec(exe, ["-NoProfile", "-Command", psScript], { timeout: EXEC_TIMEOUT_MS });
		} catch (err) {
			lastErr = err instanceof Error ? err.message : String(err);
			continue; // try next candidate (e.g. powershell.exe not on PATH)
		}
		const out = res.stdout.trim();
		if (out === "ok") {
			if (!existsSync(linuxPath) || statSync(linuxPath).size === 0) {
				throw new Error("PowerShell reported ok but the PNG file is missing/empty");
			}
			return linuxPath;
		}
		if (out === "empty") {
			return null; // clipboard simply has no image — not an error
		}
		lastErr =
			res.killed && res.code !== 0
				? `${exe} timed out after ${EXEC_TIMEOUT_MS}ms`
				: `${exe}: ${out || res.stderr.trim() || `exit ${res.code}`}`;
	}
	throw new Error(lastErr || "Could not read the Windows clipboard");
}

function readImagePart(imagePath: string): ImageContent | null {
	try {
		return { type: "image", data: readFileSync(imagePath).toString("base64"), mimeType: "image/png" };
	} catch {
		// Temp PNG vanished (e.g. aggressive /tmp cleaner) — skip rather than
		// failing the whole submission.
		return null;
	}
}

export default function pasteImage(pi: ExtensionAPI) {
	/** Running placeholder number -> saved PNG path (per session). */
	const pendingImages = new Map<number, string>();
	let counter = 0;
	let busy = false;

	pi.registerShortcut("ctrl+alt+v", {
		description: "Paste image from Windows clipboard ([Image N] placeholder)",
		handler: async (ctx) => {
			if (busy) return;
			busy = true;
			flashStatus(ctx, "paste-image", "Reading image from Windows clipboard…", 6_000);
			try {
				const path = await readClipboardImage(pi);
				if (!path) {
					flashStatus(ctx, "paste-image", "No image in clipboard");
					return;
				}
				counter++;
				pendingImages.set(counter, path);
				// pasteToEditor inserts at the caret, so placeholders can sit
				// anywhere in the prompt text, OpenCode-style.
				ctx.ui.pasteToEditor(`[Image ${counter}]`);
				const refs = [...pendingImages.keys()].map((n) => `[Image ${n}]`).join(" ");
				flashStatus(ctx, "paste-image", `${refs} attached — will send with your message`);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				flashStatus(ctx, "paste-image", `Clipboard read failed: ${msg}`, 4_000);
			} finally {
				busy = false;
			}
		},
	});

	pi.on("input", async (event: InputEvent, ctx) => {
		// Fast path: nothing pasted this session.
		if (pendingImages.size === 0) return { action: "continue" };
		// Never touch extension-injected messages.
		if (event.source === "extension") return { action: "continue" };

		MARKER_RE.lastIndex = 0;
		if (!MARKER_RE.test(event.text)) {
			// No placeholder referenced: let pi submit normally, keep the
			// images pending so a later message can still reference them.
			return { action: "continue" };
		}

		// Build ordered parts: split the text at each [Image N] token and
		// interleave the mapped PNGs at their exact positions.
		const parts: (TextContent | ImageContent)[] = [];
		let lastEnd = 0;
		const used = new Set<number>();
		MARKER_RE.lastIndex = 0;
		for (let m = MARKER_RE.exec(event.text); m !== null; m = MARKER_RE.exec(event.text)) {
			const n = Number(m[1]);
			const imagePath = pendingImages.get(n);
			if (!imagePath) continue; // unknown/deleted marker stays literal text

			const between = event.text.slice(lastEnd, m.index);
			if (between) parts.push({ type: "text", text: between });
			const part = readImagePart(imagePath);
			if (part) parts.push(part);
			used.add(n);
			lastEnd = m.index + m[0].length;
		}
		const tail = event.text.slice(lastEnd);
		if (tail) parts.push({ type: "text", text: tail });

		// Requirement fallback: images never referenced still travel, appended.
		for (const [n, p] of pendingImages) {
			if (!used.has(n)) {
				const part = readImagePart(p);
				if (part) parts.push(part);
				used.add(n);
			}
		}

		// pi.sendUserMessage owns submission now — drop all consumed markers
		// regardless of how they were referenced, and restart the counter at 1
		// for the next prompt (user preference: reset on send).
		pendingImages.clear();
		counter = 0;

		// deliverAs mirrors what would have happened natively (undefined =>
		// idle, triggers the turn immediately).
		const deliverAs = event.streamingBehavior ?? undefined;
		pi.sendUserMessage(parts, deliverAs ? { deliverAs } : undefined);
		return { action: "handled" };
	});
}
