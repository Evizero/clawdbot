/**
 * Conversation Session Manager
 *
 * Manages per-call conversation sessions with transcript history.
 * Session keys are based on caller identity for multi-turn context.
 */

import crypto from "node:crypto";
import type { Logger } from "./bridge.js";
import type { CoreConfig } from "./core-bridge.js";

/**
 * Transcript entry in a conversation session.
 */
export interface TranscriptEntry {
  /** Speaker identifier */
  speaker: "user" | "bot";
  /** Message text */
  text: string;
  /** Timestamp when message was recorded */
  timestamp: number;
}

/**
 * Conversation session state.
 */
export interface ConversationSession {
  /** Unique session ID */
  sessionId: string;
  /** Session key for persistence (derived from user identity) */
  sessionKey: string;
  /** Transcript history */
  transcript: TranscriptEntry[];
  /** Associated call ID */
  callId: string;
  /** User identifier (from Teams metadata) */
  userId: string;
  /** Session creation timestamp */
  createdAt: number;
  /** Last activity timestamp */
  lastActivityAt: number;
}

/**
 * Options for creating a ConversationSessionManager.
 */
export interface ConversationSessionManagerOptions {
  /** Core Clawdbot config */
  coreConfig: CoreConfig;
  /** Path to session store */
  storePath: string;
  /** Logger for debug output */
  logger?: Logger;
  /**
   * Maximum transcript entries to keep per session.
   * Default: 50 entries
   */
  maxTranscriptEntries?: number;
  /**
   * Session expiry time in milliseconds.
   * Default: 30 minutes (1800000ms)
   */
  sessionExpiryMs?: number;
}

/**
 * Manages conversation sessions for voice calls.
 *
 * Features:
 * - Per-call session tracking
 * - Transcript history for multi-turn context
 * - Session expiry for memory management
 * - User identity-based session keys
 */
export class ConversationSessionManager {
  private sessions = new Map<string, ConversationSession>();
  private coreConfig: CoreConfig;
  private storePath: string;
  private logger?: Logger;
  private readonly maxTranscriptEntries: number;
  private readonly sessionExpiryMs: number;

  constructor(options: ConversationSessionManagerOptions) {
    this.coreConfig = options.coreConfig;
    this.storePath = options.storePath;
    this.logger = options.logger;
    this.maxTranscriptEntries = options.maxTranscriptEntries ?? 50;
    this.sessionExpiryMs = options.sessionExpiryMs ?? 30 * 60 * 1000; // 30 minutes
  }

  /**
   * Get or create session for a call.
   *
   * @param callId - Unique call identifier
   * @param userId - User identifier for session key
   * @returns Conversation session
   */
  getSession(callId: string, userId: string): ConversationSession {
    let session = this.sessions.get(callId);

    if (session) {
      // Check if session expired
      const now = Date.now();
      if (now - session.lastActivityAt > this.sessionExpiryMs) {
        this.logger?.debug(
          `[Sessions] Session for call ${callId} expired, creating new session`
        );
        this.sessions.delete(callId);
        session = undefined;
      } else {
        session.lastActivityAt = now;
        return session;
      }
    }

    // Create new session
    const normalizedId = this.normalizeUserId(userId);
    const sessionKey = `msteams-call:${normalizedId}`;
    const sessionId = crypto.randomUUID();
    const now = Date.now();

    session = {
      sessionId,
      sessionKey,
      transcript: [],
      callId,
      userId,
      createdAt: now,
      lastActivityAt: now,
    };

    this.sessions.set(callId, session);
    this.logger?.debug(
      `[Sessions] Created session for call ${callId}, sessionId=${sessionId}`
    );

    return session;
  }

  /**
   * Add transcript entry (user or bot message).
   *
   * @param callId - Call identifier
   * @param entry - Transcript entry to add
   */
  addTranscript(
    callId: string,
    entry: { speaker: "user" | "bot"; text: string }
  ): void {
    const session = this.sessions.get(callId);
    if (!session) {
      this.logger?.warn(
        `[Sessions] Cannot add transcript for unknown call: ${callId}`
      );
      return;
    }

    session.transcript.push({
      speaker: entry.speaker,
      text: entry.text,
      timestamp: Date.now(),
    });
    session.lastActivityAt = Date.now();

    // Trim transcript if too long (keep most recent entries)
    if (session.transcript.length > this.maxTranscriptEntries) {
      const excess = session.transcript.length - this.maxTranscriptEntries;
      session.transcript.splice(0, excess);
    }
  }

  /**
   * Get transcript history for a call.
   *
   * @param callId - Call identifier
   * @param maxEntries - Maximum entries to return (default: all)
   * @returns Array of transcript entries
   */
  getTranscript(callId: string, maxEntries?: number): TranscriptEntry[] {
    const session = this.sessions.get(callId);
    if (!session) return [];

    if (maxEntries && maxEntries < session.transcript.length) {
      return session.transcript.slice(-maxEntries);
    }

    return [...session.transcript];
  }

  /**
   * Build formatted history context for LLM prompts.
   *
   * @param callId - Call identifier
   * @param maxEntries - Maximum entries to include (default: 10)
   * @returns Formatted conversation history string
   */
  buildHistoryContext(callId: string, maxEntries = 10): string {
    const session = this.sessions.get(callId);
    if (!session || session.transcript.length === 0) return "";

    const entries = session.transcript.slice(-maxEntries);
    const lines = entries.map(
      (entry) => `${entry.speaker === "bot" ? "You" : "Caller"}: ${entry.text}`
    );

    return `\n\nConversation so far:\n${lines.join("\n")}`;
  }

  /**
   * Check if a session exists for a call.
   *
   * @param callId - Call identifier
   */
  hasSession(callId: string): boolean {
    return this.sessions.has(callId);
  }

  /**
   * Clean up session on call end.
   *
   * @param callId - Call identifier
   */
  removeSession(callId: string): void {
    if (this.sessions.delete(callId)) {
      this.logger?.debug(`[Sessions] Removed session for call ${callId}`);
    }
  }

  /**
   * Get session info for a call (without modifying state).
   *
   * @param callId - Call identifier
   */
  getSessionInfo(callId: string): ConversationSession | undefined {
    return this.sessions.get(callId);
  }

  /**
   * Get total number of active sessions.
   */
  getSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Clean up expired sessions.
   * Call periodically for memory management.
   */
  cleanupExpiredSessions(): number {
    const now = Date.now();
    let removed = 0;

    for (const [callId, session] of this.sessions.entries()) {
      if (now - session.lastActivityAt > this.sessionExpiryMs) {
        this.sessions.delete(callId);
        removed++;
      }
    }

    if (removed > 0) {
      this.logger?.debug(`[Sessions] Cleaned up ${removed} expired sessions`);
    }

    return removed;
  }

  /**
   * Normalize user ID for session key generation.
   * Removes special characters and normalizes to lowercase.
   */
  private normalizeUserId(userId: string): string {
    return userId.toLowerCase().replace(/[^a-z0-9]/g, "");
  }
}
