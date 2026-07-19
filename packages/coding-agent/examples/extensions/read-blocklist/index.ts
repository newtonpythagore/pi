/**
 * Read Blocklist Extension
 *
 * Forbids reading configured files and directories. See README.md for the
 * full design, guarantees, and the relationship with the sandbox extension.
 *
 * - `read`, `grep`, `find` targeting a protected path are blocked before
 *   execution (symlinks resolved).
 * - `grep`/`find` results are post-filtered so matches coming from protected
 *   files never reach the LLM, even when the search scanned a whole directory.
 * - `read` results are re-checked after execution (TOCTOU defense).
 * - `bash` commands are heuristically scanned for protected paths, and the
 *   blocklist is synced into `.pi/sandbox.json` `filesystem.denyRead` so the
 *   sandbox extension can enforce it at the OS level.
 *
 * Configuration: `.pi-read-blocklist.json` at the root of the working
 * directory (one blocklist per project, re-read automatically on change):
 *
 *   {
 *     "blocked": [".env", "*.pem", "secrets/**"],
 *     "ignoreCase": false,
 *     "syncSandbox": true
 *   }
 *
 * A bare JSON array is also accepted.
 *
 * Usage:
 *   pi -e ./examples/extensions/read-blocklist
 * or copy the directory to ~/.pi/agent/extensions/ for auto-discovery.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import {
	type CompiledPattern,
	compilePattern,
	filterFindOutput,
	filterGrepOutput,
	matchPath,
	mergeSandboxConfig,
	scanBashCommand,
} from "./logic.ts";

const CONFIG_FILE = ".pi-read-blocklist.json";

interface Blocklist {
	patterns: CompiledPattern[];
	/** Literal (non-glob) path fragments, used for cheap bash substring checks. */
	literals: string[];
	/** Raw pattern strings, used for sandbox denyRead sync. */
	raw: string[];
	syncSandbox: boolean;
}

const EMPTY: Blocklist = { patterns: [], literals: [], raw: [], syncSandbox: false };

let cache: { mtimeMs: number; path: string; list: Blocklist } | undefined;

