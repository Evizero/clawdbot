/**
 * Teams Audio Bridge
 *
 * WebSocket server that handles connections from the C# media gateway.
 * Manages call sessions and bridges audio between Teams and OpenAI STT/TTS.
 */

import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { IncomingMessage } from "http";
import { EventEmitter } from "events";
import { timingSafeEqual } from "crypto";
import type {
  CallSession,
  InboundMessage,
  OutboundMessage,
  SessionMetadata,
  CallTarget,
  EndReason,
  SessionResumeMessage,
  PingMessage,
  AuthRequestMessage,
  AuthResult,
} from "./types.js";
import {
  parseInboundMessage,
  serializeOutboundMessage,
  buildAudioOut,
  buildHangup,
  buildInitiateCall,
  buildPong,
  buildAuthResponse,
  decodeAudioData,
  MessageParseError,
  validateTeamsAudioFrame,
  validateCallId,
} from "./bridge-messages.js";
import {
  resample16kTo24k,
  resample24kTo16k,
  chunkAudio,
} from "./audio-utils.js";
import type { TeamsCallConfig } from "./config.js";

/**
 * Logger interface for injected logging.
 */
export interface Logger {
  debug: (msg: string, ...args: unknown[]) => void;
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
}

/**
 * Bridge configuration.
 */
export interface BridgeConfig {
  /** Port to listen on */
  port: number;
  /** Bind address (default: 127.0.0.1) */
  bind?: string;
  /** WebSocket path (default: /teams-call/stream) */
  path?: string;
  /** Shared secret for authentication (min 32 chars recommended) */
  secret: string;
  /** Optional logger for structured logging */
  logger?: Logger;
  /** Full plugin config for authorization */
  fullConfig?: TeamsCallConfig;
}

/**
 * Rate limiting tracker for connection attempts.
 */
interface RateLimitEntry {
  count: number;
  resetAt: number;
}

/** Max connection attempts per minute per IP */
const MAX_ATTEMPTS_PER_MINUTE = 10;
/** Max message size in bytes (1MB) */
const MAX_MESSAGE_SIZE = 1024 * 1024;

/**
 * Pending outbound call.
 */
interface PendingCall {
  callId: string;
  target: CallTarget;
  message?: string;
  resolve: (result: { status: "answered"; callId: string }) => void;
  reject: (error: Error) => void;
  timeoutId: NodeJS.Timeout;
}

/**
 * TTS provider interface (injected).
 */
export interface TTSProvider {
  synthesize(text: string): Promise<Buffer>;
}

/**
 * STT session interface (injected).
 */
export interface STTSession {
  connect(): Promise<void>;
  sendAudio(audio: Buffer): void;
  onTranscript(callback: (transcript: string) => void): void;
  onPartial(callback: (partial: string) => void): void;
  close(): void;
  isConnected(): boolean;
}

/**
 * STT provider factory interface.
 */
export interface STTProvider {
  createSession(): STTSession;
}

/**
 * Teams Audio Bridge - WebSocket server for C# gateway connections.
 */
export class TeamsAudioBridge extends EventEmitter {
  private wss: WebSocketServer | null = null;
  private config: Required<Omit<BridgeConfig, "logger" | "fullConfig">> & { logger?: Logger };
  private fullConfig?: TeamsCallConfig;
  private sessions: Map<string, BridgeSession> = new Map();
  private pendingCalls: Map<string, PendingCall> = new Map();
  private connections: Map<string, WebSocket> = new Map(); // Track gateway connections
  private ttsProvider: TTSProvider | null = null;
  private sttProvider: STTProvider | null = null;
  private logger?: Logger;

  // Rate limiting state
  private connectionAttempts: Map<string, RateLimitEntry> = new Map();

  // Ping interval for health monitoring
  private pingInterval?: NodeJS.Timeout;

  // Callbacks for testing/hooks
  private sttInputCallback: ((callId: string, audio: Buffer) => void) | null = null;
  private mockTTS: ((text: string) => Promise<Buffer>) | null = null;

  constructor(config: BridgeConfig) {
    super();
    this.config = {
      port: config.port,
      bind: config.bind ?? "127.0.0.1",
      path: config.path ?? "/teams-call/stream",
      secret: config.secret,
    };
    this.fullConfig = config.fullConfig;
    this.logger = config.logger;
  }

