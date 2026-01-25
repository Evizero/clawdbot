/**
 * Bridge Message Parsing and Serialization
 *
 * Handles JSON encoding/decoding for the WebSocket protocol
 * between Clawdbot and the C# media gateway.
 */

import type {
  InboundMessage,
  OutboundMessage,
  SessionStartMessage,
  CallStatusMessage,
  AudioInMessage,
  SessionEndMessage,
  SessionResumeMessage,
  PingMessage,
  PongMessage,
  InitiateCallMessage,
  AudioOutMessage,
  HangupMessage,
  AuthRequestMessage,
  AuthResponseMessage,
  CallDirection,
  CallStatus,
  EndReason,
  CallTarget,
  SessionMetadata,
} from "./types.js";

/**
 * Error thrown when message parsing fails.
 */
export class MessageParseError extends Error {
  constructor(
    message: string,
    public readonly rawMessage?: string,
  ) {
    super(message);
    this.name = "MessageParseError";
  }
}

/** Max message size in bytes (1MB) */
const MAX_MESSAGE_SIZE = 1024 * 1024;
/** Max audio frame size for base64 encoded 640 bytes (~1.5KB) */
const MAX_AUDIO_FRAME_SIZE = 2048;

/**
 * Parse an inbound message from the C# gateway.
 *
 * @param raw Raw JSON string from WebSocket
 * @returns Parsed message
 * @throws MessageParseError if parsing fails
 */
export function parseInboundMessage(raw: string): InboundMessage {
  // Check message size first to prevent memory exhaustion
  if (raw.length > MAX_MESSAGE_SIZE) {
    throw new MessageParseError("Message too large", undefined);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new MessageParseError("Invalid JSON", raw);
  }

  if (!json || typeof json !== "object") {
    throw new MessageParseError("Message must be an object", raw);
  }

  const msg = json as Record<string, unknown>;

  if (typeof msg.type !== "string") {
    throw new MessageParseError("Message missing 'type' field", raw);
  }

  switch (msg.type) {
    case "session_start":
      return parseSessionStart(msg, raw);
    case "call_status":
      return parseCallStatus(msg, raw);
    case "audio_in":
      return parseAudioIn(msg, raw);
    case "session_end":
      return parseSessionEnd(msg, raw);
    case "session_resume":
      return parseSessionResume(msg, raw);
    case "ping":
      return parsePing(msg, raw);
    case "auth_request":
      return parseAuthRequest(msg, raw);
    default:
      throw new MessageParseError(`Unknown message type: ${msg.type}`, raw);
  }
}

/**
 * Serialize an outbound message to JSON.
 *
 * @param message Message to serialize
 * @returns JSON string
 */
export function serializeOutboundMessage(message: OutboundMessage): string {
  return JSON.stringify(message);
}

// ─────────────────────────────────────────────────────────────────────────────
// Individual message parsers
// ─────────────────────────────────────────────────────────────────────────────

function parseSessionStart(
  msg: Record<string, unknown>,
  raw: string,
): SessionStartMessage {
  const callId = requireString(msg, "callId", raw);
  const direction = requireDirection(msg, raw);
  const metadata = requireMetadata(msg, raw);

  return {
    type: "session_start",
    callId,
    direction,
    metadata,
  };
}

function parseCallStatus(
  msg: Record<string, unknown>,
  raw: string,
): CallStatusMessage {
  const callId = requireString(msg, "callId", raw);
  const status = requireCallStatus(msg, raw);
  const error =
    typeof msg.error === "string" ? msg.error : undefined;

  return {
    type: "call_status",
    callId,
    status,
    error,
  };
}

function parseAudioIn(
  msg: Record<string, unknown>,
  raw: string,
): AudioInMessage {
  const callId = requireString(msg, "callId", raw);
  const seq = requireNumber(msg, "seq", raw);
  const data = requireString(msg, "data", raw);

  // Validate audio frame size
  if (data.length > MAX_AUDIO_FRAME_SIZE) {
    throw new MessageParseError("Audio frame too large", raw);
  }

  return {
    type: "audio_in",
    callId,
    seq,
    data,
  };
}

function parseSessionEnd(
  msg: Record<string, unknown>,
  raw: string,
): SessionEndMessage {
  const callId = requireString(msg, "callId", raw);
  const reason = requireEndReason(msg, raw);

  return {
    type: "session_end",
    callId,
    reason,
  };
}

function parseSessionResume(
  msg: Record<string, unknown>,
  raw: string,
): SessionResumeMessage {
  const callId = requireString(msg, "callId", raw);
  const lastReceivedSeq = requireNumber(msg, "lastReceivedSeq", raw);

  return {
    type: "session_resume",
    callId,
    lastReceivedSeq,
  };
}

function parsePing(
  msg: Record<string, unknown>,
  raw: string,
): PingMessage {
  const callId = requireString(msg, "callId", raw);
  return { type: "ping", callId };
}

function parseAuthRequest(
  msg: Record<string, unknown>,
  raw: string,
): AuthRequestMessage {
  const callId = requireString(msg, "callId", raw);
  const correlationId = requireString(msg, "correlationId", raw);
  const metadata = requireMetadata(msg, raw);
  return { type: "auth_request", callId, correlationId, metadata };
}

