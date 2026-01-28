/**
 * OpenAI Realtime STT Provider for MS Teams
 *
 * Uses the OpenAI Realtime API for streaming transcription with:
 * - PCM16 audio at 24kHz (bridge resamples from Teams 16kHz)
 * - Built-in server-side VAD for turn detection
 * - Low-latency streaming transcription
 */

import WebSocket from "ws";
import type { STTProvider, STTSession, Logger } from "../bridge.js";

/**
 * Configuration for OpenAI Realtime STT.
 */
export interface RealtimeSTTConfig {
  /** OpenAI API key */
  apiKey: string;
  /** Model to use (default: gpt-4o-transcribe) */
  model?: string;
  /** Silence duration in ms before considering speech ended (default: 800) */
  silenceDurationMs?: number;
  /** VAD threshold 0-1 (default: 0.5) */
  vadThreshold?: number;
  /**
   * Input audio format:
   * - "g711_ulaw": 8kHz mono mu-law (telephony)
   * - "pcm16": 24kHz mono PCM (Teams/high quality)
   */
  inputAudioFormat?: "g711_ulaw" | "pcm16";
  /** Optional logger */
  logger?: Logger;
}

/**
 * Provider factory for OpenAI Realtime STT sessions.
 */
export class OpenAIRealtimeSTTProvider implements STTProvider {
  readonly name = "openai-realtime";
  private apiKey: string;
  private model: string;
  private silenceDurationMs: number;
  private vadThreshold: number;
  private inputAudioFormat: "g711_ulaw" | "pcm16";
  private logger?: Logger;

  constructor(config: RealtimeSTTConfig) {
    if (!config.apiKey) {
      throw new Error("OpenAI API key required for Realtime STT");
    }
    this.apiKey = config.apiKey;
    this.model = config.model || "gpt-4o-transcribe";
    this.silenceDurationMs = config.silenceDurationMs || 800;
    this.vadThreshold = config.vadThreshold || 0.5;
    this.inputAudioFormat = config.inputAudioFormat || "pcm16";
    this.logger = config.logger;
  }

  /**
   * Create a new realtime transcription session.
   */
  createSession(): STTSession {
    return new OpenAIRealtimeSTTSession(
      this.apiKey,
      this.model,
      this.silenceDurationMs,
      this.vadThreshold,
      this.inputAudioFormat,
      this.logger,
    );
  }
}

/**
 * Extended STT session interface with error and barge-in callbacks.
 */
export interface ExtendedSTTSession extends STTSession {
  /** Register error callback */
  onError(callback: (error: Error) => void): void;
  /** Register callback for when user starts speaking (barge-in detection) */
  onUserSpeaking(callback: () => void): void;
}

/**
 * WebSocket-based session for real-time speech-to-text.
 */
class OpenAIRealtimeSTTSession implements ExtendedSTTSession {
  private static readonly MAX_RECONNECT_ATTEMPTS = 5;
  private static readonly RECONNECT_DELAY_MS = 1000;