  /**
   * Set the TTS provider.
   */
  setTTSProvider(provider: TTSProvider): void {
    this.ttsProvider = provider;
  }

  /**
   * Set the STT provider.
   */
  setSTTProvider(provider: STTProvider): void {
    this.sttProvider = provider;
  }

  /**
   * Set a mock TTS function for testing.
   * WARNING: This is for testing only - do not use in production.
   */
  setMockTTS(fn: (text: string) => Promise<Buffer>): void {
    this.logger?.warn("[TeamsAudioBridge] Mock TTS enabled - for testing only!");
    this.mockTTS = fn;
  }

  /**
   * Set callback for STT input (for testing).
   */
  onSTTInput(callback: (callId: string, audio: Buffer) => void): void {
    this.sttInputCallback = callback;
  }

  /**
   * Start the WebSocket server.
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({
        port: this.config.port,
        host: this.config.bind,
        path: this.config.path,
        verifyClient: (info, callback) => {
          const ip = info.req.socket.remoteAddress ?? "unknown";

          // Rate limiting check
          const now = Date.now();
          const attempts = this.connectionAttempts.get(ip);

          if (attempts && now < attempts.resetAt && attempts.count >= MAX_ATTEMPTS_PER_MINUTE) {
            this.logger?.warn(`[TeamsAudioBridge] Rate limit exceeded for IP: ${ip}`);
            callback(false, 429, "Too Many Requests");
            return;
          }

          // Update rate limit counter
          if (!attempts || now >= attempts.resetAt) {
            this.connectionAttempts.set(ip, { count: 1, resetAt: now + 60000 });
          } else {
            attempts.count++;
          }

          // Timing-safe secret comparison
          const secret = info.req.headers["x-bridge-secret"];
          if (typeof secret !== "string" ||
              secret.length !== this.config.secret.length ||
              !timingSafeEqual(Buffer.from(secret), Buffer.from(this.config.secret))) {
            this.logger?.warn(`[TeamsAudioBridge] Unauthorized connection attempt from IP: ${ip}`);
            callback(false, 4001, "Unauthorized");
            return;
          }

          callback(true);
        },
      });

      this.wss.on("connection", (ws, req) => {
        this.handleConnection(ws, req);
      });

      this.wss.on("listening", () => {
        // Start ping interval for health monitoring
        this.pingInterval = setInterval(() => {
          this.wss?.clients.forEach((ws) => {
            const extWs = ws as WebSocket & { isAlive?: boolean };
            if (extWs.isAlive === false) {
              this.logger?.warn("[TeamsAudioBridge] Terminating unresponsive WebSocket");
              ws.terminate();
              return;
            }
            extWs.isAlive = false;
            ws.ping();
          });
        }, 30000); // Ping every 30 seconds

        resolve();
      });

      this.wss.on("error", (error) => {
        reject(error);
      });
    });
  }

  /**
   * Stop the WebSocket server.
   */
  async stop(): Promise<void> {
    // Stop ping interval
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = undefined;
    }

    // Close all sessions
    for (const session of this.sessions.values()) {
      session.close();
    }
    this.sessions.clear();

