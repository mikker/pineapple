# Background terminals

The extension has no runtime dependencies beyond Pi's host-provided APIs.
`createTerminalManager()` owns session-local processes, bounded output buffers,
private spill files, and a single idempotent disposal promise. Nothing starts
while the extension factory is loading.

## Contract

- `bg_start`, `bg_status`, `bg_list`, and `bg_kill` retain their parameter shapes.
- Commands run through `/bin/sh -c` on POSIX or `cmd.exe /d /s /c` on Windows.
  Stdin is ignored: commands get EOF and cannot receive later input.
- At most eight entries may be running. Spawn and registration are synchronous
  so parallel starts cannot overbook or escape session ownership.
- POSIX commands have their own process group. Stop sends TERM, waits up to two
  seconds, then sends KILL. Windows uses `taskkill /T`, then `/F`.
- Pipe closure is not proof of process-tree death. Group liveness is checked
  during stop; natural shell exit also schedules descendant cleanup.
- Exit records the code/signal; close flushes output and settles once. Cleanup
  of inherited pipes preserves an already-observed natural shell exit status.
- Kill callers share termination but have separate consumption interest.
  Aborting a wait releases that caller's interest, not the underlying cleanup.
  A pre-aborted start never spawns; once started, a terminal belongs to the
  session, not to the turn's abort signal.

## Output and results

Each stream retains a UTF-8-safe 2 MiB tail. Private 0600 spill files in a 0700
temporary directory capture full output with write-stream backpressure. A
256 MiB per-stream safety cap, write failure, or 1.5-second flush timeout clears
the full-output pointer and records an explanatory note rather than claiming
that a partial log is complete. Model-facing output uses Pi's bounded tail
truncation helpers. Search output, by contrast, uses bounded head previews.

Up to 32 terminal snapshots are retained, with small bounded historical exit
records for truthful repeated kill reports after pruning. Completion is queued
once through deferred result delivery; a successful status/kill collection
consumes its pending notification. Shutdown suppresses notifications, stops all
owned processes, flushes logs, and removes the private spill directory. Old
transcript log paths intentionally expire when the session ends or reloads.

## Inspection

`/ps` shows a simple listing. `/ps bt-1` shows a bounded stdout/stderr snapshot
in Pi's built-in editor in TUI mode (edits are discarded), or a notification in
RPC mode. There is no custom overlay, live-tail timer, or bespoke scrolling UI.
The running-count widget remains TUI-only. Process output is sanitized at the
rendering boundary, never at capture time.

## Verification

Run `npm test`, `npm run check`, and `npm run format:check` within this workspace.
Tests use native Node processes and private temporary fixtures, including tree
cleanup, inherited pipes, resistant processes, overlapping kills, cancellation,
flush-before-notification, pruning, and shutdown. No network is required.