// ─────────────────────────────────────────────────────────────────────────────
// Field validators
// ─────────────────────────────────────────────────────────────────────────────

function requireString(
  msg: Record<string, unknown>,
  field: string,
  raw: string,
): string {
  const value = msg[field];
  if (typeof value !== "string") {
    throw new MessageParseError(`Missing or invalid '${field}' field`, raw);
  }
  return value;
}

function requireNumber(
  msg: Record<string, unknown>,
  field: string,
  raw: string,
): number {
  const value = msg[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new MessageParseError(`Missing or invalid '${field}' field`, raw);
  }
  return value;
}

const VALID_DIRECTIONS: CallDirection[] = ["inbound", "outbound"];

function requireDirection(
  msg: Record<string, unknown>,
  raw: string,
): CallDirection {
  const value = msg.direction;
  if (
    typeof value !== "string" ||
    !VALID_DIRECTIONS.includes(value as CallDirection)
  ) {
    throw new MessageParseError(
      `Invalid 'direction' field (expected: ${VALID_DIRECTIONS.join(", ")})`,
      raw,
    );
  }
  return value as CallDirection;
}

const VALID_CALL_STATUSES: CallStatus[] = [
  "ringing",
  "answered",
  "failed",
  "busy",
  "no-answer",
];

function requireCallStatus(
  msg: Record<string, unknown>,
  raw: string,
): CallStatus {
  const value = msg.status;
  if (
    typeof value !== "string" ||
    !VALID_CALL_STATUSES.includes(value as CallStatus)
  ) {
    throw new MessageParseError(
      `Invalid 'status' field (expected: ${VALID_CALL_STATUSES.join(", ")})`,
      raw,
    );
  }
  return value as CallStatus;
}

const VALID_END_REASONS: EndReason[] = [
  "hangup-user",
  "hangup-bot",
  "error",
  "timeout",
];

function requireEndReason(
  msg: Record<string, unknown>,
  raw: string,
): EndReason {
  const value = msg.reason;
  if (
    typeof value !== "string" ||
    !VALID_END_REASONS.includes(value as EndReason)
  ) {
    throw new MessageParseError(
      `Invalid 'reason' field (expected: ${VALID_END_REASONS.join(", ")})`,
      raw,
    );
  }
  return value as EndReason;
}

function requireMetadata(
  msg: Record<string, unknown>,
  raw: string,
): SessionMetadata {
  const metadata = msg.metadata;
  if (!metadata || typeof metadata !== "object") {
    throw new MessageParseError("Missing or invalid 'metadata' field", raw);
  }

  const m = metadata as Record<string, unknown>;

  return {
    tenantId: requireString(m, "tenantId", raw),
    userId: requireString(m, "userId", raw),
    teamsCallId: requireString(m, "teamsCallId", raw),
    displayName:
      typeof m.displayName === "string" ? m.displayName : undefined,
    userPrincipalName:
      typeof m.userPrincipalName === "string"
        ? m.userPrincipalName
        : undefined,
    phoneNumber:
      typeof m.phoneNumber === "string" ? m.phoneNumber : undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Message builders (for convenience)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build an initiate_call message.
 */
export function buildInitiateCall(
  callId: string,
  target: CallTarget,
  message?: string,
): InitiateCallMessage {
  return {
    type: "initiate_call",
    callId,
    target,
    message,
  };
}

/**
 * Build an audio_out message.
 */
export function buildAudioOut(
  callId: string,
  seq: number,
  pcm16kData: Buffer,
): AudioOutMessage {
  return {
    type: "audio_out",
    callId,
    seq,
    data: pcm16kData.toString("base64"),
  };
}

/**
 * Build a hangup message.
 */
export function buildHangup(callId: string): HangupMessage {
  return {
    type: "hangup",
    callId,
  };
}

/**
 * Build a pong message (response to ping).
 */
export function buildPong(callId: string): PongMessage {
  return {
    type: "pong",
    callId,
  };
}

/**
 * Decode base64 audio data from an audio_in message.
 */
export function decodeAudioData(message: AudioInMessage): Buffer {
  return Buffer.from(message.data, "base64");
}

/**
 * Validate that audio data has expected size for Teams 20ms frame.
 * Teams sends 640 bytes per frame (16kHz × 20ms × 2 bytes).
 */
export function validateTeamsAudioFrame(data: Buffer): boolean {
  return data.length === 640;
}

/**
 * Validate callId format for security.
 * Only allows alphanumeric characters, hyphens, and underscores.
 * Max length 128 characters to prevent memory issues.
 */
const CALL_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;

export function validateCallId(callId: string): boolean {
  return CALL_ID_REGEX.test(callId);
}

/**
 * Build an auth_response message.
 */
export function buildAuthResponse(
  callId: string,
  correlationId: string,
  authorized: boolean,
  reason?: string,
  strategy?: string,
): AuthResponseMessage {
  return {
    type: "auth_response",
    callId,
    correlationId,
    authorized,
    reason,
    strategy,
    timestamp: Date.now(),
  };
}
