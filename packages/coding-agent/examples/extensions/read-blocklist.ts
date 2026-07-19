/**
 * Read Blocklist Extension
 *
 * Forbids reading configured files and directories. Blocks the built-in
 * `read`, `grep`, and `find` tools when they target a protected path, and
 * inspects `bash` commands for references to protected paths (so the agent
 * cannot bypass the block with `cat`, `less`, `head`, etc.).
 *
 * ## Configuration (per working directory)
 *
 * Create a `.pi-read-blocklist.json` file at the ROOT of your working
 * directory. Each working directory can have its own blocklist. The file is
 * re-read automatically whenever it changes — no restart needed.
 *
 * Two accepted shapes:
 *
 *   ["**\/*.pem", "secrets/**", ".env"]
 *
 * or:
 *
 *   { "blocked": ["**\/*.pem", "secrets/**", ".env"] }
 *
 * ## Glob syntax (gitignore-like)
 *
 *   *   → matches anything within a single path segment   (e.g. `*.pem`)
 *   **  → matches across directory levels                 (e.g. `secrets/**`)
 *   ?   → matches a single character
 *
 * A pattern WITHOUT a slash (e.g. `.env`, `*.key`) matches by basename
 * anywhere in the tree, and also matches any directory of that name plus its
 * contents. A pattern WITH a slash (e.g. `config/prod.key`) is matched
 * relative to the working-directory root.
 *
 * Usage:
 *   pi -e ./examples/extensions/read-blocklist.ts
 * or copy to ~/.pi/agent/extensions/ (or .pi/extensions/) for auto-discovery.
 */

import { readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

const CONFIG_FILE = ".pi-read-blocklist.json";

/** Convert a single gitignore-style glob into an anchored RegExp. */
function globToRegExp(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				// `**/` matches zero or more directories; bare `**` matches anything.
				if (glob[i + 2] === "/") {
					re += "(?:.*/)?";
					i += 2;
				} else {
					re += ".*";
					i += 1;
				}
			} else {
				re += "[^/]*";
			}
		} else if (c === "?") {
			re += "[^/]";
		} else if (".+^${}()|[]\\/".includes(c)) {
			re += `\\${c}`;
		} else {
			re += c;
		}
	}
	return new RegExp(`^${re}$`);
}

interface CompiledPattern {
	source: string;
	hasSlash: boolean;
	hasGlob: boolean;
	regex: RegExp;
}

