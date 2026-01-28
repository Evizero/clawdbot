/**
 * OpenAI Realtime API Session
 *
 * WebSocket-based session for direct voice interaction with OpenAI's Realtime API.
 * This uses the Realtime API as THE agent (not as TTS), enabling:
 * - Single LLM execution (no double model)
 * - Direct tool access via function calling
 * - Streaming audio I/O with natural prosody
 * - VAD-based turn detection
 * - Interruption handling
 *
 * Audio Pipeline:
 *   User Audio (16kHz) → resample → Realtime API (24kHz) → resample → Teams (16kHz)
 *
 * Tool Flow (CRITICAL):
 *   1. response.function_call_arguments.done → capture name + call_id
 *   2. Execute tool
 *   3. conversation.item.create with tool result
 *   4. response.create to continue conversation ← REQUIRED!
 */

import WebSocket from "ws";
import type { Logger } from "./bridge.js";

/**
 * Configuration for the Realtime session.
 */
export interface RealtimeSessionConfig {
  /** OpenAI API key */
  apiKey: string;
  /** Model to use (default: gpt-4o-realtime) */
  model?: string;
  /** Voice to use for audio output */
  voice?: string;
  /** System instructions */
  instructions?: string;
  /** Tools available to the session */
  tools?: RealtimeTool[];
  /** Turn detection settings */
  turnDetection?: {
    type: "server_vad" | "none";
    threshold?: number;
    silenceDurationMs?: number;
    prefixPaddingMs?: number;
  };
  /** Logger for debug output */
  logger?: Logger;
}

/**
 * Tool definition for Realtime API.
 */
export interface RealtimeTool {
  type: "function";
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Function call from the model.
 */
export interface FunctionCall {
  callId: string;
  name: string;
  arguments: string;
}

/**
 * Events emitted by the Realtime session.
 */
export interface RealtimeSessionEvents {
  /** Streaming audio delta received */
  onAudioDelta?: (audio: Buffer) => void;
  /** Audio generation complete for current response */
  onAudioDone?: () => void;
  /** Model text output (transcript of speech) */
  onTextDelta?: (text: string) => void;
  /** Function call from model - execute and call submitToolResult() */
  onFunctionCall?: (call: FunctionCall) => void;
  /** User started speaking (VAD detected) */
  onUserSpeakingStarted?: () => void;
  /** User stopped speaking */
  onUserSpeakingStopped?: () => void;
  /** Transcript of user's speech */
  onInputTranscript?: (text: string, isFinal: boolean) => void;
  /** Response was cancelled/interrupted */
  onResponseCancelled?: () => void;
  /** Session error */
  onError?: (error: Error) => void;
  /** Session closed */
  onClose?: (code: number, reason: string) => void;
}

/**
 * Internal state for tracking responses.
 */
interface ResponseState {
  id: string;
  pendingFunctionCalls: Map<string, FunctionCall>;
  audioDeltas: number;
}

/**
 * OpenAI Realtime API session.
 *
 * Usage:
 * 1. Create session with config (system prompt, tools, voice)
 * 2. Connect with event handlers
 * 3. Send audio via sendAudio() as it arrives
 * 4. Receive audio via onAudioDelta callback
 * 5. Handle tool calls via onFunctionCall + submitToolResult()
 * 6. Call interrupt() on barge-in
 * 7. Call close() when done
 */
export class RealtimeSession {
  private ws: WebSocket | null = null;
  private connected = false;
  private closed = false;
  private config: RealtimeSessionConfig;
  private events: RealtimeSessionEvents = {};
  private currentResponse: ResponseState | null = null;
  private logger?: Logger;
  private audioFramesSent = 0;

  constructor(config: RealtimeSessionConfig) {
    if (!config.apiKey) {
      throw new Error("OpenAI API key required for Realtime session");
    }
    this.config = {
      model: "gpt-4o-realtime-preview",
      voice: "coral",
      ...config,
    };
    this.logger = config.logger;
  }

