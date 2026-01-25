/**
 * MS Teams Voice Call Plugin Types
 *
 * Type definitions for the WebSocket bridge protocol between
 * Clawdbot and the C# media gateway.
 */

/**
 * Call metadata from Teams.
 */
export interface SessionMetadata {
  tenantId: string;
  userId: string;
  teamsCallId: string;
  displayName?: string;
  userPrincipalName?: string;
  phoneNumber?: string;
}

/**
 * Call direction.
 */
export type CallDirection = "inbound" | "outbound";

/**
 * Outbound call status.
 */
export type CallStatus =
  | "ringing"
  | "answered"
  | "failed"
  | "busy"
  | "no-answer";

/**
 * Session end reasons.
 */
export type EndReason = "hangup-user" | "hangup-bot" | "error" | "timeout";

/**
 * Outbound call target.
 */
export type CallTarget =
  | { type: "user"; userId: string }
  | { type: "phone"; number: string };

// ─────────────────────────────────────────────────────────────────────────────
// Messages from C# Gateway → Clawdbot
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Session start message (inbound or outbound call connected).
 */
export interface SessionStartMessage {
  type: "session_start";
  callId: string;
  direction: CallDirection;
  metadata: SessionMetadata;
}

/**
 * Call status message (for outbound calls).
 */
export interface CallStatusMessage {
  type: "call_status";
  callId: string;
  status: CallStatus;
  error?: string;
}

/**
 * Audio frame from Teams (16kHz PCM, 640 bytes per 20ms frame).
 */
export interface AudioInMessage {
  type: "audio_in";
  callId: string;
  seq: number;
  /** Base64-encoded 16kHz PCM audio (640 bytes = 20ms) */
  data: string;
}

/**
 * Session end message.
 */
export interface SessionEndMessage {
  type: "session_end";
  callId: string;
  reason: EndReason;
}

/**
 * Session resume message (after reconnection).
 */
export interface SessionResumeMessage {
  type: "session_resume";
  callId: string;
  lastReceivedSeq: number;
}

/**
 * Ping message for connection keep-alive.
 */
export interface PingMessage {
  type: "ping";
  callId: string;
}

/**
 * Authorization request from gateway for call authorization.
 */
export interface AuthRequestMessage {
  type: "auth_request";
  callId: string;
  correlationId: string;
  metadata: SessionMetadata;
}

/**
 * All inbound message types (C# → Clawdbot).
 */
export type InboundMessage =
  | SessionStartMessage
  | CallStatusMessage
  | AudioInMessage
  | SessionEndMessage
  | SessionResumeMessage
  | PingMessage
  | AuthRequestMessage;

// ─────────────────────────────────────────────────────────────────────────────
// Messages from Clawdbot → C# Gateway
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initiate outbound call message.
 */
export interface InitiateCallMessage {
  type: "initiate_call";
  callId: string;
  target: CallTarget;
  /** Optional initial TTS message to play when call connects */
  message?: string;
}

/**
 * Audio frame to Teams (16kHz PCM, 640 bytes per 20ms frame).
 */
export interface AudioOutMessage {
  type: "audio_out";
  callId: string;
  seq: number;
  /** Base64-encoded 16kHz PCM audio (640 bytes = 20ms) */
  data: string;
}

/**
 * Hangup message.
 */
export interface HangupMessage {
  type: "hangup";
  callId: string;
}

/**
 * Pong response to ping.
 */
export interface PongMessage {
  type: "pong";
  callId: string;
}

/**
 * Authorization response sent to gateway.
 */
export interface AuthResponseMessage {
  type: "auth_response";
  callId: string;
  correlationId: string;
  authorized: boolean;
  reason?: string;
  strategy?: string;
  timestamp: number;
}

/**
 * Result of authorization check.
 */
export interface AuthResult {
  authorized: boolean;
  reason?: string;
  strategy: string;
}

/**
 * All outbound message types (Clawdbot → C#).
 */
export type OutboundMessage =
  | InitiateCallMessage
  | AudioOutMessage
  | HangupMessage
  | PongMessage
  | AuthResponseMessage;

/**
 * All bridge message types.
 */
export type BridgeMessage = InboundMessage | OutboundMessage;

// ─────────────────────────────────────────────────────────────────────────────
// Call Session State
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Active call session.
 */
export interface CallSession {
  callId: string;
  direction: CallDirection;
  metadata: SessionMetadata;
  startedAt: number;
  answeredAt?: number;
  audioFramesReceived: number;
  audioFramesSent: number;
  lastAudioSeqReceived: number;
  lastAudioSeqSent: number;
}

/**
 * Call state events for external listeners.
 */
export type CallEvent =
  | { type: "callStarted"; callId: string; direction: CallDirection; metadata: SessionMetadata }
  | { type: "transcript"; callId: string; text: string; isFinal: boolean }
  | { type: "response"; callId: string; text: string }
  | { type: "callEnded"; callId: string; reason: EndReason };
