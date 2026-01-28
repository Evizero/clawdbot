/**
 * MS Teams Voice Call Plugin Configuration
 *
 * Defines Zod schemas for plugin configuration.
 */

import { z } from "zod";

/**
 * TTS configuration schema.
 */
export const TtsConfigSchema = z.object({
  /** TTS model (default: gpt-4o-mini-tts) */
  model: z.string().default("gpt-4o-mini-tts"),
  /** Voice to use (default: coral) */
  voice: z.string().default("coral"),
  /** Speech style instructions (for gpt-4o-mini-tts) */
  instructions: z.string().optional(),
  /** Speech speed multiplier 0.25-4.0 (default: 1.0) */
  speed: z.number().min(0.25).max(4.0).default(1.0),
});

/**
 * Streaming (real-time STT) configuration schema.
 */
export const StreamingConfigSchema = z.object({
  // ─────────────────────────────────────────────────────────────
  // STT Settings
  // ─────────────────────────────────────────────────────────────

  /** OpenAI API key (uses OPENAI_API_KEY env if not set) */
  openaiApiKey: z.string().optional(),
  /** STT model (default: gpt-4o-transcribe) */
  sttModel: z.string().default("gpt-4o-transcribe"),
  /** Silence duration in ms before considering speech ended (default: 800) */
  silenceDurationMs: z.number().min(100).max(5000).default(800),
  /** VAD threshold 0-1 (default: 0.5) */
  vadThreshold: z.number().min(0).max(1).default(0.5),

  // ─────────────────────────────────────────────────────────────
  // Streaming Voice Response Settings (for low-latency responses)
  // ─────────────────────────────────────────────────────────────

  /** Minimum characters before sentence break for TTS */
  sentenceMinChars: z
    .number()
    .min(10)
    .max(200)
    .default(20)
    .describe("Minimum characters before sentence break"),

  /** Maximum characters per sentence chunk for TTS */
  sentenceMaxChars: z
    .number()
    .min(50)
    .max(500)
    .default(200)
    .describe("Maximum characters per sentence chunk"),

  /** Maximum concurrent TTS synthesis jobs (rate limit safety) */
  maxParallelTTS: z
    .number()
    .min(1)
    .max(5)
    .default(3)
    .describe("Maximum concurrent TTS synthesis jobs"),

  /** Jitter buffer size in frames (1 frame = 20ms) */
  jitterBufferFrames: z
    .number()
    .min(10)
    .max(100)
    .default(25)
    .describe("Jitter buffer size in frames (25 = 500ms)"),

  /** Thinking level for LLM responses */
  thinkLevel: z
    .enum(["off", "low", "medium", "high"])
    .optional()
    .describe("Thinking level for LLM responses (defaults to user's global setting)"),

  /** Play audio cue when bot finishes speaking */
  endOfTurnCue: z
    .boolean()
    .default(false)
    .describe("Play subtle audio cue when bot finishes speaking"),

  // ─────────────────────────────────────────────────────────────
  // TTS Mode Settings
  // ─────────────────────────────────────────────────────────────

  /**
   * TTS mode for voice responses:
   * - "realtime": Use OpenAI Realtime API for smooth, continuous speech (best quality)
   * - "chunked": Use REST TTS API with sentence-level chunking (works with any LLM)
   * - "auto": Use realtime for OpenAI models, chunked for others (default)
   */
  ttsMode: z
    .enum(["auto", "realtime", "chunked"])
    .default("auto")
    .describe("TTS mode: realtime (smooth), chunked (any LLM), or auto"),

  /**
   * Model for OpenAI Realtime TTS (used in realtime mode).
   * Default: gpt-4o-mini-realtime-preview
   */
  realtimeModel: z
    .string()
    .default("gpt-4o-mini-realtime-preview")
    .describe("OpenAI Realtime model for TTS"),
});

/**
 * WebSocket server configuration.
 */
export const ServeConfigSchema = z.object({
  /** Port to listen on (default: 3335) */
  port: z.number().min(1).max(65535).default(3335),
  /** Bind address (default: 127.0.0.1) */
  bind: z.string().default("127.0.0.1"),
  /** WebSocket path (default: /teams-call/stream) */
  path: z.string().default("/teams-call/stream"),
});

/**
 * Bridge authentication configuration.
 */
export const BridgeConfigSchema = z.object({
  /**
   * Shared secret for authentication (min 32 chars).
   * Generate with: openssl rand -base64 32
   */
  secret: z.string().min(32),
});

