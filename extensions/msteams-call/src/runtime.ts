/**
 * MS Teams Voice Call Runtime
 *
 * Creates and initializes the Teams voice call components:
 * - TeamsAudioBridge (WebSocket server)
 * - TeamsCallProvider (call management)
 * - TTS/STT providers (OpenAI integration)
 */

import { TeamsAudioBridge } from "./bridge.js";
import { TeamsCallProvider, createTeamsCallProvider } from "./provider.js";
import type { TeamsCallConfig } from "./config.js";
import { loadCoreAgentDeps, type CoreConfig } from "./core-bridge.js";
import { TeamsCallSessionRecorder } from "./session-recorder.js";
import type { SessionMetadata, CallDirection, EndReason } from "./types.js";

/**
 * Logger interface (matches Clawdbot's logger).
 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * Runtime initialization parameters.
 */
export interface TeamsCallRuntimeParams {
  config: TeamsCallConfig;
  /** Core Clawdbot config for session store resolution */
  coreConfig?: CoreConfig;
  openaiApiKey?: string;
  logger?: Logger;
}

/**
 * Runtime instance containing all components.
 */
export interface TeamsCallRuntime {
  config: TeamsCallConfig;
  bridge: TeamsAudioBridge;
  provider: TeamsCallProvider;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Create and initialize the Teams voice call runtime.
 */
export async function createTeamsCallRuntime(
  params: TeamsCallRuntimeParams,
): Promise<TeamsCallRuntime> {
  const { config, coreConfig, openaiApiKey, logger } = params;

  // Determine OpenAI API key
  const apiKey =
    openaiApiKey ||
    config.streaming.openaiApiKey ||
    process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "[msteams-call] OpenAI API key required - set streaming.openaiApiKey or OPENAI_API_KEY env var"
    );
  }

  // Create bridge
  const bridge = new TeamsAudioBridge({
    port: config.serve.port,
    bind: config.serve.bind,
    path: config.serve.path,
    secret: config.bridge.secret,
    logger,
  });

  // Set up TTS provider if API key available
  if (apiKey) {
    // Lazy import to avoid bundling if not needed
    const { OpenAITTSProvider } = await import("./providers/tts-openai.js");
    const ttsProvider = new OpenAITTSProvider({
      apiKey,
      model: config.tts.model,
      voice: config.tts.voice,
      speed: config.tts.speed,
      instructions: config.tts.instructions,
    });
    bridge.setTTSProvider(ttsProvider);
    logger?.debug("[msteams-call] TTS provider configured");

    // Set up STT provider
    const { OpenAIRealtimeSTTProvider } = await import(
      "./providers/stt-openai-realtime.js"
    );
    const sttProvider = new OpenAIRealtimeSTTProvider({
      apiKey,
      model: config.streaming.sttModel,
      silenceDurationMs: config.streaming.silenceDurationMs,
      vadThreshold: config.streaming.vadThreshold,
      inputAudioFormat: "pcm16", // 24kHz for Teams (bridge handles resampling)
      logger,
    });
    bridge.setSTTProvider(sttProvider);
    logger?.debug("[msteams-call] STT provider configured");
  }

  // Create provider with logger
  const provider = createTeamsCallProvider(bridge, config, logger);

  // Initialize session recorder for call history tracking
  let sessionRecorder: TeamsCallSessionRecorder | null = null;
  try {
    const coreDeps = await loadCoreAgentDeps();
    const storePath = coreDeps.resolveStorePath(
      coreConfig?.session?.store,
      { agentId: "main" },
    );
    sessionRecorder = new TeamsCallSessionRecorder({ storePath, logger });
    logger?.debug("[msteams-call] Session recorder initialized");
  } catch (err) {
    logger?.warn(
      "[msteams-call] Session recorder unavailable:",
      err instanceof Error ? err.message : String(err),
    );
  }

  // Track event listeners for cleanup to prevent memory leaks
  type LogHandler = (evt: { callId: string; direction?: string; text?: string; reason?: string; isFinal?: boolean; metadata?: SessionMetadata }) => void;
  const eventListeners: Array<{ event: string; handler: LogHandler }> = [];

  // Set up event handlers for logging and session recording
  const callStartedHandler: LogHandler = (evt) => {
    logger?.info(`[msteams-call] Call started: ${evt.callId} (${evt.direction})`);
    if (sessionRecorder && evt.metadata) {
      void sessionRecorder.recordCallStart({
        callId: evt.callId,
        direction: evt.direction as CallDirection,
        metadata: evt.metadata,
      });
    }
  };
  const transcriptHandler: LogHandler = (evt) => {
    logger?.debug(`[msteams-call] Transcript: ${evt.text}`);
    if (sessionRecorder && evt.isFinal) {
      void sessionRecorder.recordTranscript({
        callId: evt.callId,
        text: evt.text || "",
        isFinal: evt.isFinal ?? false,
      });
    }
  };
  const callEndedHandler: LogHandler = (evt) => {
    logger?.info(`[msteams-call] Call ended: ${evt.callId} (${evt.reason})`);
    if (sessionRecorder) {
      void sessionRecorder.recordCallEnd({
        callId: evt.callId,
        reason: (evt.reason as EndReason) || "hangup-user",
      });
    }
  };

  provider.on("callStarted", callStartedHandler);
  provider.on("transcript", transcriptHandler);
  provider.on("callEnded", callEndedHandler);

  eventListeners.push(
    { event: "callStarted", handler: callStartedHandler },
    { event: "transcript", handler: transcriptHandler },
    { event: "callEnded", handler: callEndedHandler },
  );

  return {
    config,
    bridge,
    provider,
    async start() {
      await provider.start();
      logger?.info(
        `[msteams-call] Bridge listening on ${config.serve.bind}:${config.serve.port}${config.serve.path}`,
      );
    },
    async stop() {
      // Remove event listeners to prevent memory leaks on restart
      for (const { event, handler } of eventListeners) {
        provider.removeListener(event, handler);
      }
      await provider.stop();
      logger?.info("[msteams-call] Runtime stopped");
    },
  };
}
