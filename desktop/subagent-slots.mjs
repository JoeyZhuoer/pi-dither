// Display numbers are server-owned labels, never session identifiers or file paths.
export function allocateSubagentSlot(agents, requested) {
  if (requested !== undefined && (!Number.isSafeInteger(requested) || requested < 1 || requested > 9)) {
    throw new Error('Subagent slot must be an integer from 1 to 9.');
  }
  const used = new Set([...agents].map((agent) => agent.state ?? agent)
    .filter((state) => state.kind === 'subagent').map((state) => state.slot));
  if (requested !== undefined && !used.has(requested)) return requested;
  let slot = 1;
  while (used.has(slot)) slot++;
  return slot;
}

export function subagentDisplayName(value, slot) {
  const role = String(value ?? 'Subagent').replace(/\s*\/\s*\d+\s*$/, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 52) || 'Subagent';
  return `${role} / ${String(slot).padStart(2, '0')}`;
}