    // Reject pending calls
    for (const pending of this.pendingCalls.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error("Bridge stopped"));
    }
    this.pendingCalls.clear();

    // Clear connections
    this.connections.clear();

    // Clear rate limiting state
    this.connectionAttempts.clear();

    // Close server
    if (this.wss) {
      return new Promise((resolve) => {
        this.wss!.close(() => {
          this.wss = null;
          resolve();
        });
      });
    }
  }

  /**
   * Get a call session by ID.
   */
  getSession(callId: string): CallSession | undefined {
    const session = this.sessions.get(callId);
    if (!session) return undefined;

    return {
      callId: session.callId,
      direction: session.direction,
      metadata: session.metadata,
      startedAt: session.startedAt,
      answeredAt: session.answeredAt,
      audioFramesReceived: session.audioFramesReceived,
      audioFramesSent: session.audioFramesSent,
      lastAudioSeqReceived: session.lastAudioSeqReceived,
      lastAudioSeqSent: session.lastAudioSeqSent,
    };
  }

  /**
   * Get count of active calls.
   */
  getActiveCallCount(): number {
    return this.sessions.size;
  }

  /**
   * Initiate an outbound call.
   */
  async initiateCall(params: {
    callId: string;
    target: CallTarget;
    message?: string;
    timeoutMs?: number;
  }): Promise<{ status: "answered"; callId: string }> {
    const { callId, target, message, timeoutMs = 30000 } = params;

    // Find an active gateway connection to send the message
    const gatewayWs = this.findGatewayConnection();
    if (!gatewayWs) {
      throw new Error("Gateway not connected - cannot initiate outbound call");
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingCalls.delete(callId);
        reject(new Error("Call timeout - no response from gateway"));
      }, timeoutMs);

      this.pendingCalls.set(callId, {
        callId,
        target,
        message,
        resolve,
        reject,
        timeoutId,
      });

      // Build and send initiate_call message to gateway
      const initiateMsg = buildInitiateCall(callId, target, message);
      gatewayWs.send(serializeOutboundMessage(initiateMsg));
      this.logger?.info(`[TeamsAudioBridge] Sent initiate_call for ${callId}`);
    });
  }

  /**
   * Find an active gateway connection for outbound calls.
   */
  private findGatewayConnection(): WebSocket | undefined {
    for (const [, ws] of this.connections) {
      if (ws.readyState === WebSocket.OPEN) {
        return ws;
      }
    }
    return undefined;
  }

  /**
   * End a call.
   */
  async endCall(callId: string): Promise<void> {
    const session = this.sessions.get(callId);
    if (!session) return;

    // Send hangup message
    const msg = buildHangup(callId);
    session.send(msg);

    // Close session
    session.close();
    this.sessions.delete(callId);

    this.emit("callEnded", { callId, reason: "hangup-bot" });
  }

  /**
   * Speak text on a call using TTS.
   */
  async speak(callId: string, text: string): Promise<void> {
    const session = this.sessions.get(callId);
    if (!session) {
      throw new Error(`No session found for call ${callId}`);
    }

    // Generate TTS audio with error handling
    let pcm24k: Buffer;
    try {
      if (this.mockTTS) {
        pcm24k = await this.mockTTS(text);
      } else if (this.ttsProvider) {
        pcm24k = await this.ttsProvider.synthesize(text);
      } else {
        throw new Error("No TTS provider configured");
      }
    } catch (ttsErr) {
      this.logger?.error("[TeamsAudioBridge] TTS synthesis failed:", ttsErr);
      // Generate comfort tone (1 second of silence) instead of crashing
      pcm24k = this.generateComfortTone(1000);
    }

    // Resample 24kHz → 16kHz for Teams
    const pcm16k = resample24kTo16k(pcm24k);

    // Send in 20ms frames (640 bytes @ 16kHz)
    // Pad undersized frames to prevent audio glitches at end of TTS
    for (const chunk of chunkAudio(pcm16k, 640)) {
      const frame = this.padFrameToSize(chunk, 640);

      if (frame.length !== 640) {
        this.logger?.warn(`[TeamsAudioBridge] Invalid frame size: ${frame.length}`);
        continue;
      }

      const msg = buildAudioOut(callId, session.lastAudioSeqSent++, frame);
      session.send(msg);
      session.audioFramesSent++;
    }
  }

  /**
   * Generate a comfort tone (silence) for fallback when TTS fails.
   * @param durationMs Duration in milliseconds
   * @returns 24kHz PCM buffer of silence
   */
  private generateComfortTone(durationMs: number): Buffer {
    // 24kHz sample rate, 16-bit (2 bytes per sample)
    const sampleRate = 24000;
    const bytesPerSample = 2;
    const samples = Math.floor((durationMs / 1000) * sampleRate);
    const bufferSize = samples * bytesPerSample;

    // Return buffer filled with zeros (silence)
    return Buffer.alloc(bufferSize);
  }

  /**
   * Pad audio frame to target size with silence.
   * Used to ensure final TTS frames are full 20ms frames.
   * @param frame Audio frame buffer
   * @param targetSize Target frame size in bytes (default 640 for 20ms @ 16kHz)
   * @returns Padded buffer
   */
  private padFrameToSize(frame: Buffer, targetSize = 640): Buffer {
    if (frame.length >= targetSize) {
      return frame;
    }
    const padded = Buffer.alloc(targetSize);
    frame.copy(padded, 0);
    return padded;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Internal methods
  // ─────────────────────────────────────────────────────────────────────────────

  private handleConnection(ws: WebSocket, _req: IncomingMessage): void {
    // Generate a connection ID for tracking
    const connectionId = `conn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.connections.set(connectionId, ws);
    this.logger?.info(`[TeamsAudioBridge] Gateway connected: ${connectionId}`);

    // Set up ping/pong for health monitoring
    const extWs = ws as WebSocket & { isAlive?: boolean; connectionId?: string };
    extWs.isAlive = true;
    extWs.connectionId = connectionId;
    ws.on("pong", () => {
      extWs.isAlive = true;
    });

    // Create temporary handler for this connection
    // (session is created when we receive session_start)
    ws.on("message", (data: RawData) => {
      try {
        const raw = data.toString();

        // Message size check (redundant with parseInboundMessage but fails fast)
        if (raw.length > MAX_MESSAGE_SIZE) {
          this.logger?.warn("[TeamsAudioBridge] Dropping oversized message");
          return;
        }

        const msg = parseInboundMessage(raw);
        this.handleMessage(ws, msg);
      } catch (e) {
        if (e instanceof MessageParseError) {
          this.logger?.warn("[TeamsAudioBridge] Parse error:", e.message);
        } else {
          this.logger?.error("[TeamsAudioBridge] Error handling message:", e);
        }
      }
    });

    ws.on("close", () => {
      // Remove from connections tracking
      this.connections.delete(connectionId);
      this.logger?.info(`[TeamsAudioBridge] Gateway disconnected: ${connectionId}`);

      // Find and clean up session associated with this ws
      for (const [callId, session] of this.sessions.entries()) {
        if (session.ws === ws) {
          session.close();
          this.sessions.delete(callId);
          this.emit("callEnded", { callId, reason: "error" });
          break;
        }
      }
    });

    ws.on("error", (error) => {
      this.logger?.error("[TeamsAudioBridge] WebSocket error:", error);
    });
  }

  private handleMessage(ws: WebSocket, msg: InboundMessage): void {
    // Validate callId format for all messages
    if (!validateCallId(msg.callId)) {
      this.logger?.warn(`[TeamsAudioBridge] Invalid callId format: ${msg.callId}`);
      return;
    }

    switch (msg.type) {
      case "session_start":
        this.handleSessionStart(ws, msg.callId, msg.direction, msg.metadata);
        break;
      case "call_status":
        this.handleCallStatus(msg.callId, msg.status, msg.error);
        break;
      case "audio_in":
        this.handleAudioIn(ws, msg.callId, msg.seq, decodeAudioData(msg));
        break;
      case "session_end":
        this.handleSessionEnd(msg.callId, msg.reason);
        break;
      case "session_resume":
        this.handleSessionResume(msg as SessionResumeMessage, ws);
        break;
      case "ping":
        this.handlePing(ws, msg as PingMessage);
        break;
      case "auth_request":
        this.handleAuthRequest(ws, msg as AuthRequestMessage);
        break;
    }
  }

  private handlePing(ws: WebSocket, msg: PingMessage): void {
    const pong = buildPong(msg.callId);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(serializeOutboundMessage(pong));
      this.logger?.debug(`[TeamsAudioBridge] Sent pong for ${msg.callId}`);
    }
  }

  private async handleSessionStart(
    ws: WebSocket,
    callId: string,
    direction: "inbound" | "outbound",
    metadata: SessionMetadata,
  ): Promise<void> {
    // Create session
    const session = new BridgeSession(ws, callId, direction, metadata, this.logger);

    // Set up STT if provider available - must connect before storing session
    if (this.sttProvider) {
      const sttSession = this.sttProvider.createSession();
      session.sttSession = sttSession;

      try {
        await sttSession.connect();
        // Setup handlers after successful connection
        sttSession.onTranscript((transcript) => {
          this.emit("transcript", { callId, text: transcript, isFinal: true });
        });
        sttSession.onPartial((partial) => {
          this.emit("transcript", { callId, text: partial, isFinal: false });
        });
      } catch (err) {
        this.logger?.error("[TeamsAudioBridge] STT connect error:", err);

        // CRITICAL: Close orphaned STT session to prevent leak
        try {
          sttSession.close();
        } catch (closeErr) {
          this.logger?.warn("[TeamsAudioBridge] Error closing STT session:", closeErr);
        }

        this.emit("callError", { callId, error: "STT connection failed" });
        // Reject pending outbound call if applicable
        const pending = this.pendingCalls.get(callId);
        if (pending) {
          clearTimeout(pending.timeoutId);
          this.pendingCalls.delete(callId);
          pending.reject(new Error("STT connection failed"));
        }
        return; // Don't store session - call cannot proceed without STT
      }
    }

    // Only store session after STT connected successfully
    this.sessions.set(callId, session);

    // Check if this is for a pending outbound call
    const pending = this.pendingCalls.get(callId);
    if (pending && direction === "outbound") {
      clearTimeout(pending.timeoutId);
      this.pendingCalls.delete(callId);
      pending.resolve({ status: "answered", callId });
    }

    // Emit event
    this.emit("callStarted", { callId, direction, metadata });
  }

  private handleCallStatus(
    callId: string,
    status: string,
    error?: string,
  ): void {
    const pending = this.pendingCalls.get(callId);
    if (!pending) return;

    if (status === "answered") {
      // Session start will complete the call
      return;
    }

    if (status === "failed" || status === "busy" || status === "no-answer") {
      clearTimeout(pending.timeoutId);
      this.pendingCalls.delete(callId);
      pending.reject(new Error(error || `Call ${status}`));
    } else {
      this.logger?.warn(`[TeamsAudioBridge] Unknown call status: ${status} for call ${callId}`);
    }
  }

  private handleAudioIn(ws: WebSocket, callId: string, seq: number, pcm16k: Buffer): void {
    const session = this.sessions.get(callId);
    if (!session) {
      this.logger?.warn(`[TeamsAudioBridge] Audio for unknown call: ${callId}`);
      return;
    }

    // Security: Verify the WebSocket connection matches the session owner
    if (session.ws !== ws) {
      this.logger?.error(`[TeamsAudioBridge] Audio from wrong connection for call: ${callId}`);
      return;
    }

    // Validate audio frame size
    if (!validateTeamsAudioFrame(pcm16k)) {
      this.logger?.warn(`[TeamsAudioBridge] Invalid audio frame size for call ${callId}: ${pcm16k.length} bytes`);
      return;
    }

    session.audioFramesReceived++;
    session.lastAudioSeqReceived = seq;

    // Resample 16kHz → 24kHz for OpenAI
    const pcm24k = resample16kTo24k(pcm16k);

    // Send to STT
    if (session.sttSession?.isConnected()) {
      session.sttSession.sendAudio(pcm24k);
    }

    // Callback for testing
    if (this.sttInputCallback) {
      this.sttInputCallback(callId, pcm24k);
    }
  }

  private handleSessionEnd(callId: string, reason: EndReason): void {
    const session = this.sessions.get(callId);
    if (!session) return;

    session.close();
    this.sessions.delete(callId);

    this.emit("callEnded", { callId, reason });
  }

  private handleSessionResume(msg: SessionResumeMessage, ws: WebSocket): void {
    const session = this.sessions.get(msg.callId);
    if (!session) {
      this.logger?.warn(`[TeamsAudioBridge] session_resume for unknown call: ${msg.callId}`);
      return;
    }

    // Update WebSocket reference for the session
    session.ws = ws;
    this.logger?.info(
      `[TeamsAudioBridge] Session resumed for call ${msg.callId}, lastSeq=${msg.lastReceivedSeq}`
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Authorization
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Pure config-driven authorization (no custom handlers - matches clawdbot philosophy)
   */
  private authorizeCall(metadata: SessionMetadata): AuthResult {
    const authConfig = this.fullConfig?.authorization ?? {
      mode: "disabled" as const,
      allowFrom: [],
      allowedTenants: [],
      allowPstn: false,
    };
    const { mode, allowFrom, allowedTenants, allowPstn } = authConfig;

    // CRITICAL: Validate metadata exists
    if (!metadata || !metadata.tenantId || !metadata.userId) {
      this.logger?.warn("[msteams-call] Invalid metadata - rejecting");
      return { authorized: false, reason: "Invalid metadata", strategy: "validation-failed" };
    }

    // PSTN check (applies to all modes except disabled)
    if (mode !== "disabled" && metadata.phoneNumber && !allowPstn) {
      this.logger?.info(`[msteams-call] PSTN call rejected: ${metadata.phoneNumber}`);
      return { authorized: false, reason: "PSTN calls not allowed", strategy: "pstn-blocked" };
    }

    switch (mode) {
      case "disabled":
        this.logger?.info("[msteams-call] Inbound call rejected: policy is disabled");
        return { authorized: false, reason: "Inbound calls disabled", strategy: "disabled" };

      case "open":
        this.logger?.info("[msteams-call] Call accepted: policy is open");
        return { authorized: true, strategy: "open" };

      case "tenant-only":
        // CRITICAL: Empty list = reject all (fail-closed)
        if (allowedTenants.length === 0) {
          this.logger?.warn("[msteams-call] No tenants configured - rejecting");
          return { authorized: false, reason: "No tenants configured", strategy: "tenant-only" };
        }
        if (allowedTenants.includes(metadata.tenantId)) {
          this.logger?.info(`[msteams-call] Tenant ${metadata.tenantId} accepted`);
          return { authorized: true, strategy: "tenant-only" };
        }
        this.logger?.info(`[msteams-call] Tenant ${metadata.tenantId} rejected`);
        return { authorized: false, reason: "Tenant not allowed", strategy: "tenant-only" };

      case "allowlist":
      default:
        // CRITICAL: Empty list = reject all (fail-closed)
        if (allowFrom.length === 0) {
          this.logger?.warn("[msteams-call] No users in allowlist - rejecting");
          return { authorized: false, reason: "No users configured", strategy: "allowlist" };
        }

        const userId = metadata.userId?.toLowerCase();
        const upn = metadata.userPrincipalName?.toLowerCase();
        const identifier = upn || userId || "unknown";

        const allowed = allowFrom.some((entry) => {
          const normalized = entry.toLowerCase();
          return normalized === userId || normalized === upn;
        });

        this.logger?.info(`[msteams-call] User ${identifier} ${allowed ? "accepted" : "rejected"}`);
        return allowed
          ? { authorized: true, strategy: "allowlist" }
          : { authorized: false, reason: "User not in allowlist", strategy: "allowlist" };
    }
  }

  /**
   * Handle auth request from gateway.
   */
  private handleAuthRequest(ws: WebSocket, msg: AuthRequestMessage): void {
    const { callId, correlationId, metadata } = msg;

    try {
      const result = this.authorizeCall(metadata);

      const response = buildAuthResponse(
        callId,
        correlationId,
        result.authorized,
        result.reason,
        result.strategy
      );

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(serializeOutboundMessage(response));
      }

      this.logger?.info(
        `[msteams-call][AUDIT] Auth ${result.authorized ? "granted" : "denied"} - ` +
        `CallId: ${callId}, Strategy: ${result.strategy}, Reason: ${result.reason || "N/A"}`
      );
    } catch (err) {
      this.logger?.error("[msteams-call] Auth request error:", err);

      const response = buildAuthResponse(callId, correlationId, false, "Authorization error");
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(serializeOutboundMessage(response));
      }
    }
  }
}

/**
 * Internal bridge session state.
 */
class BridgeSession {
  public ws: WebSocket;
  public callId: string;
  public direction: "inbound" | "outbound";
  public metadata: SessionMetadata;
  public startedAt: number;
  public answeredAt?: number;
  public audioFramesReceived = 0;
  public audioFramesSent = 0;
  public lastAudioSeqReceived = 0;
  public lastAudioSeqSent = 0;
  public sttSession: STTSession | null = null;
  private logger?: Logger;

  constructor(
    ws: WebSocket,
    callId: string,
    direction: "inbound" | "outbound",
    metadata: SessionMetadata,
    logger?: Logger,
  ) {
    this.ws = ws;
    this.callId = callId;
    this.direction = direction;
    this.metadata = metadata;
    this.startedAt = Date.now();
    this.answeredAt = Date.now(); // Session starts when answered
    this.logger = logger;
  }

  send(msg: OutboundMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(serializeOutboundMessage(msg));
    } else {
      this.logger?.warn(
        `[BridgeSession] Dropping ${msg.type} message, WebSocket state: ${this.ws.readyState}`
      );
    }
  }

  close(): void {
    // Close STT session first
    if (this.sttSession) {
      this.sttSession.close();
      this.sttSession = null;
    }

    // Note: We don't close the WebSocket here.
    // The C# gateway manages its own WebSocket lifecycle.
    // The hangup message has already been sent, so the gateway
    // can close its connection when it's ready.
    // This also allows the gateway to multiplex multiple calls
    // over a single connection if desired.
  }
}
