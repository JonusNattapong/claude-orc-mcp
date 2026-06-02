/**
 * Unit tests for shared/platform.ts
 *
 * Covers the cross-platform process liveness helper directly, without
 * needing to spawn the broker.
 */
import { describe, test, expect } from "bun:test";
import { isProcessAlive } from "../shared/platform.ts";

describe("isProcessAlive", () => {
  test("returns true for the current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  test("returns false for non-positive PIDs", () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(-99999)).toBe(false);
  });

  test("returns false for non-finite PIDs", () => {
    expect(isProcessAlive(Number.NaN)).toBe(false);
    expect(isProcessAlive(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isProcessAlive(Number.NEGATIVE_INFINITY)).toBe(false);
  });

  test("returns false for a PID that almost certainly does not exist", () => {
    // A PID in a very high range is unlikely to be live in the test process.
    // We use a high number to avoid colliding with active PIDs.
    expect(isProcessAlive(2_000_000_000)).toBe(false);
  });

  test("returns true for a freshly spawned child PID", async () => {
    // Spawn a long-lived child and confirm we can see it.
    const proc = Bun.spawn(
      process.platform === "win32"
        ? ["ping", "-n", "30", "127.0.0.1"]
        : ["sleep", "30"],
      { stdout: "ignore", stderr: "ignore" }
    );
    try {
      // Give the OS a moment to register the process
      await new Promise((r) => setTimeout(r, 100));
      expect(isProcessAlive(proc.pid)).toBe(true);
    } finally {
      try {
        proc.kill();
      } catch {
        // ignore
      }
    }
  });
});
