/**
 * Pure helpers for the read-deny-chmod extension: mode computation, needle
 * building for the chmod-command guard, and state (de)serialization.
 *
 * No pi imports here so it can be unit-tested with plain `node test.ts`.
 */

import { basename, isAbsolute, resolve } from "node:path";

/** Locked mode: chmod 000 — no read, write, or execute for anyone. */
export const LOCKED_MODE = 0o000;

/** True when the path has any permission bit set again and must be re-locked. */
export function isUnlocked(mode: number): boolean {
	return (mode & 0o7777) !== LOCKED_MODE;
}

/** One protected path with its saved original permissions. */
export interface DenyEntry {
	/** Absolute path. */
	path: string;
	/** Original mode bits (st_mode & 0o7777) to restore on exit. */
	originalMode: number;
	isDir: boolean;
}

/** Serialized state file shape, written BEFORE locking so a crash is recoverable. */
export interface DenyState {
	pid: number;
	lockedAt: string;
	entries: DenyEntry[];
}

export function serializeState(entries: DenyEntry[]): string {
	const state: DenyState = { pid: process.pid, lockedAt: new Date().toISOString(), entries };
	return `${JSON.stringify(state, null, "\t")}\n`;
}

export function parseState(raw: string): DenyEntry[] {
	const parsed = JSON.parse(raw) as Partial<DenyState>;
	if (!Array.isArray(parsed.entries)) return [];
	return parsed.entries.filter(
		(e): e is DenyEntry =>
			!!e && typeof e.path === "string" && typeof e.originalMode === "number" && typeof e.isDir === "boolean",
	);
}

/**
 * Strings whose presence in a chmod-family bash command means it targets a
 * protected path: the path as configured, its absolute form, and its basename.
 */
export function buildNeedles(cwd: string, configuredPaths: string[]): string[] {
	const needles = new Set<string>();
	for (const p of configuredPaths) {
		const trimmed = p.trim().replace(/\/+$/, "");
		if (!trimmed) continue;
		needles.add(trimmed);
		needles.add(isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed));
		needles.add(basename(trimmed));
	}
	return [...needles];
}

const PERMISSION_COMMANDS = /(^|[\s;|&(])(chmod|chown|chattr|setfacl)(\s|$)/;

/**
 * Heuristic guard: does this bash command try to change permissions of a
 * protected path? (The inotify watcher is the real safety net; this simply
 * refuses the obvious attempts up front.)
 */
export function scanChmodCommand(command: string, needles: string[]): string | undefined {
	if (!PERMISSION_COMMANDS.test(command)) return undefined;
	return needles.find((n) => command.includes(n));
}
