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
	LOCKED_MODE,
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
check("locked mode is 000", LOCKED_MODE, 0o000);
check("locked path is not unlocked", isUnlocked(0o000), false);
check("readable file is unlocked", isUnlocked(0o644), true);
check("write-only file is unlocked", isUnlocked(0o200), true);
check("dir with only x is unlocked (traversable)", isUnlocked(0o311), true);

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
chmodSync(file, LOCKED_MODE);
chmodSync(dir, LOCKED_MODE);
check("locked file mode on disk", statSync(file).mode & 0o7777, 0o000);
check("locked dir mode on disk", statSync(dir).mode & 0o7777, 0o000);

// Reading and writing must fail (root ignores permission bits, so only assert as non-root)
if (typeof process.getuid === "function" && process.getuid() !== 0) {
	let readFailed = false;
	try {
		readFileSync(file);
	} catch {
		readFailed = true;
	}
	check("reading locked file fails (EACCES)", readFailed, true);
	let writeFailed = false;
	try {
		writeFileSync(file, "TAMPERED=1\n");
	} catch {
		writeFailed = true;
	}
	check("writing locked file fails (EACCES)", writeFailed, true);
} else {
	console.log("note: running as root — skipping the EACCES read/write assertions");
}

// Tamper detection: someone re-adds a permission bit
chmodSync(file, 0o644);
check("tampered file detected as unlocked", isUnlocked(statSync(file).mode & 0o7777), true);
// Re-lock (what the inotify callback does)
chmodSync(file, LOCKED_MODE);
check("re-locked file mode on disk", statSync(file).mode & 0o7777, 0o000);

// Restore
chmodSync(file, fileEntry.originalMode);
chmodSync(dir, dirEntry.originalMode);
check("restored file mode", statSync(file).mode & 0o7777, 0o644);
check("restored dir mode", statSync(dir).mode & 0o7777, 0o755);
check("restored file readable again", readFileSync(file, "utf8"), "SECRET=1\n");

rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
