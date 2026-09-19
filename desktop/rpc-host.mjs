// A process-isolated host for Pi's public SDK + unchanged core RPC protocol.
// Bootstrap (including temporary keys) arrives on private fd 3, never argv/stdout.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { READ_ONLY_TOOLS, toolCatalog, validateToolSelection, setSessionTools } from './tools.mjs';
import { desktopExtensions } from './extensions.mjs';
import { DelegationBridge, findInspectCommand } from './delegation-bridge.mjs';

process.env.PI_OFFLINE = '1';
const config = JSON.parse(readFileSync(3, 'utf8'));
const pi = await import(pathToFileURL(join(config.root, 'dist/index.js')).href);
const agentDir = pi.getAgentDir();
const extensions = await desktopExtensions({ agentDir, kind: config.kind });
const { paths: extensionPaths, ...extensionStatus } = extensions;
const models = await pi.ModelRuntime.create({ allowModelNetwork: false, signal: AbortSignal.timeout(25_000) });
for (const [provider, key] of Object.entries(config.keys ?? {})) {
  await models.setRuntimeApiKey(provider, key, { signal: AbortSignal.timeout(15_000) });
}
const telemetrySecrets = Object.values(config.keys ?? {}).filter((key) => typeof key === 'string' && key);
const redactTelemetry = (value) => telemetrySecrets.reduce((text, key) => text.split(key).join('[redacted]'), value);
delete config.keys;
let selectedTools = config.tools;
let toolRevision = 0, replacing = false, toolSetupError;
let telemetry, telemetryGeneration = 0, telemetrySending = false, telemetryLatest;
// IPC backpressure retains only one newest bounded snapshot.
const publishTelemetry = (snapshot) => {
  telemetryLatest = snapshot;
  if (telemetrySending || !process.connected) return;
  telemetrySending = true;
  const next = telemetryLatest; telemetryLatest = null;
  process.send(next, () => {
    telemetrySending = false;
    if (telemetryLatest && process.connected) publishTelemetry(telemetryLatest);
  });
};
process.on('disconnect', () => { telemetry?.dispose(); telemetryLatest = null; });
const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }) => {
  replacing = true;
  telemetry?.dispose(); telemetry = null;
  const generation = ++telemetryGeneration;
  try {
    const services = await pi.createAgentSessionServices({
      cwd, agentDir, modelRuntime: models,
      settingsManager: pi.SettingsManager.create(cwd, agentDir, { projectTrusted: false }),
      resourceLoaderOptions: {
        noExtensions: true, noThemes: true,
        // Pi's noExtensions suppresses discovery, not explicitly supplied paths.
        additionalExtensionPaths: extensionPaths,
        extensionFactories: [{ name: 'desktop-tool-selection', factory(api) {
          // Loaded last: pi-subagents registers its supervisor tool on session_start.
          // Reapply only after those runtime registrations, including explicit [].
          let bridge;
          api.on('session_shutdown', () => { bridge?.dispose(); });
          for (const type of ['tool_execution_update', 'tool_execution_end']) api.on(type, (event) => { bridge?.foreground(event); });
          api.on('session_start', (_event, ctx) => {
            toolSetupError = undefined;
            try {
              if (selectedTools !== undefined) api.setActiveTools(validateToolSelection(selectedTools,
                toolCatalog({ getAllTools: () => api.getAllTools() }, config.kind, extensionPaths), config.kind));
              selectedTools = api.getActiveTools(); toolRevision++;
            } catch (error) { api.setActiveTools([]); toolSetupError = error; }
            if (config.kind !== 'main') return;
            bridge?.dispose();
            bridge = telemetry = new DelegationBridge({ sessionId: ctx.sessionManager.getSessionId(), generation,
              events: api.events, context: ctx, publish: publishTelemetry, redact: redactTelemetry,
              inspectCommand: findInspectCommand(services.resourceLoader.getExtensions().extensions, extensionPaths) });
            if (extensionStatus.status === 'loaded') void bridge.start();
            else { bridge.projection.unavailable(extensionStatus.message); bridge.send(); }
          });
        } }],
        appendSystemPrompt: config.kind === 'main' ? [] : [
          'You are a read-only subagent in Pi Desktop. Analyze the user task and report concise findings with evidence. Do not change files or try to bypass the read-only tool boundary.',
        ],
      },
    });
    const loadErrors = services.resourceLoader.getExtensions().errors;
    if (loadErrors.length) throw new Error(`Desktop extension load failed: ${loadErrors.map((item) => item.error).join('; ')}`);
    const result = await pi.createAgentSessionFromServices({
      services, sessionManager, sessionStartEvent,
      ...(config.kind === 'main' ? {} : { tools: READ_ONLY_TOOLS }),
    });
    // Keep the catalog intact, but avoid temporarily widening an explicit selection
    // while RPC binds extensions and their session_start hooks run.
    if (selectedTools !== undefined) result.session.setActiveToolsByName([]);
    return { ...result, services, diagnostics: services.diagnostics };
  } finally { replacing = false; }
};
const manager = config.sessionPath ? pi.SessionManager.open(config.sessionPath, config.sessionDir)
  : pi.SessionManager.create(process.cwd(), config.sessionDir);
if (!config.sessionPath) manager.appendSessionInfo(config.name);
const runtime = await pi.createAgentSessionRuntime(createRuntime, { cwd: process.cwd(), agentDir, sessionManager: manager });
// Node IPC is separate from both the fd-3 credential bootstrap and core JSONL RPC.
process.on('message', (message) => {
  if (message?.type !== 'desktop_tools_request' || typeof message.id !== 'string') return;
  const response = { type: 'desktop_tools_response', id: message.id };
  try {
    if (replacing) throw new Error('Session replacement is in progress.');
    if (toolSetupError) throw new Error(`Tool selection could not be restored; all tools disabled: ${toolSetupError.message}`);
    const session = runtime.session;
    if (message.action === 'set') {
      if (message.revision !== toolRevision) throw new Error('Tool state changed. Refresh before applying.');
      selectedTools = setSessionTools(session, config.kind, message, extensionPaths);
      toolRevision++;
    } else if (message.action !== 'get') throw new Error('Unsupported private tool action.');
    response.data = { sessionId: session.sessionId, revision: toolRevision,
      availableTools: toolCatalog(session, config.kind, extensionPaths), activeTools: session.getActiveToolNames(), extensionStatus };
    response.success = true;
  } catch (error) { response.success = false; response.error = error.message; }
  if (process.connected) process.send(response, () => {});
});
try { await pi.runRpcMode(runtime); }
finally { telemetry?.dispose(); telemetryLatest = null; }
