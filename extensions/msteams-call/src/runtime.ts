/**
 * MS Teams Voice Call Runtime
 *
 * Creates and initializes the Teams voice call components:
 * - TeamsAudioBridge (WebSocket server)
 * - TeamsCallProvider (call management)
 * - TTS/STT providers (OpenAI integration)
 * - Voice controllers (realtime or chunked mode)
 *
 * Voice Modes:
 * - "realtime": Uses OpenAI Realtime API as THE agent (single LLM, direct tools)
 * - "chunked": Uses Pi agent + REST TTS API (works with any LLM)
 * - "auto": Chooses based on model (realtime for OpenAI, chunked for others)
 */

import { TeamsAudioBridge } from "./bridge.js";
import { TeamsCallProvider, createTeamsCallProvider } from "./provider.js";
import type { TeamsCallConfig } from "./config.js";
import { loadCoreAgentDeps, type CoreConfig } from "./core-bridge.js";
import { TeamsCallSessionRecorder } from "./session-recorder.js";
import { StreamingVoiceController } from "./streaming-voice-controller.js";
import {
  RealtimeVoiceAgent,
  type ResolvedAgentConfig,
} from "./realtime-voice-agent.js";
import { ConversationSessionManager } from "./conversation-session-manager.js";
import { createClawdbotToolExecutor } from "./voice-tool-adapter.js";
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

  // Determine voice mode early (needed for provider setup)
  const ttsMode = config.streaming.ttsMode || "auto";
  const useRealtimeAgent = ttsMode === "realtime" ||
    (ttsMode === "auto" && config.responseModel?.startsWith("openai/"));

  logger?.info(`[msteams-call] Voice mode: ${ttsMode} (realtime=${useRealtimeAgent})`);

  // Create bridge
  const bridge = new TeamsAudioBridge({
    port: config.serve.port,
    bind: config.serve.bind,
    path: config.serve.path,
    secret: config.bridge.secret,
    logger,
    fullConfig: config,
  });

  // Set up TTS provider if API key available
  // Keep reference for streaming controller
  let ttsProviderInstance: import("./providers/tts-openai.js").OpenAITTSProvider | null = null;

  if (apiKey) {
    // Lazy import to avoid bundling if not needed
    const { OpenAITTSProvider } = await import("./providers/tts-openai.js");
    ttsProviderInstance = new OpenAITTSProvider({
      apiKey,
      model: config.tts.model,
      voice: config.tts.voice,
      speed: config.tts.speed,
      instructions: config.tts.instructions,
    });
    bridge.setTTSProvider(ttsProviderInstance);
    logger?.debug("[msteams-call] TTS provider configured");

    // Only set up STT provider for chunked mode
    // In realtime mode, the Realtime API has built-in transcription
    if (!useRealtimeAgent) {
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
      logger?.debug("[msteams-call] STT provider configured (chunked mode)");
    } else {
      logger?.debug("[msteams-call] Skipping STT provider (realtime mode uses built-in transcription)");
    }
  }

  // Create provider with logger
  const provider = createTeamsCallProvider(bridge, config, logger);

  // Initialize session recorder for call history tracking
  let sessionRecorder: TeamsCallSessionRecorder | null = null;
  let storePath = "";
  let coreDeps: Awaited<ReturnType<typeof loadCoreAgentDeps>> | null = null;
  try {
    coreDeps = await loadCoreAgentDeps();
    storePath = coreDeps.resolveStorePath(
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

  // Initialize conversation session manager for multi-turn context
  const conversationManager = new ConversationSessionManager({
    coreConfig: coreConfig || {},
    storePath,
    logger,
  });

  // Initialize voice controller based on mode
  let streamingController: StreamingVoiceController | null = null;
  let realtimeAgent: RealtimeVoiceAgent | null = null;

  const toolExecutor = coreDeps
    ? createClawdbotToolExecutor({
        logger,
        normalizeToolName: coreDeps.normalizeToolName,
        createTools: async (context) => {
          const agentId = context.agentId ?? "main";
          const config = coreConfig ?? {};
          const agentDir = coreDeps?.resolveAgentDir(config, agentId);
          const workspaceDir = coreDeps?.resolveAgentWorkspaceDir(config, agentId);
          const sessionKey = context.sessionKey ?? `msteams-call:${context.userId}`;
          return coreDeps.createClawdbotTools({
            agentSessionKey: sessionKey,
            agentDir,
            workspaceDir,
            config,
          });
        },
      })
    : undefined;

  if (useRealtimeAgent && apiKey) {
    // REALTIME MODE: Use OpenAI Realtime API as the agent
    // This provides single LLM execution with direct tool access
    logger?.info("[msteams-call] Initializing Realtime voice agent mode");
    realtimeAgent = new RealtimeVoiceAgent(bridge, {
      openaiApiKey: apiKey,
      model: config.realtime.model,
      voice: config.realtime.voice,
      turnDetection: config.realtime.turnDetection,
      tools: config.realtime.tools,
      maxSessionDurationMs: config.realtime.maxSessionDurationMs,
      logger,
      toolExecutor,
      resolveToolContext: (context) => {
        const session = conversationManager.getSession(context.callId, context.userId);
        return {
          ...context,
          sessionId: session.sessionId,
          sessionKey: session.sessionKey,
        };
      },
      onInputTranscript: ({ callId, text, isFinal }) => {
        if (sessionRecorder && isFinal) {
          void sessionRecorder.recordTranscript({
            callId,
            text: text || "",
            isFinal,
          });
        }
      },
    });
    logger?.debug(
      `[msteams-call] Realtime voice agent initialized (model: ${config.realtime.model})`
    );
  } else if (ttsProviderInstance && coreConfig) {
    // CHUNKED MODE: Use Pi agent + REST TTS API
    // This works with any LLM but has higher latency
    logger?.info("[msteams-call] Initializing chunked voice controller mode");
    streamingController = new StreamingVoiceController({
      bridge,
      ttsProvider: ttsProviderInstance,
      sessionManager: conversationManager,
      config: {
        // Chunked TTS settings
        sentenceMinChars: config.streaming.sentenceMinChars,
        sentenceMaxChars: config.streaming.sentenceMaxChars,
        maxParallelTTS: config.streaming.maxParallelTTS,
        jitterBufferFrames: config.streaming.jitterBufferFrames,
        // Response generation settings
        responseModel: config.responseModel,
        responseSystemPrompt: config.responseSystemPrompt,
        responseTimeoutMs: config.responseTimeoutMs,
        thinkLevel: config.streaming.thinkLevel,
        // TTS mode settings (chunked only now - realtime handled by RealtimeVoiceAgent)
        ttsMode: "chunked",
        openaiApiKey: apiKey,
        voice: config.tts.voice,
        instructions: config.tts.instructions,
      },
      logger,
    });
    logger?.debug(
      `[msteams-call] Streaming voice controller initialized (chunked mode)`
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

    // For REALTIME mode: Start the realtime voice agent
    if (realtimeAgent && evt.metadata) {
      const userId = evt.metadata.userId || "unknown";
      conversationManager.getSession(evt.callId, userId);

      // Build agent config (in production, this would come from bindings)
      const agentConfig: ResolvedAgentConfig = {
        agentId: "main",
        systemPrompt: config.responseSystemPrompt || "",
        tools: [], // Tools loaded from agent config
        identity: { name: "voice assistant" },
      };

      void realtimeAgent.startCall(evt.callId, userId, agentConfig)
        .then(() => {
          logger?.info(`[msteams-call] Realtime agent started for ${evt.callId}`);
          // Play greeting through realtime agent if configured
          // Note: Greeting is handled via system prompt in realtime mode
        })
        .catch((err) => {
          logger?.error(`[msteams-call] Realtime agent start failed for ${evt.callId}:`, err);
          // Fallback: Could switch to chunked mode here
        });
      return; // Don't play greeting separately in realtime mode
    }

    // For CHUNKED mode: Play greeting for inbound calls (delay slightly to let call establish)
    if (evt.direction === "inbound" && config.inbound.greeting) {
      const callId = evt.callId;
      const greeting = config.inbound.greeting;
      setTimeout(() => {
        logger?.info(`[msteams-call] Playing streaming greeting for ${callId}`);
        // Use streaming controller for smooth greeting audio (if available)
        if (streamingController) {
          streamingController
            .speakGreeting(callId, greeting)
            .then(() => logger?.info(`[msteams-call] Greeting completed for ${callId}`))
            .catch((err) => logger?.error(`[msteams-call] Greeting failed for ${callId}:`, err));
        } else {
          // Fallback to provider's TTS
          provider.playTts({ callId, text: greeting })
            .then(() => logger?.info(`[msteams-call] Greeting TTS completed for ${callId}`))
            .catch((err) => logger?.error(`[msteams-call] Greeting TTS failed for ${callId}:`, err));
        }
      }, 1000);
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

    // REALTIME mode: Audio/transcripts handled internally by RealtimeVoiceAgent
    if (realtimeAgent) {
      // RealtimeVoiceAgent handles transcription via Realtime API
      // We just log here for session recording purposes
      return;
    }

    // CHUNKED mode: Trigger streaming voice response for final transcripts
    if (evt.isFinal && evt.text && streamingController && coreConfig) {
      // Get user ID from metadata (stored during callStarted)
      const userId = evt.metadata?.userId || "unknown";
      void streamingController.streamResponse({
        callId: evt.callId,
        userMessage: evt.text,
        userId,
        coreConfig,
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

    // Clean up realtime agent if active
    if (realtimeAgent) {
      void realtimeAgent.endCall(evt.callId);
    }

    // Clean up conversation session
    conversationManager.removeSession(evt.callId);
  };

  // Handle barge-in (user starts speaking during bot response)
  // NOTE: In realtime mode, barge-in is handled internally by the Realtime API's VAD.
  // We only use this handler for chunked mode.
  const userSpeakingHandler = (evt: { callId: string }) => {
    // REALTIME mode: Don't handle barge-in from STT - Realtime API has its own VAD
    if (realtimeAgent) {
      // The Realtime API handles interruption internally via VAD
      // We don't need to manually trigger barge-in
      return;
    }

    // CHUNKED mode: Handle barge-in through streaming controller
    if (streamingController) {
      // Check echo cancellation - ignore if bot is speaking
      if (streamingController.shouldIgnoreBargeIn()) {
        logger?.debug(
          `[msteams-call] Ignoring barge-in (echo cancellation active)`
        );
        return;
      }
      logger?.info(`[msteams-call] Barge-in detected for call ${evt.callId}`);
      void streamingController.cancel();
    }
  };

  provider.on("callStarted", callStartedHandler);
  provider.on("transcript", transcriptHandler);
  provider.on("callEnded", callEndedHandler);

  // Register barge-in handler on the bridge (receives userSpeaking from STT)
  bridge.on("userSpeaking", userSpeakingHandler);

  // REALTIME mode: Forward raw audio to the realtime agent
  const audioInHandler = (evt: { callId: string; audio: Buffer }) => {
    if (realtimeAgent) {
      realtimeAgent.handleAudioIn(evt.callId, evt.audio);
    }
  };
  bridge.on("audioIn", audioInHandler);

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
      // Clean up streaming controller (chunked mode)
      if (streamingController) {
        await streamingController.dispose();
      }

      // Clean up realtime agent (realtime mode)
      if (realtimeAgent) {
        await realtimeAgent.dispose();
      }

      // Remove event listeners to prevent memory leaks on restart
      for (const { event, handler } of eventListeners) {
        provider.removeListener(event, handler);
      }
      bridge.removeListener("userSpeaking", userSpeakingHandler);
      bridge.removeListener("audioIn", audioInHandler);

      await provider.stop();
      logger?.info("[msteams-call] Runtime stopped");
    },
  };
}