/**
 * Call authorization configuration.
 */
export const AuthorizationConfigSchema = z.object({
  /** Authorization mode: disabled (reject all), open, allowlist, or tenant-only */
  mode: z.enum(["disabled", "open", "allowlist", "tenant-only"]).default("disabled"),
  /** List of allowed user IDs or UPNs (for allowlist mode) */
  allowFrom: z.array(z.string()).default([]),
  /** List of allowed tenant IDs (for tenant-only and allowlist modes) */
  allowedTenants: z.array(z.string()).default([]),
  /** Whether to allow PSTN (phone) calls */
  allowPstn: z.boolean().default(false),
});

/**
 * Inbound call configuration.
 */
export const InboundConfigSchema = z.object({
  /** Enable inbound calls (default: true) */
  enabled: z.boolean().default(true),
  /** Initial greeting when call connects */
  greeting: z.string().optional(),
});

/**
 * Outbound call configuration.
 */
export const OutboundConfigSchema = z.object({
  /** Enable outbound calls (default: true) */
  enabled: z.boolean().default(true),
  /** Max time to wait for call to be answered in ms (default: 30000) */
  ringTimeoutMs: z.number().min(5000).max(120000).default(30000),
  /** Default call mode (default: conversation) */
  defaultMode: z.enum(["notify", "conversation"]).default("conversation"),
});

/**
 * OpenAI Realtime API configuration.
 *
 * When ttsMode is "realtime", this uses the Realtime API as THE agent
 * (not as TTS). This provides:
 * - Single LLM execution (no double model)
 * - Direct tool access via function calling
 * - Streaming audio I/O with natural prosody
 *
 * NOTE: OpenAI Realtime API has a 15-minute session limit.
 */
export const RealtimeConfigSchema = z.object({
  /**
   * Model to use for Realtime API.
   * Default: gpt-4o-realtime-preview
   */
  model: z
    .string()
    .default("gpt-4o-realtime-preview")
    .describe("OpenAI Realtime model"),

  /**
   * Voice to use for audio output.
   * Options: alloy, ash, ballad, coral, echo, sage, shimmer, verse
   */
  voice: z
    .string()
    .default("coral")
    .describe("Voice for audio output"),

  /**
   * Turn detection configuration.
   * server_vad: Automatic voice activity detection (recommended)
   * none: Manual turn handling
   */
  turnDetection: z.object({
    type: z.enum(["server_vad", "none"]).default("server_vad"),
    /** VAD threshold 0-1 (default: 0.5) */
    threshold: z.number().min(0).max(1).default(0.5),
    /** Silence duration in ms before end of turn (default: 300, OpenAI default: 200) */
    silenceDurationMs: z.number().min(100).max(2000).default(300),
    /** Padding before speech start in ms (default: 300) */
    prefixPaddingMs: z.number().min(0).max(1000).default(300),
  }).optional(),

  /**
   * Tool configuration for voice mode.
   * Voice-safe tools are allowed by default.
   */
  tools: z.object({
    /** Tools to explicitly allow (overrides defaults) */
    allow: z.array(z.string()).optional(),
    /** Tools to explicitly deny (applied after allow) */
    deny: z.array(z.string()).optional(),
  }).optional(),

  /**
   * Maximum session duration in milliseconds.
   * OpenAI Realtime API has a hard 15-minute limit.
   * Default: 14 minutes (840000ms) - leaves 1 minute buffer
   *
   * WARNING: Sessions exceeding 15 minutes will be disconnected by OpenAI.
   */
  maxSessionDurationMs: z
    .number()
    .min(60000) // 1 minute minimum
    .max(900000) // 15 minutes maximum (OpenAI limit)
    .default(840000) // 14 minutes default
    .describe("Max session duration (OpenAI has 15min limit)"),
});

/**
 * Complete MS Teams Voice Call plugin configuration.
 */