function compilePattern(pattern: string): CompiledPattern {
	// Normalize: drop leading "./" and a single leading "/" (root-anchored).
	let p = pattern.trim().replace(/^\.\//, "").replace(/^\//, "");
	// A trailing "/" (directory marker) becomes a "match everything under it".
	if (p.endsWith("/")) p = `${p}**`;
	return {
		source: pattern,
		hasSlash: p.includes("/"),
		hasGlob: /[*?]/.test(p),
		regex: globToRegExp(p),
	};
}

interface Blocklist {
	patterns: CompiledPattern[];
	/** Literal (non-glob) path fragments, used for cheap bash substring checks. */
	literals: string[];
}

let cache: { mtimeMs: number; path: string; list: Blocklist } | undefined;
const EMPTY: Blocklist = { patterns: [], literals: [] };

/** Load and cache the blocklist for the current working directory. */
function loadBlocklist(ctx: ExtensionContext): Blocklist {
	const configPath = resolve(ctx.cwd, CONFIG_FILE);
	let mtimeMs: number;
	try {
		mtimeMs = statSync(configPath).mtimeMs;
	} catch {
		cache = undefined;
		return EMPTY;
	}
	if (cache && cache.path === configPath && cache.mtimeMs === mtimeMs) {
		return cache.list;
	}
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(configPath, "utf8"));
	} catch (err) {
		if (ctx.hasUI) {
			ctx.ui.notify(`read-blocklist: invalid ${CONFIG_FILE}: ${String(err)}`, "error");
		}
		return EMPTY;
	}
	const entries: unknown = Array.isArray(raw)
		? raw
		: raw && typeof raw === "object"
			? ((raw as Record<string, unknown>).blocked ?? (raw as Record<string, unknown>).paths)
			: undefined;
	const list: Blocklist = { patterns: [], literals: [] };
	if (Array.isArray(entries)) {
		for (const entry of entries) {
			if (typeof entry !== "string" || entry.trim() === "") continue;
			const compiled = compilePattern(entry);
			list.patterns.push(compiled);
			if (!compiled.hasGlob) list.literals.push(entry.trim().replace(/^\.\//, ""));
		}
	}
	cache = { mtimeMs, path: configPath, list };
	return list;
}

/** Does the given path (relative or absolute) hit any blocklist pattern? */
function matchPath(list: Blocklist, ctx: ExtensionContext, targetPath: string): CompiledPattern | undefined {
	if (list.patterns.length === 0) return undefined;
	const abs = isAbsolute(targetPath) ? targetPath : resolve(ctx.cwd, targetPath);
	const rel = relative(ctx.cwd, abs).split("\\").join("/");
	const name = basename(abs);
	const segments = rel.split("/").filter(Boolean);

	for (const pat of list.patterns) {
		if (pat.hasSlash) {
			// Anchored to the working-directory root.
			if (pat.regex.test(rel)) return pat;
			// Also block contents of a matched directory path.
			if (rel === pat.source || rel.startsWith(`${pat.source.replace(/\/$/, "")}/`)) return pat;
		} else {
			// Matches by basename anywhere, or any directory segment of that name.
			if (pat.regex.test(name)) return pat;
			if (segments.some((seg) => pat.regex.test(seg))) return pat;
		}
	}
	return undefined;
}

/** Heuristically scan a bash command for references to blocked paths. */
function scanBashCommand(list: Blocklist, ctx: ExtensionContext, command: string): CompiledPattern | undefined {
	if (list.patterns.length === 0) return undefined;

	// Cheap win: any literal blocked path mentioned verbatim in the command.
	for (const literal of list.literals) {
		if (command.includes(literal)) {
			const pat = list.patterns.find((p) => p.source.trim().replace(/^\.\//, "") === literal);
			if (pat) return pat;
		}
	}

	// Tokenize on shell metacharacters and whitespace, strip quotes, then test
	// each path-like token against the blocklist.
	const tokens = command
		.split(/[\s|&;<>()`"']+/)
		.map((t) => t.replace(/^~(?=\/|$)/, ""))
		.filter((t) => t && !t.startsWith("-"));
	for (const token of tokens) {
		// Skip obvious non-paths (env assignments handled by their value below).
		const value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : token;
		if (!value) continue;
		const hit = matchPath(list, ctx, value);
		if (hit) return hit;
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		const list = loadBlocklist(ctx);
		if (list.patterns.length === 0) return undefined;

		// read / grep / find all take a `path` pointing at the read target.
		if (
			isToolCallEventType("read", event) ||
			isToolCallEventType("grep", event) ||
			isToolCallEventType("find", event)
		) {
			const path = (event.input as { path?: string }).path;
			if (typeof path === "string" && path) {
				const hit = matchPath(list, ctx, path);
				if (hit) {
					if (ctx.hasUI) ctx.ui.notify(`Blocked read of protected path: ${path}`, "warning");
					return { block: true, reason: `Reading "${path}" is blocked (matches "${hit.source}")` };
				}
			}
			return undefined;
		}

		// bash: inspect the command for references to blocked paths.
		if (isToolCallEventType("bash", event)) {
			const hit = scanBashCommand(list, ctx, event.input.command ?? "");
			if (hit) {
				if (ctx.hasUI) {
					ctx.ui.notify(`Blocked bash command referencing protected path (${hit.source})`, "warning");
				}
				return {
					block: true,
					reason: `Command references a protected path matching "${hit.source}"; reading it is blocked.`,
				};
			}
		}

		return undefined;
	});
}
