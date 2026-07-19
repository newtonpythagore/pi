/**
 * Unit tests for the read-deny-chmod helpers plus a real lock/tamper/restore
 * cycle on a temp directory.
 *
 * Run with: node --experimental-strip-types test.ts
 * (plain `node test.ts` on Node >= 22.18)
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildNeedles,
	type DenyEntry,
	isUnlocked,
	lockMode,
	parseState,
	scanChmodCommand,
	serializeState,
} from "./perms.ts";

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

// ---- Mode computation ----------------------------------------------------
check("file 644 locks to 200", lockMode(0o644, false), 0o200);
check("file 600 locks to 200", lockMode(0o600, false), 0o200);
check("dir 755 locks to 200", lockMode(0o755, true), 0o200);
check("dir 700 locks to 200", lockMode(0o700, true), 0o200);
check("locked file is not unlocked", isUnlocked(0o200, false), false);
check("readable file is unlocked", isUnlocked(0o644, false), true);
check("dir with only x is unlocked (traversable)", isUnlocked(0o311, true), true);
check("dir 200 is locked", isUnlocked(0o200, true), false);

// ---- State round-trip ----------------------------------------------------
const stateEntries: DenyEntry[] = [
	{ path: "/p/.env", originalMode: 0o644, isDir: false },
	{ path: "/p/secrets", originalMode: 0o755, isDir: true },
];
check("state survives serialize/parse", parseState(serializeState(stateEntries)), stateEntries);
check("parse tolerates garbage entries", parseState('{"entries":[{"path":1},null]}'), []);

// ---- chmod-command guard -------------------------------------------------
const needles = buildNeedles("/p", [".env", "secrets/"]);
check("needles include rel, abs, basename", needles, [".env", "/p/.env", "secrets", "/p/secrets"]);
check("chmod +r .env blocked", scanChmodCommand("chmod +r .env", needles), ".env");
check("chmod abs path blocked", Boolean(scanChmodCommand("chmod 644 /p/secrets", needles)), true);
check("chained chmod blocked", scanChmodCommand("ls && chmod u+r .env", needles), ".env");
check("chown blocked", scanChmodCommand("chown me .env", needles), ".env");
check("setfacl blocked", scanChmodCommand("setfacl -m u::r .env", needles), ".env");
check("chmod on other file allowed", scanChmodCommand("chmod +x build.sh", needles), undefined);
check("plain cat .env not this guard's job", scanChmodCommand("cat .env", needles), undefined);
check("word containing chmod not matched", scanChmodCommand("echo chmodlike .env", needles), undefined);

// ---- Real lock / tamper / restore cycle ----------------------------------
const root = realpathSync(mkdtempSync(join(tmpdir(), "read-deny-test-")));
const file = join(root, ".env");
const dir = join(root, "secrets");
writeFileSync(file, "SECRET=1\n");
mkdirSync(dir);
chmodSync(file, 0o644);
chmodSync(dir, 0o755);

const fileEntry: DenyEntry = { path: file, originalMode: 0o644, isDir: false };
const dirEntry: DenyEntry = { path: dir, originalMode: 0o755, isDir: true };

// Lock
chmodSync(file, lockMode(fileEntry.originalMode, false));
chmodSync(dir, lockMode(dirEntry.originalMode, true));
check("locked file mode on disk", statSync(file).mode & 0o7777, 0o200);
check("locked dir mode on disk", statSync(dir).mode & 0o7777, 0o200);

// Reading must fail (root ignores permission bits, so only assert as non-root)
if (typeof process.getuid === "function" && process.getuid() !== 0) {
	let readFailed = false;
	try {
		readFileSync(file);
	} catch {
		readFailed = true;
	}
	check("reading locked file fails (EACCES)", readFailed, true);
} else {
	console.log("note: running as root — skipping the EACCES read assertion");
}

// Tamper detection: someone re-adds read permission
chmodSync(file, 0o644);
check("tampered file detected as unlocked", isUnlocked(statSync(file).mode & 0o7777, false), true);
// Re-lock (what the inotify callback does)
chmodSync(file, lockMode(fileEntry.originalMode, false));
check("re-locked file mode on disk", statSync(file).mode & 0o7777, 0o200);

// Restore
chmodSync(file, fileEntry.originalMode);
chmodSync(dir, dirEntry.originalMode);
check("restored file mode", statSync(file).mode & 0o7777, 0o644);
check("restored dir mode", statSync(dir).mode & 0o7777, 0o755);
check("restored file readable again", readFileSync(file, "utf8"), "SECRET=1\n");

rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
