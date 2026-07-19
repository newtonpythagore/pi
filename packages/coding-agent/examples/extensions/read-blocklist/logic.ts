/**
 * Pure logic for the read-blocklist extension: glob compilation, path
 * matching (with symlink resolution), bash command scanning, output
 * filtering for grep/find, and sandbox config merging.
 *
 * No pi imports here so it can be unit-tested with plain `node test.ts`.
 */

import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/** Convert a single gitignore-style glob into an anchored RegExp. */
export function globToRegExp(glob: string, ignoreCase: boolean): RegExp {
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
	return new RegExp(`^${re}$`, ignoreCase ? "i" : "");
}

export interface CompiledPattern {
	source: string;
	hasSlash: boolean;
	hasGlob: boolean;
	regex: RegExp;
}

export function compilePattern(pattern: string, ignoreCase = false): CompiledPattern {
	// Normalize: drop leading "./" and a single leading "/" (root-anchored).
	let p = pattern.trim().replace(/^\.\//, "").replace(/^\//, "");
	// A trailing "/" (directory marker) becomes a "match everything under it".
	if (p.endsWith("/")) p = `${p}**`;
	return {
		source: pattern,
		hasSlash: p.includes("/"),
		hasGlob: /[*?]/.test(p),
		regex: globToRegExp(p, ignoreCase),
	};
}

/**
 * Resolve symlinks in a path. If the path does not exist, resolve the deepest
 * existing ancestor and re-append the remaining segments, so symlinked parent
 * directories are still resolved.
 */
export function resolveReal(absPath: string): string {
	try {
		return realpathSync(absPath);
	} catch {
		// Path may not exist (yet); resolve the deepest existing ancestor.
	}
	let prefix = absPath;
	const suffix: string[] = [];
	while (true) {
		const parent = dirname(prefix);
		if (parent === prefix) break;
		suffix.unshift(basename(prefix));
		prefix = parent;
		try {
			return join(realpathSync(prefix), ...suffix);
		} catch {
			// Keep walking up.
		}
	}
	return absPath;
}

function testOne(patterns: CompiledPattern[], cwd: string, abs: string): CompiledPattern | undefined {
	const rel = relative(cwd, abs).split("\\").join("/");
	const name = basename(abs);
	const segments = rel.split("/").filter(Boolean);

	for (const pat of patterns) {
		if (pat.hasSlash) {
			// Anchored to the working-directory root.
			if (pat.regex.test(rel)) return pat;
			// Also block contents of a matched directory path.
			const bare = pat.source.trim().replace(/^\.\//, "").replace(/\/$/, "");
			if (rel === bare || rel.startsWith(`${bare}/`)) return pat;
		} else {
			// Matches by basename anywhere, or any directory segment of that name.
			if (pat.regex.test(name)) return pat;
			if (segments.some((seg) => pat.regex.test(seg))) return pat;
		}
	}
	return undefined;
}

/**
 * Does the given path (relative or absolute) hit any blocklist pattern?
 * Tests both the path as provided and its symlink-resolved real path.
 */
export function matchPath(
	patterns: CompiledPattern[],
	cwd: string,
	targetPath: string,
): CompiledPattern | undefined {
	if (patterns.length === 0) return undefined;
	const abs = isAbsolute(targetPath) ? resolve(targetPath) : resolve(cwd, targetPath);
	const direct = testOne(patterns, cwd, abs);
	if (direct) return direct;
	const real = resolveReal(abs);
	if (real !== abs) return testOne(patterns, cwd, real);
	return undefined;
}

/**
 * Heuristically scan a bash command for references to blocked paths.
 * This is best-effort only — kernel-level enforcement comes from the sandbox
 * extension's `denyRead` (see README).
 */
export function scanBashCommand(
	patterns: CompiledPattern[],
	literals: string[],
	cwd: string,
	command: string,
): CompiledPattern | undefined {
	if (patterns.length === 0) return undefined;

	// Cheap win: any literal blocked path mentioned verbatim in the command.
	for (const literal of literals) {
		if (command.includes(literal)) {
			const pat = patterns.find((p) => p.source.trim().replace(/^\.\//, "") === literal);
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
		const value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : token;
		if (!value) continue;
		const hit = matchPath(patterns, cwd, value);
		if (hit) return hit;
	}
	return undefined;
}

/** Result of filtering tool output. */
export interface FilterResult {
	text: string;
	removed: number;
}

const GREP_MATCH_LINE = /^(.+?):(\d+): /;
const GREP_CONTEXT_LINE = /^(.+?)-(\d+)- /;

/**
 * Filter grep output: drop every line whose file (resolved against the search
 * base directory, symlinks included) matches the blocklist. Lines that do not
 * look like grep results (notices, "No matches found") are kept.
 */
export function filterGrepOutput(
	patterns: CompiledPattern[],
	cwd: string,
	baseDir: string,
	output: string,
): FilterResult {
	let removed = 0;
	const kept = output.split("\n").filter((line) => {
		const m = GREP_MATCH_LINE.exec(line) ?? GREP_CONTEXT_LINE.exec(line);
		if (!m) return true;
		const candidate = isAbsolute(m[1]) ? m[1] : join(baseDir, m[1]);
		if (matchPath(patterns, cwd, candidate)) {
			removed++;
			return false;
		}
		return true;
	});
	return { text: kept.join("\n"), removed };
}

/**
 * Filter find output: drop every reported path (resolved against the search
 * base directory, symlinks included) that matches the blocklist.
 */
export function filterFindOutput(
	patterns: CompiledPattern[],
	cwd: string,
	baseDir: string,
	output: string,
): FilterResult {
	let removed = 0;
	const kept = output.split("\n").filter((line) => {
		const trimmed = line.trim();
		if (!trimmed || trimmed === "No files found matching pattern") return true;
		const candidate = isAbsolute(trimmed) ? trimmed : join(baseDir, trimmed);
		if (matchPath(patterns, cwd, candidate)) {
			removed++;
			return false;
		}
		return true;
	});
	return { text: kept.join("\n"), removed };
}

/**
 * Translate blocklist patterns into sandbox `denyRead` globs.
 * Directory-style patterns are expanded to cover both the directory entry
 * itself and everything under it.
 */
export function toSandboxGlobs(rawPatterns: string[]): string[] {
	const globs: string[] = [];
	const push = (g: string) => {
		if (g && !globs.includes(g)) globs.push(g);
	};
	for (const raw of rawPatterns) {
		const p = raw.trim().replace(/^\.\//, "");
		if (!p) continue;
		if (p.endsWith("/**")) {
			push(p.slice(0, -3));
			push(p);
		} else if (p.endsWith("/")) {
			push(p.slice(0, -1));
			push(`${p}**`);
		} else {
			push(p);
		}
	}
	return globs;
}

/** Top-level marker key used to track which denyRead entries we manage. */
export const SANDBOX_MANAGED_KEY = "readBlocklistManagedDenyRead";

/**
 * Merge blocklist-derived globs into a sandbox config object (parsed
 * `.pi/sandbox.json`). Entries previously added by this extension (tracked
 * under SANDBOX_MANAGED_KEY) are replaced; entries added manually by the user
 * are preserved. Returns the updated object, or undefined if nothing changed.
 */
export function mergeSandboxConfig(
	sandbox: Record<string, unknown>,
	rawPatterns: string[],
): Record<string, unknown> | undefined {
	const managed = toSandboxGlobs(rawPatterns);
	const prevManaged: string[] = Array.isArray(sandbox[SANDBOX_MANAGED_KEY])
		? (sandbox[SANDBOX_MANAGED_KEY] as string[])
		: [];
	const filesystem =
		sandbox.filesystem && typeof sandbox.filesystem === "object"
			? (sandbox.filesystem as Record<string, unknown>)
			: {};
	const existing: string[] = Array.isArray(filesystem.denyRead) ? (filesystem.denyRead as string[]) : [];

	const userEntries = existing.filter((e) => !prevManaged.includes(e));
	const denyRead = [...userEntries, ...managed.filter((m) => !userEntries.includes(m))];

	const unchanged =
		JSON.stringify(denyRead) === JSON.stringify(existing) &&
		JSON.stringify(managed) === JSON.stringify(prevManaged);
	if (unchanged) return undefined;

	return {
		...sandbox,
		filesystem: { ...filesystem, denyRead },
		[SANDBOX_MANAGED_KEY]: managed,
	};
}