  /**
   * Connect to the Realtime API.
   */
  async connect(events: RealtimeSessionEvents = {}): Promise<void> {
    if (this.connected) {
      throw new Error("Already connected");
    }

    this.events = events;
    this.closed = false;

    return new Promise((resolve, reject) => {
      const url = `wss://api.openai.com/v1/realtime?model=${this.config.model}`;

      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });

      const connectionTimeout = setTimeout(() => {
        if (!this.connected) {
          this.ws?.close();
          reject(new Error("Realtime API connection timeout"));
        }
      }, 15000);

      this.ws.on("open", () => {
        clearTimeout(connectionTimeout);
        this.connected = true;
        this.logger?.debug("[RealtimeSession] Connected to OpenAI Realtime API");
        this.configureSession();
        resolve();
      });

      this.ws.on("message", (data: Buffer) => {
        try {
          const event = JSON.parse(data.toString());
          this.handleEvent(event);
        } catch (e) {
          this.logger?.error("[RealtimeSession] Failed to parse event:", e);
        }
      });

      this.ws.on("error", (error) => {
        clearTimeout(connectionTimeout);
        this.logger?.error("[RealtimeSession] WebSocket error:", error);
        if (!this.connected) {
          reject(error);
        }
        this.events.onError?.(error);
      });

      this.ws.on("close", (code, reason) => {
        clearTimeout(connectionTimeout);
        const reasonStr = reason?.toString() || "none";
        this.logger?.debug(
          `[RealtimeSession] WebSocket closed (code: ${code}, reason: ${reasonStr})`
        );
        this.connected = false;
        this.events.onClose?.(code, reasonStr);
      });
    });
  }

  /**
   * Configure the session after connection.
   */
  private configureSession(): void {
    const sessionConfig: Record<string, unknown> = {
      modalities: ["text", "audio"],
      voice: this.config.voice,
      input_audio_format: "pcm16",
      output_audio_format: "pcm16",
      input_audio_transcription: {
        model: "whisper-1",
      },
    };

    // Add instructions if provided
    if (this.config.instructions) {
      sessionConfig.instructions = this.config.instructions;
    }

    // Add tools if provided
    if (this.config.tools && this.config.tools.length > 0) {
      sessionConfig.tools = this.config.tools;
    }

    // Configure turn detection
    if (this.config.turnDetection) {
      const td = this.config.turnDetection;
      if (td.type === "server_vad") {
        sessionConfig.turn_detection = {
          type: "server_vad",
          threshold: td.threshold ?? 0.5,
          silence_duration_ms: td.silenceDurationMs ?? 300,
          prefix_padding_ms: td.prefixPaddingMs ?? 300,
        };
      } else {
        sessionConfig.turn_detection = null;
      }
    } else {
      // Default to server VAD
      sessionConfig.turn_detection = {
        type: "server_vad",
        threshold: 0.5,
        silence_duration_ms: 300,
        prefix_padding_ms: 300,
      };
    }

    this.logger?.info(
      `[RealtimeSession] Sending session.update: ${JSON.stringify(sessionConfig).slice(0, 500)}`
    );
    this.sendEvent({
      type: "session.update",
      session: sessionConfig,
    });
  }

  /**
   * Update session configuration.
   */
  updateSession(config: {
    instructions?: string;
    tools?: RealtimeTool[];
    voice?: string;
    turnDetection?: RealtimeSessionConfig["turnDetection"];
  }): void {
    if (!this.connected) {
      throw new Error("Not connected");
    }

    const sessionUpdate: Record<string, unknown> = {};

    if (config.instructions !== undefined) {
      sessionUpdate.instructions = config.instructions;
    }
    if (config.tools !== undefined) {
      sessionUpdate.tools = config.tools;
    }
    if (config.voice !== undefined) {
      sessionUpdate.voice = config.voice;
    }
    if (config.turnDetection !== undefined) {
      const td = config.turnDetection;
      if (td?.type === "server_vad") {
        sessionUpdate.turn_detection = {
          type: "server_vad",
          threshold: td.threshold ?? 0.5,
          silence_duration_ms: td.silenceDurationMs ?? 300,
          prefix_padding_ms: td.prefixPaddingMs ?? 300,
        };
      } else {
        sessionUpdate.turn_detection = null;
      }
    }

    this.sendEvent({
      type: "session.update",
      session: sessionUpdate,
    });
  }

  /**
   * Send audio to the Realtime API.
   * Audio must be 24kHz PCM16 mono.
   *
   * @param audio Buffer containing 24kHz PCM16 audio
   */
  sendAudio(audio: Buffer): void {
    if (!this.connected || this.closed) {
      return;
    }

    this.audioFramesSent++;
    // Removed frequent audio stats logging - was too noisy

    // Send audio in base64 format
    this.sendEvent({
      type: "input_audio_buffer.append",
      audio: audio.toString("base64"),
    });
  }

  /**
   * Commit the current audio buffer (trigger transcription).
   * Usually called automatically by VAD, but can be called manually.
   */
  commitAudio(): void {
    if (!this.connected || this.closed) {
      return;
    }

    this.sendEvent({
      type: "input_audio_buffer.commit",
    });
  }

  /**
   * Clear the audio buffer (discard uncommitted audio).
   */
  clearAudioBuffer(): void {
    if (!this.connected || this.closed) {
      return;
    }

    this.sendEvent({
      type: "input_audio_buffer.clear",
    });
  }

  /**
   * Submit tool result back to the model.
   * CRITICAL: This calls conversation.item.create + response.create
   *
   * @param callId The call_id from the function call
   * @param result The tool result (will be JSON stringified if object)
   */
  submitToolResult(callId: string, result: unknown): void {
    if (!this.connected || this.closed) {
      return;
    }

    const resultStr = typeof result === "string" ? result : JSON.stringify(result);

    // Step 1: Add tool result to conversation
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: resultStr,
      },
    });

    // Step 2: Request model to continue (CRITICAL!)
    this.sendEvent({
      type: "response.create",
    });

    this.logger?.debug(
      `[RealtimeSession] Submitted tool result for ${callId}, triggered response.create`
    );
  }

  /**
   * Interrupt the current response (for barge-in).
   */
  interrupt(): void {
    if (!this.connected || this.closed) {
      return;
    }

    this.logger?.debug("[RealtimeSession] Interrupting response");

    // Cancel any in-progress response
    this.sendEvent({
      type: "response.cancel",
    });

    // Clear any pending audio
    this.sendEvent({
      type: "input_audio_buffer.clear",
    });

    this.currentResponse = null;
  }

  /**
   * Manually trigger a response (for turn-based interaction).
   */
  createResponse(): void {
    if (!this.connected || this.closed) {
      return;
    }

    this.sendEvent({
      type: "response.create",
    });
  }

  /**
   * Handle incoming Realtime API events.
   */
  private handleEvent(event: {
    type: string;
    // Common fields
    response_id?: string;
    item_id?: string;
    // Audio fields
    delta?: string;
    audio?: string;
    // Text fields
    text?: string;
    transcript?: string;
    // Function call fields
    name?: string;
    call_id?: string;
    arguments?: string;
    // Error fields
    error?: { message?: string; code?: string };
    // Session fields
    session?: Record<string, unknown>;
    // Response fields (for response.done)
    response?: { id?: string; status?: string; status_details?: unknown };
  }): void {
    switch (event.type) {
      // Session events
      case "session.created":
        this.logger?.debug("[RealtimeSession] Session created");
        break;

      case "session.updated":
        this.logger?.info(
          `[RealtimeSession] Session updated: ${JSON.stringify(event.session || {}).slice(0, 500)}`
        );
        break;

      // Response lifecycle
      case "response.created": {
        // response_id may be at top level or in response object
        const responseId = event.response_id || (event.response as { id?: string })?.id || "";
        this.currentResponse = {
          id: responseId,
          pendingFunctionCalls: new Map(),
          audioDeltas: 0,
        };
        this.logger?.info(`[RealtimeSession] Response created: ${responseId}`);
        break;
      }

      case "response.done": {
        // Check if response was cancelled (interrupted)
        const status = event.response?.status || "completed";
        const audioDeltas = this.currentResponse?.audioDeltas || 0;
        this.logger?.info(
          `[RealtimeSession] Response done: ${this.currentResponse?.id || event.response?.id} ` +
          `(status: ${status}, audioDeltas: ${audioDeltas})`
        );
        if (status === "cancelled" || status === "incomplete") {
          this.logger?.info(`[RealtimeSession] Response was interrupted/cancelled`);
          this.events.onResponseCancelled?.();
        }
        this.currentResponse = null;
        break;
      }

      // Audio output
      case "response.audio.delta":
        if (event.delta) {
          const audioBuffer = Buffer.from(event.delta, "base64");
          if (this.currentResponse) {
            this.currentResponse.audioDeltas++;
            // Log first delta and every 50th for debugging
            if (this.currentResponse.audioDeltas === 1) {
              this.logger?.info(
                `[RealtimeSession] First audio delta received: ${audioBuffer.length} bytes (response: ${this.currentResponse.id})`
              );
            }
          }
          this.events.onAudioDelta?.(audioBuffer);
        }
        break;

      case "response.audio.done":
        this.logger?.info("[RealtimeSession] Audio output complete");
        this.events.onAudioDone?.();
        break;

      // Text output (transcript of assistant speech)
      case "response.audio_transcript.delta":
        if (event.delta) {
          this.events.onTextDelta?.(event.delta);
        }
        break;

      case "response.text.delta":
        if (event.delta) {
          this.events.onTextDelta?.(event.delta);
        }
        break;

      // Function calls
      case "response.function_call_arguments.delta":
        // Accumulate arguments - handled in .done
        break;

      case "response.function_call_arguments.done":
        if (event.call_id && event.name) {
          const call: FunctionCall = {
            callId: event.call_id,
            name: event.name,
            arguments: event.arguments || "{}",
          };
          this.logger?.debug(
            `[RealtimeSession] Function call: ${call.name}(${call.arguments.slice(0, 100)})`
          );
          this.events.onFunctionCall?.(call);
        }
        break;

      // Input audio events (VAD)
      case "input_audio_buffer.speech_started":
        this.logger?.info("[RealtimeSession] VAD: Speech started");
        this.events.onUserSpeakingStarted?.();
        break;

      case "input_audio_buffer.speech_stopped":
        this.logger?.info("[RealtimeSession] VAD: Speech stopped");
        this.events.onUserSpeakingStopped?.();
        break;

      case "input_audio_buffer.committed":
        this.logger?.info("[RealtimeSession] Audio buffer committed - API will now process user speech and generate response");
        break;

      // Input transcription
      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript) {
          this.events.onInputTranscript?.(event.transcript, true);
        }
        break;

      // Error handling
      case "error":
        const errorMsg = event.error?.message || "Unknown error";
        const errorCode = event.error?.code || "unknown";
        this.logger?.error(
          `[RealtimeSession] Error (${errorCode}): ${errorMsg} - Full: ${JSON.stringify(event).slice(0, 500)}`
        );
        this.events.onError?.(new Error(errorMsg));
        break;

      default:
        // Log unknown events for debugging
        this.logger?.debug(
          `[RealtimeSession] Event: ${event.type} ${JSON.stringify(event).slice(0, 200)}`
        );
        break;
    }
  }

  /**
   * Send event to the Realtime API.
   */
  private sendEvent(event: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
    }
  }

  /**
   * Check if connected.
   */
  isConnected(): boolean {
    return this.connected && !this.closed;
  }

  /**
   * Close the session.
   */
  close(): void {
    this.closed = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }
}
