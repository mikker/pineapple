# File search

`fd` and `rg` are small wrappers around executables already installed on PATH.
`fdfind` is accepted when `fd` is unavailable. Missing commands fail with an
installation hint; the extension never downloads binaries or contacts a network.
Each tool resolves independently when called, so installing a missing command
does not require a session reload.

Arguments are passed directly to native `spawn`, never joined into shell text.
Patterns and paths follow `--`. Existing defaults, option limits, ignore rules,
smart-case, path normalization, and parameter shapes are preserved.

Stdout streams to a private temporary file with backpressure. Memory retains
only a head preview of at most Pi's 2000 lines / 50 KiB, plus bounded stderr.
Truncated results link to the complete, flushed file; small results, failed
searches, cancellations and timeouts remove their temporary directories.
Successful full-output files remain available in the OS temporary directory.
There is a 60-second execution/flush timeout. Cancellation kills the POSIX
process group (Windows uses `taskkill /T /F`).

`rg` exit 1 means no matches only when both stdout and diagnostics are empty.
Other nonzero exits are failures, including `fd` exit 1 and partial search output
with a failing exit. Tools use Pi's default rendering so failures remain visible
instead of being rendered as “No matches”.

Run `npm test`, `npm run check`, and `npm run format:check` in this workspace.
Tests are offline and use temporary fixtures and native Node fake commands;
installed fd/rg are not required to run them. `index.test.ts` follows the root
Node test-discovery convention; no separate Vitest invocation is needed.
