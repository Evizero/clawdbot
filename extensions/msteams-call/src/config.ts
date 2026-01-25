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
  /** OpenAI API key (uses OPENAI_API_KEY env if not set) */
  openaiApiKey: z.string().optional(),
  /** STT model (default: gpt-4o-transcribe) */
  sttModel: z.string().default("gpt-4o-transcribe"),
  /** Silence duration in ms before considering speech ended (default: 800) */
  silenceDurationMs: z.number().min(100).max(5000).default(800),
  /** VAD threshold 0-1 (default: 0.5) */
  vadThreshold: z.number().min(0).max(1).default(0.5),
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

  /** Streaming STT settings */
  streaming: StreamingConfigSchema.optional().transform((v) => v ?? {
    openaiApiKey: undefined,
    sttModel: "gpt-4o-transcribe",
    silenceDurationMs: 800,
    vadThreshold: 0.5,
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
    },
    responseModel: "openai/gpt-4o-mini",
    responseTimeoutMs: 30000,
    maxConcurrentCalls: 5,
    maxDurationSeconds: 3600,
  };
}
