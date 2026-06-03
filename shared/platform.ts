/**
 * Cross-platform process utilities.
 *
 * Kept tiny and dependency-free so both `broker.ts` and the test suite can
 * use it without pulling in anything else.
 */

/**
 * Check whether a process with the given PID is still alive.
 *
 * Replaces the naive `process.kill(pid, 0)` pattern, which behaves
 * inconsistently across platforms:
 *   - On Linux/macOS, signal 0 throws `ESRCH` for missing PIDs and
 *     sometimes `EPERM` for processes we can't signal.
 *   - On Windows, signal 0 is supported in modern Node/Bun but the failure
 *     modes are not identical to POSIX.
 *
 * This helper normalizes the result: `true` if we have any evidence the
 * process exists, `false` otherwise.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as { code?: string } | null)?.code;
    // EPERM => process exists but we cannot signal it. Treat as alive.
    if (code === "EPERM") return true;
    return false;
  }
}
