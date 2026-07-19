/**
 * Permission Gate Extension
 *
 * Three-tier bash command gate:
 *
 * 1. Dangerous commands (rm -rf, sudo, mkfs, force push, ...) are blocked
 *    unconditionally — no prompt, no override.
 * 2. Read-only commands (ls, cat, grep, git status, ...) run freely.
 * 3. Everything else — anything that may modify the filesystem or system
 *    state (rm, rmdir, mv, find -exec, npm install, git commit, ...) —
 *    requires a user confirmation dialog. Without a UI to answer (--print,
 *    RPC without dialogs) the command is blocked.
 *
 * Note: regex filtering is a first line of defense, not a sandbox. Commands
 * can be obfuscated (subshells, base64, scripts written to disk). For real
 * isolation, see the sandbox/ and gondolin/ examples.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface DangerousPattern {
	pattern: RegExp;
	description: string;
}

// --- Tier 1: blocked unconditionally ---------------------------------------

const dangerousPatterns: DangerousPattern[] = [
	// --- Data destruction ---
	{ pattern: /\brm\s+(-[a-z]*[rf][a-z]*\b|--recursive\b|--force\b)/i, description: "recursive/forced rm" },
	{ pattern: /\bdd\b.*\bof=\/dev\//i, description: "raw write to a block device" },
	{ pattern: /\bmkfs(\.\w+)?\b/i, description: "filesystem format" },
	{ pattern: /\b(shred|wipefs)\b/i, description: "irreversible data wipe" },
	{ pattern: /\bfind\b.*\s-delete\b/i, description: "bulk delete via find" },
	{ pattern: /\btruncate\b.*\s-s\s*0\b/i, description: "file truncation" },

	// --- Privilege escalation & permissions ---
	{ pattern: /\bsudo\b/i, description: "privilege escalation" },
	{ pattern: /\b(chmod|chown)\b.*777/i, description: "world-writable permissions" },
	{ pattern: /\bchmod\b.*\bu?\+s\b/i, description: "setuid/setgid bit" },
	{ pattern: /\bsetcap\b/i, description: "capability grant" },
	{ pattern: /\bvisudo\b|\/etc\/sudoers/i, description: "sudoers modification" },
	{ pattern: /\b(passwd|usermod|groupmod)\b/i, description: "account modification" },

	// --- System & processes ---
	{ pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, description: "system shutdown/reboot" },
	{ pattern: /\bkill\s+(-\w+\s+)?-1\b/, description: "kill all processes" },
	{ pattern: /:\(\)\s*\{.*\|.*&.*\}/, description: "fork bomb" },
	{ pattern: /\bsystemctl\s+(stop|disable|mask)\b/i, description: "service shutdown" },
	{ pattern: /\bswapoff\b/i, description: "swap disable" },
	{ pattern: /\bsysctl\s+-w\b/i, description: "kernel parameter change" },
	{ pattern: /\bcrontab\s+-r\b/i, description: "crontab wipe" },

	// --- Network & remote code execution ---
	{ pattern: /\b(curl|wget)\b[^|;&]*\|\s*(ba|z|da)?sh\b/i, description: "piping a download into a shell" },
	{ pattern: /\biptables\s+(-F\b|--flush)/i, description: "firewall flush" },
	{ pattern: /\bufw\s+disable\b/i, description: "firewall disable" },
	{ pattern: /\bfirewall-cmd\b.*--panic/i, description: "firewall panic mode" },
	{ pattern: /\b(nc|ncat|netcat)\b.*\s(-e\b|--exec\b)/i, description: "netcat shell (backdoor)" },
	{ pattern: />>?\s*\S*authorized_keys/i, description: "SSH authorized_keys write" },

	// --- Git history & data loss ---
	{ pattern: /\bgit\s+push\b.*(\s--force\b(?!-with-lease)|\s-f\b)/i, description: "force push" },
	{ pattern: /\bgit\s+reset\s+--hard\b/i, description: "hard reset" },
	{ pattern: /\bgit\s+clean\b.*\s-[a-z]*f/i, description: "untracked file deletion" },
	{ pattern: /\bgit\s+branch\s+-D\b/, description: "force branch delete" },
	{ pattern: /\bgit\s+push\b.*\s--delete\b/i, description: "remote branch delete" },

	// --- Secrets & audit trail ---
	{ pattern: /\.ssh\/id_\w+/i, description: "SSH key access" },
	{ pattern: /\bhistory\s+-c\b/i, description: "shell history wipe" },
	{ pattern: /\bjournalctl\b.*--vacuum/i, description: "log destruction" },
	{ pattern: /\brm\b.*\/var\/log\//i, description: "log deletion" },
	{ pattern: /\bLD_PRELOAD=/, description: "library preload hijack" },

	// --- Packages & filesystem ---
	{ pattern: /\b(apt(-get)?|yum|dnf)\s+(remove|purge|autoremove)\b/i, description: "package removal" },
	{ pattern: /\bumount\b/i, description: "filesystem unmount" },
	{ pattern: /\bmount\s+\S/i, description: "filesystem mount" },
	{ pattern: /\bln\s+-\w*f\w*\s+\S+\s+\/(etc|bin|sbin|lib|usr)\//i, description: "forced symlink into system path" },
];

// --- Tier 2: read-only commands that run without confirmation ---------------

// Each segment of the command line (split on &&, ||, ;, |) must start with
// one of these to skip the confirmation dialog.
const readOnlyPatterns: RegExp[] = [
	/^cd\b/,
	/^(ls|pwd|tree|du|df|stat|file|realpath|readlink|basename|dirname)\b/,
	/^(cat|head|tail|less|more|bat)\b/,
	/^(grep|rg|fd|wc|sort|uniq|cut|tr|diff|cmp|comm|column|xxd|strings)\b/,
	/^find\b(?!.*\s-(exec|execdir|delete|ok|okdir)\b)/,
	/^(echo|printf|test|true|false|sleep)\b/,
	/^(which|whereis|type|command\s+-v)\b/,
	/^(env|printenv|uname|hostname|whoami|id|date|cal|uptime|nproc|arch)\b/,
	/^(ps|top|htop|free|pgrep|jobs)\b/,
	/^git\s+(status|log|diff|show|shortlog|blame|describe|remote(\s+-v)?|branch(\s+(-a|-r|-v|--list|--show-current))?|tag(\s+(-l|--list))?|stash\s+list|config\s+(--get|--list|-l)|rev-parse|rev-list|ls-files|ls-tree|ls-remote|cat-file|reflog(\s+show)?|worktree\s+list|count-objects)\b/,
	/^(npm|pnpm)\s+(list|ls|view|info|search|outdated|audit(?!\s+fix)|why|root|prefix)\b/,
	/^yarn\s+(list|info|why|audit)\b/,
	/^(node|npm|npx|python3?|pip3?|go|cargo|rustc|java|ruby|perl|php|tsc|deno|bun)\s+(--version|-v|version)\b/,
	/^(jq|yq)\b/,
	/^awk\b(?!.*-i\b)/,
	/^sed\s+-n\b/,
	/^(md5sum|sha\d+sum|cksum|b2sum)\b/,
	/^(curl|wget\s+-O\s*-)\s/,
];

// Redirections that don't write to a file
const harmlessRedirects = /\d?>&\d|\d?>{1,2}\s*\/dev\/null/g;

export function isReadOnly(command: string): boolean {
	// Any remaining output redirection writes to a file
	const stripped = command.replace(harmlessRedirects, "");
	if (/>/.test(stripped)) return false;

	const segments = stripped
		.split(/&&|\|\||[;|\n]/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

	return segments.length > 0 && segments.every((segment) => readOnlyPatterns.some((p) => p.test(segment)));
}

// --- Extension ---------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = event.input.command as string;

		// Tier 1: hard block, no override
		const match = dangerousPatterns.find(({ pattern }) => pattern.test(command));
		if (match) {
			return { block: true, reason: `Dangerous command blocked by policy (${match.description})` };
		}

		// Tier 2: read-only, run freely
		if (isReadOnly(command)) return undefined;

		// Tier 3: anything else needs explicit user approval
		if (!ctx.hasUI) {
			return {
				block: true,
				reason: "Command requires user confirmation but no UI is available (non-interactive mode)",
			};
		}

		const approved = await ctx.ui.confirm(
			"Command requires confirmation",
			`This command may modify the filesystem or system state:\n\n${command}\n\nAllow it?`,
		);
		if (!approved) {
			return { block: true, reason: "Command denied by user" };
		}

		return undefined;
	});
}