export const TeamsCallConfigSchema = z.object({
  /** Enable the plugin (default: false) */
  enabled: z.boolean().default(false),

  /** WebSocket server settings */
  serve: ServeConfigSchema.optional().transform((v) => v ?? {
    port: 3335,
    bind: "127.0.0.1",
    path: "/teams-call/stream",
  }),

  /** Bridge authentication */
  bridge: BridgeConfigSchema,

  /** Call authorization settings */
  authorization: AuthorizationConfigSchema.optional().transform((v) => v ?? {
    mode: "disabled" as const,
    allowFrom: [],
    allowedTenants: [],
    allowPstn: false,
  }),

  /** Inbound call settings */
  inbound: InboundConfigSchema.optional().transform((v) => v ?? {
    enabled: true,
    greeting: undefined,
  }),

  /** Outbound call settings */
  outbound: OutboundConfigSchema.optional().transform((v) => v ?? {
    enabled: true,
    ringTimeoutMs: 30000,
    defaultMode: "conversation" as const,
  }),

  /** TTS settings */
  tts: TtsConfigSchema.optional().transform((v) => v ?? {
    model: "gpt-4o-mini-tts",
    voice: "coral",
    speed: 1.0,
    instructions: undefined,
  }),

  /** Streaming STT and voice response settings */
  streaming: StreamingConfigSchema.optional().transform((v) => v ?? {
    openaiApiKey: undefined,
    sttModel: "gpt-4o-transcribe",
    silenceDurationMs: 800,
    vadThreshold: 0.5,
    sentenceMinChars: 20,
    sentenceMaxChars: 200,
    maxParallelTTS: 3,
    jitterBufferFrames: 25,
    thinkLevel: undefined,
    endOfTurnCue: false,
    ttsMode: "auto" as const,
    realtimeModel: "gpt-4o-mini-realtime-preview",
  }),

  /**
   * OpenAI Realtime API configuration.
   * Used when streaming.ttsMode is "realtime".
   * NOTE: OpenAI Realtime API has a 15-minute session limit.
   */
  realtime: RealtimeConfigSchema.optional().transform((v) => v ?? {
    model: "gpt-4o-realtime-preview",
    voice: "coral",
    turnDetection: {
      type: "server_vad" as const,
      threshold: 0.5,
      silenceDurationMs: 300, // OpenAI default is 200ms
      prefixPaddingMs: 300,
    },
    tools: undefined,
    maxSessionDurationMs: 840000, // 14 minutes
  }),

  /** Model to use for generating responses (default: openai/gpt-4o-mini) */
  responseModel: z.string().default("openai/gpt-4o-mini"),

  /** System prompt for response generation */
  responseSystemPrompt: z.string().optional(),

  /** Response generation timeout in ms (default: 30000) */
  responseTimeoutMs: z.number().min(1000).max(300000).default(30000),

  /** Max concurrent calls (default: 5) */
  maxConcurrentCalls: z.number().min(1).max(100).default(5),

  /** Max call duration in seconds (default: 3600 = 1 hour) */
  maxDurationSeconds: z.number().min(60).max(86400).default(3600),
});

/**
 * Inferred TypeScript type for the config.
 */
export type TeamsCallConfig = z.infer<typeof TeamsCallConfigSchema>;

/**
 * Validate and parse a raw config object.
 */
export function parseTeamsCallConfig(raw: unknown): TeamsCallConfig {
  return TeamsCallConfigSchema.parse(raw);
}

/**
 * Get default configuration.
 */
export function getDefaultConfig(): Partial<TeamsCallConfig> {
  return {
    enabled: false,
    serve: {
      port: 3335,
      bind: "127.0.0.1",
      path: "/teams-call/stream",
    },
    inbound: {
      enabled: true,
    },
    outbound: {
      enabled: true,
      ringTimeoutMs: 30000,
      defaultMode: "conversation",
    },
    tts: {
      model: "gpt-4o-mini-tts",
      voice: "coral",
      speed: 1.0,
    },
    streaming: {
      sttModel: "gpt-4o-transcribe",
      silenceDurationMs: 800,
      vadThreshold: 0.5,
      sentenceMinChars: 20,
      sentenceMaxChars: 200,
      maxParallelTTS: 3,
      jitterBufferFrames: 25,
      endOfTurnCue: false,
      ttsMode: "auto",
      realtimeModel: "gpt-4o-mini-realtime-preview",
    },
    realtime: {
      model: "gpt-4o-realtime-preview",
      voice: "coral",
      turnDetection: {
        type: "server_vad",
        threshold: 0.5,
        silenceDurationMs: 300, // OpenAI default is 200ms
        prefixPaddingMs: 300,
      },
      maxSessionDurationMs: 840000, // 14 minutes (OpenAI has 15min limit)
    },
    responseModel: "openai/gpt-4o-mini",
    responseTimeoutMs: 30000,
    maxConcurrentCalls: 5,
    maxDurationSeconds: 3600,
  };
}
