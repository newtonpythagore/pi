/**
 * Unit tests for the read-blocklist pure logic.
 *
 * Run with: node --experimental-strip-types test.ts
 * (plain `node test.ts` on Node >= 22.18)
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	compilePattern,
	filterFindOutput,
	filterGrepOutput,
	matchPath,
	mergeSandboxConfig,
	SANDBOX_MANAGED_KEY,
	scanBashCommand,
	toSandboxGlobs,
} from "./logic.ts";

let pass = 0;
let fail = 0;
function check(desc: string, got: unknown, want: unknown): void {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (ok) pass++;
	else {
		fail++;
		console.log(`FAIL: ${desc}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
	}
}
function checkHit(desc: string, got: { source: string } | undefined, want: boolean): void {
	check(desc, Boolean(got), want);
}

// ---- Fixture: real directory tree with real symlinks --------------------
const root = realpathSync(mkdtempSync(join(tmpdir(), "read-blocklist-test-")));
mkdirSync(join(root, "secrets"), { recursive: true });
mkdirSync(join(root, "src"), { recursive: true });
writeFileSync(join(root, ".env"), "SECRET=1\n");
writeFileSync(join(root, "server.pem"), "PEM\n");
writeFileSync(join(root, "secrets", "db.txt"), "password\n");
writeFileSync(join(root, "src", "app.ts"), "code\n");
symlinkSync(join(root, ".env"), join(root, "linkfile"));
symlinkSync(join(root, "secrets"), join(root, "linkdir"));

const patterns = [".env", "*.pem", "secrets/**", "config/prod.key"].map((p) => compilePattern(p));
const literals = [".env", "config/prod.key"];

// ---- Direct path matching ----------------------------------------------
checkHit(".env blocked", matchPath(patterns, root, ".env"), true);
checkHit("src/.env blocked (basename)", matchPath(patterns, root, "src/.env"), true);
checkHit("server.pem blocked", matchPath(patterns, root, "server.pem"), true);
checkHit("secrets/db.txt blocked", matchPath(patterns, root, "secrets/db.txt"), true);
checkHit("secrets/a/b blocked (deep)", matchPath(patterns, root, "secrets/a/b"), true);
checkHit("absolute path blocked", matchPath(patterns, root, join(root, "secrets", "db.txt")), true);
checkHit("config/prod.key blocked", matchPath(patterns, root, "config/prod.key"), true);
checkHit("README.md allowed", matchPath(patterns, root, "README.md"), false);
checkHit("src/app.ts allowed", matchPath(patterns, root, "src/app.ts"), false);
checkHit("environment.ts allowed", matchPath(patterns, root, "src/environment.ts"), false);
checkHit("cert.pem.txt allowed", matchPath(patterns, root, "public/cert.pem.txt"), false);

// ---- Symlink resolution (real symlinks on disk) ------------------------
checkHit("symlink to blocked file blocked", matchPath(patterns, root, "linkfile"), true);
checkHit("file via symlinked dir blocked", matchPath(patterns, root, "linkdir/db.txt"), true);
checkHit("nonexistent under symlinked dir blocked", matchPath(patterns, root, "linkdir/nope.txt"), true);

// ---- Case sensitivity ---------------------------------------------------
const ciPatterns = [".env"].map((p) => compilePattern(p, true));
checkHit("ignoreCase: .ENV blocked", matchPath(ciPatterns, root, ".ENV"), true);
checkHit("default: .ENV not matched (case-sensitive)", matchPath(patterns, root, ".ENV"), false);

// ---- Bash scanning ------------------------------------------------------
checkHit("cat .env blocked", scanBashCommand(patterns, literals, root, "cat .env"), true);
checkHit("redirection < .env blocked", scanBashCommand(patterns, literals, root, "wc -l < .env"), true);
checkHit("python open('.env') blocked", scanBashCommand(patterns, literals, root, `python3 -c "print(open('.env').read())"`), true);
checkHit("cat linkfile blocked (symlink)", scanBashCommand(patterns, literals, root, "cat linkfile"), true);
checkHit("piped cat .env blocked", scanBashCommand(patterns, literals, root, "cat x | grep y && cat .env"), true);
checkHit("ls -la allowed", scanBashCommand(patterns, literals, root, "ls -la"), false);
checkHit("cat README.md allowed", scanBashCommand(patterns, literals, root, "cat README.md"), false);

// ---- Grep output filtering ---------------------------------------------
const grepOutput = [
	"src/app.ts:1: code",
	"secrets/db.txt:1: password",
	".env:1: SECRET=1",
	"src/app.ts-2- context line",
	"secrets/db.txt-2- context",
	"[3 matches shown]",
].join("\n");
const grepFiltered = filterGrepOutput(patterns, root, root, grepOutput);
check("grep filter removes protected lines", grepFiltered.removed, 3);
check(
	"grep filter keeps allowed + notice lines",
	grepFiltered.text,
	["src/app.ts:1: code", "src/app.ts-2- context line", "[3 matches shown]"].join("\n"),
);

// grep through a symlinked directory as base: rg reports paths relative to it
const grepViaLink = filterGrepOutput(patterns, root, join(root, "linkdir"), "db.txt:1: password");
check("grep filter resolves symlinked base dir", grepViaLink.removed, 1);

// ---- Find output filtering ----------------------------------------------
const findFiltered = filterFindOutput(patterns, root, root, ["src/app.ts", "secrets/db.txt", "server.pem", "linkfile"].join("\n"));
check("find filter removes protected paths (incl. symlink)", findFiltered.removed, 3);
check("find filter keeps allowed paths", findFiltered.text, "src/app.ts");

// ---- Sandbox glob translation -------------------------------------------
check(
	"toSandboxGlobs expands dir patterns",
	toSandboxGlobs([".env", "secrets/**", ".ssh/", "*.pem"]),
	[".env", "secrets", "secrets/**", ".ssh", ".ssh/**", "*.pem"],
);

// ---- Sandbox config merge -----------------------------------------------
// 1. Fresh config
const merged1 = mergeSandboxConfig({}, [".env", "secrets/**"]) as Record<string, unknown>;
check(
	"merge into empty sandbox config",
	(merged1.filesystem as Record<string, unknown>).denyRead,
	[".env", "secrets", "secrets/**"],
);
// 2. Preserves user entries, replaces stale managed ones
const merged2 = mergeSandboxConfig(
	{
		filesystem: { denyRead: ["~/.ssh", ".env", "old-secret"], allowWrite: ["."] },
		[SANDBOX_MANAGED_KEY]: [".env", "old-secret"],
	},
	["*.pem"],
) as Record<string, unknown>;
check(
	"merge preserves user entries and drops stale managed ones",
	(merged2.filesystem as Record<string, unknown>).denyRead,
	["~/.ssh", "*.pem"],
);
check("merge keeps unrelated filesystem keys", (merged2.filesystem as Record<string, unknown>).allowWrite, ["."]);
// 3. No-op when already in sync
const inSync = {
	filesystem: { denyRead: [".env"] },
	[SANDBOX_MANAGED_KEY]: [".env"],
};
check("merge is a no-op when in sync", mergeSandboxConfig(inSync, [".env"]), undefined);

// ---- Cleanup & report ----------------------------------------------------
rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
