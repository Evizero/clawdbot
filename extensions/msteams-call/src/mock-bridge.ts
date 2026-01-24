/**
 * Mock Teams Bridge for Testing
 *
 * Simulates the C# media gateway for testing purposes.
 * Acts as a WebSocket client that connects to the Clawdbot bridge.
 */

import WebSocket from "ws";
import type {
  InboundMessage,
  OutboundMessage,
  SessionMetadata,
  EndReason,
  CallStatus,
} from "./types.js";
import { chunkAudio } from "./audio-utils.js";

/**
 * Configuration for the mock bridge.
 */
export interface MockBridgeConfig {
  /** Host to connect to (default: localhost) */
  host?: string;
  /** Port to connect to */
  port: number;
  /** WebSocket path (default: /teams-call/stream) */
  path?: string;
  /** Shared secret for authentication */
  secret: string;
  /** Auto-send session_start after connect (default: false) */
  autoAnswer?: boolean;
  /** Auto-generate audio_in frames (default: false) */
  autoGenerateAudio?: boolean;
  /** Pre-recorded audio buffer to stream */
  audioBuffer?: Buffer;
  /** Simulate network latency in ms (default: 0) */
  responseDelay?: number;
}

/**
 * Recorded message for test assertions.
 */
export interface RecordedMessage {
  callId: string;
  type: string;
  data: unknown;
  timestamp: number;
}

/**
 * Mock Teams Bridge for simulating the C# media gateway.
 */
export class MockTeamsBridge {
  private config: Required<MockBridgeConfig>;
  private ws: WebSocket | null = null;
  private connected = false;
  private audioSequences: Map<string, number> = new Map();

  /** Messages received from Clawdbot */
  public receivedMessages: RecordedMessage[] = [];
  /** Messages sent to Clawdbot */
  public sentMessages: RecordedMessage[] = [];
  /** Event callbacks */
  private onMessageCallbacks: Array<(msg: OutboundMessage) => void> = [];

  constructor(config: MockBridgeConfig) {
    this.config = {
      host: config.host ?? "localhost",
      port: config.port,
      path: config.path ?? "/teams-call/stream",
      secret: config.secret,
      autoAnswer: config.autoAnswer ?? false,
      autoGenerateAudio: config.autoGenerateAudio ?? false,
      audioBuffer: config.audioBuffer ?? Buffer.alloc(0),
      responseDelay: config.responseDelay ?? 0,
    };
  }

  /**
   * Connect to the Clawdbot bridge.
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `ws://${this.config.host}:${this.config.port}${this.config.path}`;

      this.ws = new WebSocket(url, {
        headers: {
          "X-Bridge-Secret": this.config.secret,
        },
      });

      const connectTimeout = setTimeout(() => {
        if (!this.connected) {
          reject(new Error("Connection timeout"));
          this.ws?.close();
        }
      }, 5000);

      this.ws.on("open", () => {
        clearTimeout(connectTimeout);
        this.connected = true;
        resolve();
      });

      this.ws.on("message", (data: Buffer) => {
        try {
          const raw = data.toString();
          // Parse as outbound message (what Clawdbot sends to us)
          const parsed = JSON.parse(raw) as OutboundMessage;
          this.recordReceived(parsed);

          // Notify callbacks
          for (const cb of this.onMessageCallbacks) {
            cb(parsed);
          }
        } catch (e) {
          console.error("[MockBridge] Failed to parse message:", e);
        }
      });

      this.ws.on("error", (error) => {
        clearTimeout(connectTimeout);
        if (!this.connected) {
          reject(error);
        }
      });

      this.ws.on("close", (code) => {
        this.connected = false;
        if (!this.connected && code === 4001) {
          reject(new Error("Authentication failed"));
        }
      });
    });
  }

  /**
   * Check if connected to the bridge.
   */
  isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Close the connection.
   */
  async stop(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.audioSequences.clear();
  }

