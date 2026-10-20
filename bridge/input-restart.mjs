// A helper that briefly reports READY must not reset the crash-loop limit.
export function nextInputRestart(restarts = 0, readyForMs = 0) {
  const failures = readyForMs >= 30_000 ? 0 : restarts;
  return failures < 3 ? failures + 1 : null;
}
