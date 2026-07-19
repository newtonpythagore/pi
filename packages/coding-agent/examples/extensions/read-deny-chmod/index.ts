/**
 * Read Deny (chmod) Extension
 *
 * The simpler sibling of `read-blocklist/`: instead of intercepting tools,
 * it removes read permission from listed files/directories at the OS level
 * for the whole pi session, and restores the original permissions on exit.
 * See README.md for design, guarantees, and comparison with read-blocklist.
 *
 * - Exact paths only (no wildcards) in `.pi-read-deny.json` at the project
 *   root: files lose read (a-r), directories lose read+traverse (a-rx).
 * - Original modes are persisted to `.pi/read-deny.state.json` BEFORE
 *   locking, so a crashed session is auto-repaired at next startup.
 * - An inotify watcher (fs.watch) instantly re-locks a path if its
 *   permissions are changed while pi runs. Zero polling, zero overhead.
 * - Bash commands using chmod/chown/chattr/setfacl on a protected path are
 *   blocked up front (heuristic; the watcher is the safety net).
 *
 * Usage:
 *   pi -e ./examples/extensions/read-deny-chmod
 *
 * Commands: /read-deny (status), /read-deny restore, /read-deny lock
 *
 * Unix only (Linux/macOS). Note: run as a regular user — root bypasses
 * permission checks entirely.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, watch, writeFileSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import {
	buildNeedles,
	type DenyEntry,
	isUnlocked,
	lockMode,
	parseState,
	scanChmodCommand,
	serializeState,
} from "./perms.ts";

const CONFIG_FILE = ".pi-read-deny.json";
const STATE_FILE = "read-deny.state.json";

let entries: DenyEntry[] = [];
let needles: string[] = [];
let watchers = new Map<string, FSWatcher>();
let active = false;
let exitHookInstalled = false;

function statePath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, STATE_FILE);
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

/** Read the list of exact paths from `.pi-read-deny.json`. */
function loadConfig(ctx: ExtensionContext): string[] {
	const configPath = resolve(ctx.cwd, CONFIG_FILE);
	if (!existsSync(configPath)) return [];
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(configPath, "utf8"));
	} catch (err) {
		notify(ctx, `read-deny: invalid ${CONFIG_FILE}: ${String(err)}`, "error");
		return [];
	}
	const list = Array.isArray(raw)
		? raw
		: raw && typeof raw === "object"
			? (raw as Record<string, unknown>).denied
			: undefined;
	if (!Array.isArray(list)) return [];
	const paths: string[] = [];
	for (const entry of list) {
		if (typeof entry !== "string" || !entry.trim()) continue;
		const p = entry.trim();
		if (/[*?[\]]/.test(p)) {
			notify(ctx, `read-deny: wildcards are not supported, ignoring "${p}" (use read-blocklist for globs)`, "warning");
			continue;
		}
		if (!paths.includes(p)) paths.push(p);
	}
	return paths;
}

/** Restore permissions saved by a previous session that crashed. */
function restoreStaleState(ctx: ExtensionContext): void {
	const file = statePath(ctx.cwd);
	if (!existsSync(file)) return;
	let stale: DenyEntry[] = [];
	try {
		stale = parseState(readFileSync(file, "utf8"));
	} catch {
		// Unreadable state file: nothing we can safely restore.
	}
	let restored = 0;
	for (const entry of stale) {
		try {
			chmodSync(entry.path, entry.originalMode);
			restored++;
		} catch {
			// Path gone; nothing to restore.
		}
	}
	try {
		unlinkSync(file);
	} catch {
		// Best effort.
	}
	if (restored > 0) {
		notify(ctx, `read-deny: restored permissions of ${restored} path(s) left locked by a previous session`, "info");
	}
}

/** Snapshot current modes, persist them, then remove read permissions. */
function lockAll(ctx: ExtensionContext, configuredPaths: string[]): void {
	entries = [];
	for (const p of configuredPaths) {
		const abs = isAbsolute(p) ? resolve(p) : resolve(ctx.cwd, p);
		let mode: number;
		let isDir: boolean;
		try {
			const st = statSync(abs);
			mode = st.mode & 0o7777;
			isDir = st.isDirectory();
		} catch {
			notify(ctx, `read-deny: "${p}" not found, skipping`, "warning");
			continue;
		}
		entries.push({ path: abs, originalMode: mode, isDir });
	}
	if (entries.length === 0) return;

	// Persist original modes BEFORE chmod so a crash is always recoverable.
	const file = statePath(ctx.cwd);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, serializeState(entries), "utf8");

	for (const entry of entries) {
		try {
			chmodSync(entry.path, lockMode(entry.originalMode, entry.isDir));
		} catch (err) {
			notify(ctx, `read-deny: could not lock ${entry.path}: ${String(err)}`, "error");
		}
	}
	needles = buildNeedles(ctx.cwd, configuredPaths);
	active = true;
	notify(ctx, `read-deny: read access removed on ${entries.length} path(s) for this session`, "info");
}

