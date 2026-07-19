# Read Deny (chmod)

*[Version française](./README.fr.md)*

The **simpler sibling** of [`read-blocklist/`](../read-blocklist/): instead of
intercepting pi's tools, it asks the operating system to do the work. At
session start it removes all permissions (`chmod 000`) from the files and
directories you list; on exit it restores the original permissions. While the
lock is active, **every** read and write fails with `EACCES` — pi's `read`
and `write` tools, ripgrep, `cat`, a python one-liner, anything — because the
filesystem itself refuses, with zero command analysis and zero per-call
overhead.

```
startup                        while pi runs                     exit
───────                        ─────────────                     ────
save original modes            inotify watch on each path        restore
  → .pi/read-deny.state.json     → re-lock instantly if perms    original
chmod 000 (files and               are changed externally        modes
           directories)        bash chmod/chown/chattr/setfacl
                                 on a protected path → blocked
```

## Configuration

Create `.pi-read-deny.json` at the root of your working directory. **Exact
paths only — no wildcards** (that's the point: dead simple; use
`read-blocklist/` if you need globs):

```json
{
  "denied": [
    ".env",
    "secrets",
    "config/prod.key"
  ]
}
```

A bare JSON array is also accepted. Paths are relative to the project root
(absolute paths work too). A wildcard entry is ignored with a warning.

## How it works

1. **Startup** (`session_start`): the current mode of each listed path is
   read and persisted to `.pi/read-deny.state.json` **before** any chmod.
   Then every path is locked to mode `000` — no read, write, or execute for
   anyone (for a directory, contents are unreachable even with the exact
   path). One syscall per path (`fs.chmodSync`, the exact equivalent of the
   `chmod` command, without spawning a shell).

2. **While running**: an inotify watcher (`fs.watch`) is attached to every
   protected path. If anyone — the agent, another terminal, another program —
   re-adds any permission bit, the kernel notifies pi instantly and the path
   is re-locked. Event-driven only: no polling, no timer, no per-tool-call cost.
   As a first line, bash commands invoking `chmod`/`chown`/`chattr`/`setfacl`
   on a protected path are blocked outright; the watcher is the safety net
   for anything sneakier.

3. **Exit** (`session_shutdown`, plus a synchronous `process.on("exit")`
   belt): original modes are restored and the state file is deleted.

4. **Crash recovery**: if pi dies without cleanup (kill -9, power loss), the
   state file survives. At the next startup the extension first restores the
   saved modes, then re-locks for the new session. You can also run
   `/read-deny restore` at any time, or apply the modes from
   `.pi/read-deny.state.json` by hand if you ever need to recover without pi.

## Commands

| Command | Effect |
|---|---|
| `/read-deny` | Show protected paths, lock state, original modes |
| `/read-deny restore` | Restore original permissions now (until next session) |
| `/read-deny lock` | Re-read the config and re-apply the locks |

## Compared with `read-blocklist/`

| | `read-deny-chmod/` | `read-blocklist/` |
|---|---|---|
| Mechanism | OS permissions (chmod) | tool interception + output filtering + sandbox sync |
| Config | exact paths only | glob patterns |
| Covers | every process equally (pi tools, bash, scripts) | pi tools reliably; bash needs the sandbox layer |
| Per-call overhead | none | small (path matching per tool call) |
| Touches the filesystem | yes (modes changed during the session) | no |
| Search results | searches just skip unreadable paths | protected matches filtered out with a notice |
| Failure mode | crash leaves paths locked (auto-repaired at next start) | none |

Pick this one for a short list of known secret files and maximum simplicity;
pick `read-blocklist/` when you need patterns (`*.pem`, `secrets/**`) or must
not alter permissions on disk.

## Guarantees and limitations

- Enforcement is done by the filesystem, so it applies identically to every
  access path, read or write — no bypass by clever quoting, wildcards,
  symlinks to the locked path, interpreters, or subprocesses. A symlink is
  only a name: opening it still hits the locked target.
- **Run pi as a regular user.** root (and processes with `CAP_DAC_OVERRIDE`)
  ignore permission bits entirely.
- The owner of a file may always `chmod` it back. The agent is therefore
  blocked up front (bash guard) and undone instantly (watcher) — but between
  an unguarded permission change and the inotify callback there is a
  millisecond-scale window. If your threat model is a deliberately
  adversarial agent, combine with the sandbox extension or OS-level
  isolation.
- Contents copied *before* locking (backups, build artifacts, git objects)
  are not protected — the lock applies to the listed paths only.
- Hard links to a locked file share its inode and are equally unreadable;
  but a *copy* made before the session started is an independent file.
- Unix only (Linux/macOS). On Windows, `chmod` cannot remove read access.
- A locked file cannot be modified in place, but its *directory entry* can:
  if the parent directory is writable, the file can still be deleted or
  replaced. Protect the parent directory too if that matters.

Run the unit tests with:

```bash
node --experimental-strip-types test.ts
```
