/**
 * Permission Gate Extension
 *
 * Prompts for confirmation before running potentially dangerous bash commands.
 *
 * Patterns checked include:
 *   - rm -rf / rm -r / recursive delete
 *   - sudo (needs a human eye)
 *   - chmod/chown ... 777 (world-writable)
 *   - git push --force / -f  (rewrites remote history)
 *   - git reset --hard       (discards local changes)
 *   - git clean -f           (deletes untracked files)
 *   - git checkout --        (discards working-tree changes)
 *   - git branch -D          (force-deletes a branch)
 *   - git rebase --, git commit --amend (history rewriting)
 *   - dd / mkfs / fdisk / parted / mkswap (raw disk writes)
 *   - DROP TABLE / TRUNCATE TABLE (SQL)
 *   - kill -9, shred, wipe
 *
 * User choices:
 *   - "Block"                  - command is blocked, model is told why
 *   - "Allow once"             - this exact command runs now (asks again next time)
 *   - "Allow in this session"  - this exact command runs for the rest of the session
 *   - Escape / cancel          - treated as Block
 *
 * In non-interactive modes (print / json / rpc) there is no UI: dangerous
 * commands are blocked by default, because blocking is the safe failure mode.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface DangerRule {
  regex: RegExp;
  label: string;
}

const DANGEROUS_PATTERNS: DangerRule[] = [
  { regex: /\brm\s+(-{1,2}[a-z]*r[a-z]*f?|-rf?|-r)\b/i, label: "recursive/force delete (rm -r/-f)" },
  { regex: /\brm\s+--recursive\b/i, label: "recursive delete (rm --recursive)" },
  { regex: /\bsudo\s+/i, label: "sudo" },
  { regex: /\b(chmod|chown)\b.*\s777(\s|$)/i, label: "chmod/chown 777 (world-writable)" },
  { regex: /\bgit\s+push\b.*\b(--force|-f|--force-with-lease)\b/i, label: "git push --force (rewrites remote history)" },
  { regex: /\bgit\s+reset\s+--hard\b/i, label: "git reset --hard (discards local changes)" },
  { regex: /\bgit\s+clean\s+-[a-z]*f/i, label: "git clean -f (deletes untracked files)" },
  { regex: /\bgit\s+checkout\s+--\b/i, label: "git checkout -- (discards working-tree changes)" },
  { regex: /\bgit\s+branch\s+-D\b/i, label: "git branch -D (force-deletes branch)" },
  { regex: /\bgit\s+rebase\s+--(force-rebase|root|onto)\b/i, label: "git rebase (history rewriting)" },
  { regex: /\bgit\s+commit\s+--amend\b/i, label: "git commit --amend (rewrites history)" },
  { regex: /\bdd\s+of=/i, label: "dd of= (raw disk write)" },
  { regex: /\b(mkfs|mkswap|fdisk|parted)\b/i, label: "filesystem/partition manipulation" },
  { regex: /\bDROP\s+TABLE\b/i, label: "DROP TABLE" },
  { regex: /\bTRUNCATE\s+TABLE\b/i, label: "TRUNCATE TABLE" },
  { regex: /\bkill\s+-9\b/i, label: "kill -9" },
  { regex: /\bshred\b/i, label: "shred (secure delete)" },
  { regex: /\b\.\w*\.env\b/i, label: "reading/writing .env file" },
];

export default function (pi: ExtensionAPI) {
  // Exact commands the user allowed for the whole session, keyed by command text.
  const sessionAllowed = new Set<string>();

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    const command = String(event.input.command ?? "");
    if (sessionAllowed.has(command)) return undefined;

    const matched = DANGEROUS_PATTERNS.find((rule) => rule.regex.test(command));
    if (!matched) return undefined;

    // No UI available: block by default (safe choice).
    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `Dangerous command blocked (no UI for confirmation): ${matched.label}`,
        terminate: true,
      };
    }

    const choice = await ctx.ui.select(
      `⚠️  Dangerous command (${matched.label})\n\n  ${command}\n\nWhat should I do?`,
      ["Block", "Allow once", "Allow in this session"],
    );

    switch (choice) {
      case "Allow once":
        return undefined;
      case "Allow in this session":
        sessionAllowed.add(command);
        return undefined;
      case "Block":
      default:
        return {
          block: true,
          reason: `Blocked by user: ${matched.label}`,
          terminate: true,
        };
    }
  });
}