/** Restore all original permissions and drop the state file. */
function restoreAll(ctx?: ExtensionContext): void {
	for (const watcher of watchers.values()) watcher.close();
	watchers.clear();
	if (!active) return;
	for (const entry of entries) {
		try {
			chmodSync(entry.path, entry.originalMode);
		} catch {
			// Path gone; nothing to restore.
		}
	}
	if (ctx) {
		try {
			unlinkSync(statePath(ctx.cwd));
		} catch {
			// Best effort.
		}
	}
	active = false;
}

/** Re-lock an entry if its permissions were changed behind our back. */
function relockIfNeeded(ctx: ExtensionContext, entry: DenyEntry): void {
	if (!active) return;
	let mode: number;
	try {
		mode = statSync(entry.path).mode & 0o7777;
	} catch {
		return; // Deleted; the rename handler deals with recreation.
	}
	if (isUnlocked(mode, entry.isDir)) {
		try {
			chmodSync(entry.path, lockMode(entry.originalMode, entry.isDir));
			notify(ctx, `read-deny: permissions of ${entry.path} were changed externally — re-locked`, "warning");
		} catch (err) {
			notify(ctx, `read-deny: failed to re-lock ${entry.path}: ${String(err)}`, "error");
		}
	}
}

/** Watch every protected path via inotify; re-lock instantly on change. */
function watchAll(ctx: ExtensionContext): void {
	for (const entry of entries) {
		installWatch(ctx, entry);
	}
}

function installWatch(ctx: ExtensionContext, entry: DenyEntry): void {
	watchers.get(entry.path)?.close();
	watchers.delete(entry.path);
	let watcher: FSWatcher;
	try {
		watcher = watch(entry.path, (eventType) => {
			if (eventType === "rename") {
				// Path deleted or recreated: re-arm the watch, then re-lock.
				installWatch(ctx, entry);
			}
			relockIfNeeded(ctx, entry);
		});
	} catch {
		// Path currently missing; nothing to watch until it comes back.
		return;
	}
	watcher.on("error", () => {
		watcher.close();
		watchers.delete(entry.path);
	});
	watchers.set(entry.path, watcher);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		// Repair first (previous crash), then lock this session's paths.
		restoreAll(ctx);
		restoreStaleState(ctx);
		const paths = loadConfig(ctx);
		if (paths.length === 0) return;
		lockAll(ctx, paths);
		watchAll(ctx);

		// Last-resort belt: restore synchronously if the process exits without
		// a clean session_shutdown (uncaught exception, etc.).
		if (!exitHookInstalled) {
			exitHookInstalled = true;
			process.on("exit", () => {
				for (const entry of entries) {
					if (!active) break;
					try {
						chmodSync(entry.path, entry.originalMode);
					} catch {
						// Best effort.
					}
				}
			});
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		restoreAll(ctx);
	});

	// Refuse obvious attempts to lift the lock via bash. The watcher above is
	// the safety net for anything this heuristic misses.
	pi.on("tool_call", (event, ctx) => {
		if (!active || !isToolCallEventType("bash", event)) return undefined;
		const hit = scanChmodCommand(event.input.command ?? "", needles);
		if (hit) {
			notify(ctx, `read-deny: blocked permission change on protected path (${hit})`, "warning");
			return {
				block: true,
				reason: `Tu n'as pas le droit de lire ce fichier ou dossier ("${hit}") et ne tente pas de contourner cette protection par des commandes système ou tout autre moyen.`,
			};
		}
		return undefined;
	});

	pi.registerCommand("read-deny", {
		description: "Read-deny status; 'restore' unlocks now, 'lock' re-applies",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim();
			if (arg === "restore") {
				restoreAll(ctx);
				notify(ctx, "read-deny: original permissions restored (until next session start)", "info");
				return;
			}
			if (arg === "lock") {
				restoreAll(ctx);
				const paths = loadConfig(ctx);
				if (paths.length > 0) {
					lockAll(ctx, paths);
					watchAll(ctx);
				}
				return;
			}
			const lines =
				entries.length === 0
					? ["read-deny: no protected paths (create " + CONFIG_FILE + " at the project root)"]
					: entries.map(
							(e) =>
								`${active ? "locked" : "unlocked"}  ${e.path}  (original mode ${e.originalMode.toString(8).padStart(4, "0")}${e.isDir ? ", dir" : ""})`,
						);
			notify(ctx, lines.join("\n"), "info");
		},
	});
}