  private ws: WebSocket | null = null;
  private connected = false;
  private closed = false;
  private reconnectAttempts = 0;
  private pendingTranscript = "";
  private onTranscriptCallback: ((transcript: string) => void) | null = null;
  private onPartialCallback: ((partial: string) => void) | null = null;
  private onErrorCallback: ((error: Error) => void) | null = null;
  private onUserSpeakingCallback: (() => void) | null = null;
  private logger?: Logger;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly silenceDurationMs: number,
    private readonly vadThreshold: number,
    private readonly inputAudioFormat: "g711_ulaw" | "pcm16",
    logger?: Logger,
  ) {
    this.logger = logger;
  }

  async connect(): Promise<void> {
    this.closed = false;
    this.reconnectAttempts = 0;
    return this.doConnect();
  }

  private async doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = "wss://api.openai.com/v1/realtime?intent=transcription";

      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });

      this.ws.on("open", () => {
        this.connected = true;
        this.reconnectAttempts = 0;

        // Configure the transcription session
        this.sendEvent({
          type: "transcription_session.update",
          session: {
            input_audio_format: this.inputAudioFormat,
            input_audio_transcription: {
              model: this.model,
            },
            turn_detection: {
              type: "server_vad",
              threshold: this.vadThreshold,
              prefix_padding_ms: 300,
              silence_duration_ms: this.silenceDurationMs,
            },
          },
        });

        resolve();
      });

      this.ws.on("message", (data: Buffer) => {
        try {
          const event = JSON.parse(data.toString());
          this.handleEvent(event);
        } catch (e) {
          this.logger?.error("[RealtimeSTT] Failed to parse event:", e);
        }
      });

      this.ws.on("error", (error) => {
        this.logger?.error("[RealtimeSTT] WebSocket error:", error);
        if (!this.connected) reject(error);
      });

      this.ws.on("close", (code, reason) => {
        this.logger?.debug(
          `[RealtimeSTT] WebSocket closed (code: ${code}, reason: ${reason?.toString() || "none"})`,
        );
        this.connected = false;

        // Attempt reconnection if not intentionally closed
        if (!this.closed) {
          void this.attemptReconnect();
        }
      });

      setTimeout(() => {
        if (!this.connected) {
          reject(new Error("Realtime STT connection timeout"));
        }
      }, 10000);
    });
  }

  private async attemptReconnect(): Promise<void> {
    if (this.closed) {
      return;
    }

    if (
      this.reconnectAttempts >= OpenAIRealtimeSTTSession.MAX_RECONNECT_ATTEMPTS
    ) {
      const error = new Error(
        `[RealtimeSTT] STT reconnection failed after ${OpenAIRealtimeSTTSession.MAX_RECONNECT_ATTEMPTS} attempts`
      );
      this.logger?.error(error.message);
      this.onErrorCallback?.(error);
      return;
    }

    this.reconnectAttempts++;
    const delay =
      OpenAIRealtimeSTTSession.RECONNECT_DELAY_MS *
      2 ** (this.reconnectAttempts - 1);
    this.logger?.debug(
      `[RealtimeSTT] Reconnecting ${this.reconnectAttempts}/${OpenAIRealtimeSTTSession.MAX_RECONNECT_ATTEMPTS} in ${delay}ms...`,
    );

    await new Promise((resolve) => setTimeout(resolve, delay));

    if (this.closed) {
      return;
    }

    try {
      await this.doConnect();
      this.logger?.debug("[RealtimeSTT] Reconnected successfully");
    } catch (error) {
      this.logger?.error("[RealtimeSTT] Reconnect failed:", error);
    }
  }

  private handleEvent(event: {
    type: string;
    delta?: string;
    transcript?: string;
    error?: unknown;
  }): void {
    switch (event.type) {
      case "transcription_session.created":
      case "transcription_session.updated":
      case "input_audio_buffer.speech_stopped":
      case "input_audio_buffer.committed":
        // Informational events
        break;

      case "conversation.item.input_audio_transcription.delta":
        if (event.delta) {
          this.pendingTranscript += event.delta;
          this.onPartialCallback?.(this.pendingTranscript);
        }
        break;

      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript) {
          this.onTranscriptCallback?.(event.transcript);
        }
        this.pendingTranscript = "";
        break;

      case "input_audio_buffer.speech_started":
        // Emit user speaking event for barge-in detection
        this.onUserSpeakingCallback?.();
        this.pendingTranscript = "";
        break;

      case "error":
        this.logger?.error("[RealtimeSTT] Error:", event.error);
        break;
    }
  }

  private sendEvent(event: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
    }
  }

  /**
   * Send audio data to be transcribed.
   * For pcm16 format, audio should be 24kHz mono 16-bit PCM.
   */
  sendAudio(audioData: Buffer): void {
    if (!this.connected) return;
    this.sendEvent({
      type: "input_audio_buffer.append",
      audio: audioData.toString("base64"),
    });
  }

  onPartial(callback: (partial: string) => void): void {
    this.onPartialCallback = callback;
  }

  onTranscript(callback: (transcript: string) => void): void {
    this.onTranscriptCallback = callback;
  }

  onError(callback: (error: Error) => void): void {
    this.onErrorCallback = callback;
  }

  onUserSpeaking(callback: () => void): void {
    this.onUserSpeakingCallback = callback;
  }

  close(): void {
    this.closed = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }
}