  /**
   * Register a callback for received messages.
   */
  onMessage(callback: (msg: OutboundMessage) => void): void {
    this.onMessageCallbacks.push(callback);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Simulation methods (what the C# gateway would send)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Simulate an inbound call connecting.
   */
  async simulateInboundCall(
    callId: string,
    metadata?: Partial<SessionMetadata>,
  ): Promise<void> {
    await this.applyDelay();
    this.send({
      type: "session_start",
      callId,
      direction: "inbound",
      metadata: {
        tenantId: metadata?.tenantId ?? "mock-tenant",
        userId: metadata?.userId ?? "mock-user",
        teamsCallId: metadata?.teamsCallId ?? `teams-${callId}`,
        displayName: metadata?.displayName,
        userPrincipalName: metadata?.userPrincipalName,
      },
    });
  }

  /**
   * Simulate an outbound call being answered.
   */
  async simulateCallAnswered(
    callId: string,
    metadata?: Partial<SessionMetadata>,
  ): Promise<void> {
    await this.applyDelay();

    // First send ringing status
    this.send({
      type: "call_status",
      callId,
      status: "ringing",
    });

    await this.applyDelay();

    // Then send answered status
    this.send({
      type: "call_status",
      callId,
      status: "answered",
    });

    // Then send session_start for the outbound call
    this.send({
      type: "session_start",
      callId,
      direction: "outbound",
      metadata: {
        tenantId: metadata?.tenantId ?? "mock-tenant",
        userId: metadata?.userId ?? "mock-user",
        teamsCallId: metadata?.teamsCallId ?? `teams-${callId}`,
        displayName: metadata?.displayName,
        userPrincipalName: metadata?.userPrincipalName,
      },
    });
  }

  /**
   * Simulate an outbound call failing.
   */
  async simulateCallFailed(callId: string, error: string): Promise<void> {
    await this.applyDelay();
    this.send({
      type: "call_status",
      callId,
      status: "failed",
      error,
    });
  }

  /**
   * Simulate call status (ringing, busy, no-answer).
   */
  async simulateCallStatus(callId: string, status: CallStatus, error?: string): Promise<void> {
    await this.applyDelay();
    this.send({
      type: "call_status",
      callId,
      status,
      error,
    });
  }

  /**
   * Stream audio frames to Clawdbot.
   * Splits buffer into 640-byte (20ms @ 16kHz) frames.
   */
  async streamAudio(callId: string, pcm16kData: Buffer): Promise<void> {
    let seq = this.audioSequences.get(callId) ?? 0;

    for (const chunk of chunkAudio(pcm16kData, 640)) {
      await this.applyDelay();
      this.send({
        type: "audio_in",
        callId,
        seq,
        data: chunk.toString("base64"),
      });
      seq++;
    }

    this.audioSequences.set(callId, seq);
  }

  /**
   * Send a single audio frame.
   */
  async sendAudioFrame(callId: string, pcm16kFrame: Buffer): Promise<void> {
    const seq = this.audioSequences.get(callId) ?? 0;
    await this.applyDelay();
    this.send({
      type: "audio_in",
      callId,
      seq,
      data: pcm16kFrame.toString("base64"),
    });
    this.audioSequences.set(callId, seq + 1);
  }

  /**
   * Simulate call ending.
   */
  async simulateHangup(callId: string, reason: EndReason): Promise<void> {
    await this.applyDelay();
    this.send({
      type: "session_end",
      callId,
      reason,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Assertion helpers
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Assert that we received at least N audio_out frames for a call.
   */
  assertReceivedAudioOut(callId: string, minFrames: number): void {
    const frames = this.receivedMessages.filter(
      (m) => m.callId === callId && m.type === "audio_out",
    );
    if (frames.length < minFrames) {
      throw new Error(
        `Expected at least ${minFrames} audio_out frames for call ${callId}, got ${frames.length}`,
      );
    }
  }

  /**
   * Assert that we received a hangup message for a call.
   */
  assertReceivedHangup(callId: string): void {
    const hangup = this.receivedMessages.find(
      (m) => m.callId === callId && m.type === "hangup",
    );
    if (!hangup) {
      throw new Error(`Expected hangup message for call ${callId}`);
    }
  }

  /**
   * Assert that we received an initiate_call message for a call.
   */
  assertReceivedInitiateCall(callId: string): void {
    const initiate = this.receivedMessages.find(
      (m) => m.callId === callId && m.type === "initiate_call",
    );
    if (!initiate) {
      throw new Error(`Expected initiate_call message for call ${callId}`);
    }
  }

  /**
   * Get all received audio frames for a call.
   */
  getReceivedAudioFrames(callId: string): Buffer[] {
    return this.receivedMessages
      .filter((m) => m.callId === callId && m.type === "audio_out")
      .map((m) => Buffer.from((m.data as { data: string }).data, "base64"));
  }

  /**
   * Get all received messages for a call.
   */
  getReceivedMessagesForCall(callId: string): RecordedMessage[] {
    return this.receivedMessages.filter((m) => m.callId === callId);
  }

  /**
   * Get all sent messages for a call.
   */
  getSentMessagesForCall(callId: string): RecordedMessage[] {
    return this.sentMessages.filter((m) => m.callId === callId);
  }

  /**
   * Wait for a specific message type to be received.
   */
  async waitForMessage(
    callId: string,
    type: string,
    timeoutMs = 5000,
  ): Promise<RecordedMessage> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const msg = this.receivedMessages.find(
        (m) => m.callId === callId && m.type === type,
      );
      if (msg) return msg;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timeout waiting for ${type} message for call ${callId}`);
  }

  /**
   * Clear all recorded messages.
   */
  clearMessages(): void {
    this.receivedMessages = [];
    this.sentMessages = [];
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Internal helpers
  // ─────────────────────────────────────────────────────────────────────────────

  private send(message: InboundMessage): void {
    if (!this.isConnected()) {
      throw new Error("Not connected to bridge");
    }

    const json = JSON.stringify(message);
    this.ws!.send(json);

    this.sentMessages.push({
      callId: (message as { callId?: string }).callId ?? "",
      type: message.type,
      data: message,
      timestamp: Date.now(),
    });
  }

  private recordReceived(message: OutboundMessage): void {
    this.receivedMessages.push({
      callId: (message as { callId?: string }).callId ?? "",
      type: message.type,
      data: message,
      timestamp: Date.now(),
    });
  }

  private async applyDelay(): Promise<void> {
    if (this.config.responseDelay > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.config.responseDelay),
      );
    }
  }
}

/**
 * Create a mock bridge with default test configuration.
 */
export function createTestMockBridge(
  port: number,
  options?: Partial<MockBridgeConfig>,
): MockTeamsBridge {
  return new MockTeamsBridge({
    port,
    secret: "test-secret-12345678901234567890123456789012", // 32+ chars
    ...options,
  });
}