/** Load the blocklist for the current cwd; sync sandbox config on change. */
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

	let entries: unknown;
	let ignoreCase = false;
	let syncSandbox = true;
	if (Array.isArray(raw)) {
		entries = raw;
	} else if (raw && typeof raw === "object") {
		const obj = raw as Record<string, unknown>;
		entries = obj.blocked ?? obj.paths;
		ignoreCase = obj.ignoreCase === true;
		syncSandbox = obj.syncSandbox !== false;
	}

	const list: Blocklist = { patterns: [], literals: [], raw: [], syncSandbox };
	if (Array.isArray(entries)) {
		for (const entry of entries) {
			if (typeof entry !== "string" || entry.trim() === "") continue;
			const compiled = compilePattern(entry, ignoreCase);
			list.patterns.push(compiled);
			list.raw.push(entry.trim());
			if (!compiled.hasGlob) list.literals.push(entry.trim().replace(/^\.\//, ""));
		}
	}
	cache = { mtimeMs, path: configPath, list };
	syncSandboxDenyRead(ctx, list);
	return list;
}

/** Write blocklist entries into `.pi/sandbox.json` filesystem.denyRead. */
function syncSandboxDenyRead(ctx: ExtensionContext, list: Blocklist): void {
	if (!list.syncSandbox) return;
	const sandboxPath = join(ctx.cwd, CONFIG_DIR_NAME, "sandbox.json");
	let sandbox: Record<string, unknown> = {};
	try {
		sandbox = JSON.parse(readFileSync(sandboxPath, "utf8"));
	} catch {
		// Missing or invalid file: start from an empty config.
	}
	const updated = mergeSandboxConfig(sandbox, list.raw);
	if (!updated) return;
	try {
		mkdirSync(dirname(sandboxPath), { recursive: true });
		writeFileSync(sandboxPath, `${JSON.stringify(updated, null, "\t")}\n`, "utf8");
		if (ctx.hasUI) {
			ctx.ui.notify(
				`read-blocklist: synced ${list.raw.length} pattern(s) to ${CONFIG_DIR_NAME}/sandbox.json denyRead ` +
					`(sandbox extension picks this up at startup — /reload if it is already running)`,
				"info",
			);
		}
	} catch (err) {
		if (ctx.hasUI) {
			ctx.ui.notify(`read-blocklist: could not write ${sandboxPath}: ${String(err)}`, "error");
		}
	}
}

/** Resolve grep/find's base directory the same way the tools do. */
function searchBaseDir(ctx: ExtensionContext, searchPath: string | undefined): string {
	const abs = searchPath
		? isAbsolute(searchPath)
			? resolve(searchPath)
			: resolve(ctx.cwd, searchPath)
		: ctx.cwd;
	try {
		return statSync(abs).isDirectory() ? abs : dirname(abs);
	} catch {
		return abs;
	}
}

function firstTextIndex(content: Array<{ type: string; text?: string }>): number {
	return content.findIndex((c) => c.type === "text" && typeof c.text === "string");
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		// Load early so the sandbox sync happens before any tool runs.
		loadBlocklist(ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		const list = loadBlocklist(ctx);
		if (list.patterns.length === 0) return undefined;

		// read / grep / find: block when the explicit target is protected
		// (matchPath also checks the symlink-resolved real path).
		if (
			isToolCallEventType("read", event) ||
			isToolCallEventType("grep", event) ||
			isToolCallEventType("find", event)
		) {
			const path = (event.input as { path?: string }).path;
			if (typeof path === "string" && path) {
				const hit = matchPath(list.patterns, ctx.cwd, path);
				if (hit) {
					if (ctx.hasUI) ctx.ui.notify(`Blocked read of protected path: ${path}`, "warning");
					return { block: true, reason: `Reading "${path}" is blocked (matches "${hit.source}")` };
				}
			}
			return undefined;
		}

		// bash: heuristic scan. Real enforcement is the sandbox denyRead layer.
		if (isToolCallEventType("bash", event)) {
			const hit = scanBashCommand(list.patterns, list.literals, ctx.cwd, event.input.command ?? "");
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

	// Output-side defense: even when a search legitimately scanned a whole
	// directory tree, results from protected files never reach the LLM.
	pi.on("tool_result", async (event, ctx) => {
		const list = loadBlocklist(ctx);
		if (list.patterns.length === 0 || event.isError) return undefined;

		if (event.toolName === "read") {
			// Re-check after execution (closes the check-then-read race).
			const path = (event.input as { path?: string }).path;
			if (typeof path === "string" && path && matchPath(list.patterns, ctx.cwd, path)) {
				return {
					content: [{ type: "text", text: `Reading "${path}" is blocked by the read blocklist.` }],
					details: undefined,
					isError: true,
				};
			}
			return undefined;
		}

		if (event.toolName !== "grep" && event.toolName !== "find") return undefined;

		const content = event.content as Array<{ type: string; text?: string }>;
		const idx = firstTextIndex(content);
		if (idx === -1) return undefined;
		const text = content[idx].text as string;

		const baseDir = searchBaseDir(ctx, (event.input as { path?: string }).path);
		const filtered =
			event.toolName === "grep"
				? filterGrepOutput(list.patterns, ctx.cwd, baseDir, text)
				: filterFindOutput(list.patterns, ctx.cwd, baseDir, text);
		if (filtered.removed === 0) return undefined;

		const note = `[${filtered.removed} result(s) hidden: protected by read blocklist]`;
		const body = filtered.text.trim() === "" ? (event.toolName === "grep" ? "No matches found" : "No files found matching pattern") : filtered.text;
		const newContent = content.slice();
		newContent[idx] = { type: "text", text: `${body}\n${note}` };
		return { content: newContent };
	});
}
