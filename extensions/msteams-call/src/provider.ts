/**
 * MS Teams Voice Call Provider
 *
 * Implements the voice call provider interface for MS Teams.
 * Unlike telephony providers (Twilio, Telnyx), Teams uses a
 * WebSocket bridge to the C# media gateway for audio streaming.
 */

import { EventEmitter } from "events";
import type { TeamsAudioBridge, TTSProvider, STTProvider } from "./bridge.js";
import type {
  CallSession,
  CallEvent,
  CallTarget,
} from "./types.js";
import type { TeamsCallConfig } from "./config.js";
import type { Logger } from "./bridge.js";

/**
 * Stored event listener reference for cleanup.
 */
interface StoredListener {
  event: string;
  handler: (...args: unknown[]) => void;
}

/**
 * Call initiation parameters.
 */
export interface TeamsCallInitiateInput {
  /** Unique call ID */
  callId: string;
  /** Target user ID or phone number */
  to: string;
  /** Initial message to speak (optional) */
  message?: string;
  /** Timeout for call to be answered in ms */
  timeoutMs?: number;
}

/**
 * Call initiation result.
 */
export interface TeamsCallInitiateResult {
  callId: string;
  status: "answered" | "failed";
  error?: string;
}

/**
 * TTS playback parameters.
 */
export interface TeamsPlayTtsInput {
  callId: string;
  text: string;
}

/**
 * Hangup parameters.
 */
export interface TeamsHangupInput {
  callId: string;
}

/**
 * MS Teams Voice Call Provider.
 *
 * Wraps the TeamsAudioBridge and provides a high-level API
 * for managing Teams voice calls.
 */
export class TeamsCallProvider extends EventEmitter {
  readonly name = "teams" as const;
  private bridge: TeamsAudioBridge;
  private config: TeamsCallConfig;
  private logger?: Logger;
  private started = false;

  // Store listener references for cleanup
  private bridgeListeners: StoredListener[] = [];

  constructor(bridge: TeamsAudioBridge, config: TeamsCallConfig, logger?: Logger) {
    super();
    this.bridge = bridge;
    this.config = config;
    this.logger = logger;

    // Forward events from bridge - store references for cleanup
    const callStartedHandler = (evt: CallEvent) => {
      this.emit("callStarted", evt);
    };
    const transcriptHandler = (evt: CallEvent) => {
      this.emit("transcript", evt);
    };
    const callEndedHandler = (evt: CallEvent) => {
      this.emit("callEnded", evt);
    };
    const callErrorHandler = (evt: CallEvent) => {
      this.emit("callError", evt);
    };

    this.bridge.on("callStarted", callStartedHandler);
    this.bridge.on("transcript", transcriptHandler);
    this.bridge.on("callEnded", callEndedHandler);
    this.bridge.on("callError", callErrorHandler);

    // Store for cleanup
    this.bridgeListeners = [
      { event: "callStarted", handler: callStartedHandler as (...args: unknown[]) => void },
      { event: "transcript", handler: transcriptHandler as (...args: unknown[]) => void },
      { event: "callEnded", handler: callEndedHandler as (...args: unknown[]) => void },
      { event: "callError", handler: callErrorHandler as (...args: unknown[]) => void },
    ];
  }

  /**
   * Start the provider (starts the bridge server).
   */
  async start(): Promise<void> {
    if (this.started) return;
    await this.bridge.start();
    this.started = true;
  }

  /**
   * Stop the provider (stops the bridge server).
   */
  async stop(): Promise<void> {
    if (!this.started) return;

    // Clean up event listeners to prevent memory leaks
    for (const { event, handler } of this.bridgeListeners) {
      this.bridge.removeListener(event, handler);
    }
    this.bridgeListeners = [];

    await this.bridge.stop();
    this.started = false;
  }

  /**
   * Set the TTS provider.
   */
  setTTSProvider(provider: TTSProvider): void {
    this.bridge.setTTSProvider(provider);
  }

  /**
   * Set the STT provider.
   */
  setSTTProvider(provider: STTProvider): void {
    this.bridge.setSTTProvider(provider);
  }

  /**
   * Get a call session by ID.
   */
  getSession(callId: string): CallSession | undefined {
    return this.bridge.getSession(callId);
  }

  /**
   * Get count of active calls.
   */
  getActiveCallCount(): number {
    return this.bridge.getActiveCallCount();
  }

  /**
   * Initiate an outbound call.
   *
   * Note: This requires the C# gateway to be configured to call
   * our control plane endpoint (POST /control/initiateCall).
   * The provider sends the initiate_call message over WebSocket,
   * and the gateway creates the Teams call via Graph API.
   */
  async initiateCall(
    input: TeamsCallInitiateInput,
  ): Promise<TeamsCallInitiateResult> {
    if (!this.config.outbound.enabled) {
      throw new Error("Outbound calls are disabled");
    }

    const target = this.parseTarget(input.to);
    const timeoutMs = input.timeoutMs ?? this.config.outbound.ringTimeoutMs;

    try {
      const result = await this.bridge.initiateCall({
        callId: input.callId,
        target,
        message: input.message,
        timeoutMs,
      });

      return {
        callId: result.callId,
        status: "answered",
      };
    } catch (error) {
      this.logger?.error("[TeamsCallProvider] initiateCall failed:", error);
      return {
        callId: input.callId,
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Hang up an active call.
   */
  async hangupCall(input: TeamsHangupInput): Promise<void> {
    await this.bridge.endCall(input.callId);
  }

  /**
   * Play TTS audio on a call.
   */
  async playTts(input: TeamsPlayTtsInput): Promise<void> {
    await this.bridge.speak(input.callId, input.text);
  }

  /**
   * Parse a target string into a CallTarget.
   *
   * Formats:
   * - "user:aad-object-id" → Teams user
   * - "+15551234567" → Phone number (requires PSTN)
   */
  private parseTarget(to: string): CallTarget {
    if (to.startsWith("user:")) {
      return { type: "user", userId: to.slice(5) };
    }
    if (to.startsWith("+")) {
      return { type: "phone", number: to };
    }
    // Default to user ID
    return { type: "user", userId: to };
  }
}

/**
 * Create a TeamsCallProvider from configuration.
 */
export function createTeamsCallProvider(
  bridge: TeamsAudioBridge,
  config: TeamsCallConfig,
  logger?: Logger,
): TeamsCallProvider {
  return new TeamsCallProvider(bridge, config, logger);
}
