// Helper messages describe delivery/access, not just acceptance by the bridge.
export function helperAccess(line) {
  const blocked = /^INPUT_BLOCKED (\d+)$/.exec(line);
  if (blocked) return { type: 'input-access-state', blocked: true, errorCode: Number(blocked[1]) };
  if (line === 'INPUT_OK') return { type: 'input-access-state', blocked: false, errorCode: null };
  if (line === 'CAPTURE_STATE PAUSED') return { type: 'capture-state', paused: true };
  if (line === 'CAPTURE_STATE RESUMED') return { type: 'capture-state', paused: false };
  return null;
}
