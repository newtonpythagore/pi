# Read Blocklist

*[Version française](./README.fr.md)*

Forbids the agent from **reading** files and directories you list in a simple
per-project JSON file. Writes are out of scope (see the `protected-paths.ts`
example for that); this extension is about keeping secrets — `.env` files,
private keys, credential folders — out of the LLM's context.

```
.pi-read-blocklist.json          you edit this
        │
        ├──► tool_call hook       blocks read/grep/find targeting a protected
        │                         path (symlinks resolved)
        ├──► tool_result hook     strips protected results from grep/find
        │                         output; re-checks read after execution
        ├──► bash heuristics      blocks bash commands that visibly reference
        │                         a protected path
        └──► .pi/sandbox.json     denyRead synced automatically → OS-level
             (sandbox extension)  enforcement for everything bash does
```

## Configuration

Create `.pi-read-blocklist.json` at the **root of your working directory**.
Each project gets its own blocklist. The file is re-read automatically
whenever it changes — no restart needed.

```json
{
  "blocked": [
    ".env",
    "*.pem",
    "*.key",
    "secrets/**",
    "config/prod.key",
    ".ssh/"
  ],
  "ignoreCase": false,
  "syncSandbox": true
}
```

A bare JSON array (`[".env", "secrets/**"]`) is also accepted.

| Option | Default | Meaning |
|---|---|---|
| `blocked` | `[]` | Glob patterns of unreadable paths (see syntax below) |
| `ignoreCase` | `false` | Case-insensitive matching — enable on macOS/Windows, whose filesystems ignore case |
| `syncSandbox` | `true` | Mirror the list into `.pi/sandbox.json` `filesystem.denyRead` |

### Glob syntax (gitignore-like)

- `*` matches anything within one path segment (`*.pem`)
- `**` matches across directories (`secrets/**`)
- `?` matches a single character
- A pattern **without** a slash (`.env`, `*.key`) matches by name **anywhere**
  in the tree, including directories of that name and their contents.
- A pattern **with** a slash (`config/prod.key`) is anchored to the project
  root.
- A trailing slash (`.ssh/`) means "the directory and everything under it".

## How it works

Defense in depth, four layers:

1. **Pre-execution blocking (`tool_call`).** pi emits a `tool_call` event
   before every tool run, and returning `{ block: true }` prevents execution.
   For `read`, `grep`, and `find` the target path is matched against the
   blocklist — both as given **and** after resolving symlinks (`realpath`),
   so `ln -s .env x; read x` and reads through symlinked directories are
   caught. This interception is architectural: the LLM cannot call a tool
   without going through it.

2. **Output filtering (`tool_result`).** A `grep` or `find` over a whole
   directory tree legitimately traverses protected files — blocking such
   searches would cripple the agent, so instead the *results* are filtered:
   every reported line/path is resolved (symlinks included) and dropped if it
   belongs to a protected file, with a `[N result(s) hidden]` notice. Even if
   ripgrep read the file on disk, its content never reaches the LLM — which
   is the boundary that matters. `read` results are also re-checked after
   execution, closing the small check-then-read race window.

3. **Bash heuristics (`tool_call` on `bash`).** Commands are scanned for
   references to protected paths (direct mentions, redirections, variable
   assignments, interpreter one-liners). This catches honest accidents
   cheaply, but a shell is Turing-complete: no string analysis can catch
   every trick (`cat .e*`, `cd secrets && cat db.txt`, quote splicing…).
   That is deliberate — the real enforcement for bash is layer 4.

4. **OS-level enforcement (sandbox sync).** The blocklist is automatically
   mirrored into `.pi/sandbox.json` under `filesystem.denyRead`, the config
   consumed by the [`sandbox/`](../sandbox/) example extension
   (`@anthropic-ai/sandbox-runtime`: bubblewrap on Linux, `sandbox-exec` on
   macOS). With the sandbox active, the **kernel** refuses the `open()` —
   it does not matter how the command was spelled, expanded, or obfuscated.
   This is the only layer that is bypass-proof for bash, which is exactly
   why the two extensions are designed to be used together.

### Why the sandbox link?

The split exists because each side covers the other's blind spot:

| | `read`/`grep`/`find` | `bash` |
|---|---|---|
| Where it executes | inside pi's Node process | child shell process |
| This extension | ✅ reliable (structured args + output filtering) | ⚠️ heuristic only |
| Sandbox `denyRead` | ❌ not covered (runs outside the sandbox) | ✅ kernel-enforced |

The sandbox only wraps bash commands, so it cannot see pi's in-process tools;
this extension covers those precisely because their inputs and outputs are
structured. Conversely, no command-string analysis can secure bash, so the
blocklist is pushed down into the sandbox where the OS enforces it. One JSON
file feeds both layers, so they can never drift apart.

Sync details: entries this extension adds to `denyRead` are tracked under a
`readBlocklistManagedDenyRead` marker key (ignored by the sandbox), so your
own manual `denyRead` entries are preserved and stale managed entries are
removed when you edit the blocklist. The sandbox extension reads its config
at startup — run `/reload` (or restart pi) after the first sync or after
changing the blocklist while the sandbox is active.

## Setup

```bash
# Blocklist alone (in-process tools + bash heuristics):
pi -e ./examples/extensions/read-blocklist

# Full protection (recommended) — add the sandbox extension:
cp -r examples/extensions/read-blocklist ~/.pi/agent/extensions/
cp -r examples/extensions/sandbox ~/.pi/agent/extensions/
(cd ~/.pi/agent/extensions/sandbox && npm install)
```

Then create `.pi-read-blocklist.json` in your project (see
[`blocklist.example.json`](./blocklist.example.json)).

Run the unit tests with:

```bash
node --experimental-strip-types test.ts
```

## Guarantees and limitations

- `read`, `grep`, `find`: reliable in practice — structured inputs, symlink
  resolution, and output-side filtering leave no known bypass. The residual
  theoretical gap is a TOCTOU race (a concurrent process swapping a symlink
  mid-call), mitigated by the post-execution re-check.
- `bash` **with** the sandbox layer: kernel-enforced, bypass-proof.
- `bash` **without** the sandbox layer: best-effort heuristics only. Treat
  this mode as protection against accidents, not against a determined
  adversary.
- `ls` is not intercepted: file *names* (metadata) remain visible; contents
  are what this extension protects.
- Only mathematical certainty comes from the kernel. If you need a hard
  guarantee for everything including pi's own process, use OS permissions or
  run pi itself inside a sandbox.
