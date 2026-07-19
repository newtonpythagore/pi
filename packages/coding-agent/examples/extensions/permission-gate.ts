/**
 * Permission Gate Extension
 *
 * Blocks potentially dangerous bash commands unconditionally.
 *
 * Covered categories: data destruction, privilege escalation, system/process
 * disruption, remote code execution, firewall tampering, git history loss,
 * secrets access, audit-trail wiping, and package/filesystem changes.
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

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash") return undefined;

		const command = event.input.command as string;
		const match = dangerousPatterns.find(({ pattern }) => pattern.test(command));

		if (match) {
			return { block: true, reason: `Dangerous command blocked by policy (${match.description})` };
		}

		return undefined;
	});
}
