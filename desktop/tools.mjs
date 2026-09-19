export const READ_ONLY_TOOLS = Object.freeze(['read', 'grep', 'find', 'ls']);

export function validateToolSelection(tools, availableTools, kind) {
  if (!Array.isArray(tools) || tools.length > 64 || tools.some((name) => typeof name !== 'string' || !/^[a-z][a-z0-9_]*$/.test(name) || name.length > 80) || new Set(tools).size !== tools.length) {
    throw new Error('Tools must be an array of unique tool names.');
  }
  if (kind !== 'main' && tools.some((name) => !READ_ONLY_TOOLS.includes(name))) throw new Error('Subagents may only select read, grep, find, and ls.');
  if (!Array.isArray(availableTools)) throw new Error('Tool catalog is unavailable.');
  const names = new Set(availableTools.map((tool) => tool.name));
  if (tools.some((name) => !names.has(name))) throw new Error('Unknown or unavailable tool.');
  return [...tools];
}

// Strip schemas and source paths; the SDK registry, not a fabricated list, supplies availability.
export function toolCatalog(session, kind, extensionPaths = []) {
  return session.getAllTools().filter((tool) => kind === 'main'
    ? tool.sourceInfo?.source === 'builtin' || extensionPaths.includes(tool.sourceInfo?.path)
    : tool.sourceInfo?.source === 'builtin' && READ_ONLY_TOOLS.includes(tool.name))
    .map(({ name, description }) => ({ name, description }));
}

export function assertToolChangeReady(state) {
  if (!state.connected || state.phase !== 'idle' || state.queue?.steering?.length || state.queue?.followUp?.length) {
    throw new Error('Tool changes require a connected, idle agent with an empty queue.');
  }
}

// All checks and the synchronous public SDK setter run in one event-loop turn.
export function setSessionTools(session, kind, input, extensionPaths = []) {
  if (input.sessionId !== session.sessionId) throw new Error('Agent session changed. Refresh before changing tools.');
  if (!session.isIdle || session.pendingMessageCount !== 0) throw new Error('Tool changes require an idle session with an empty queue.');
  const tools = validateToolSelection(input.tools, toolCatalog(session, kind, extensionPaths), kind);
  session.setActiveToolsByName(tools);
  return session.getActiveToolNames();
}
