/**
 * MS Teams Voice Call Session Recorder
 *
 * Records call events to Clawdbot's session system for:
 * - Call history tracking per user
 * - Multi-turn context via transcripts
 */

import { loadCoreAgentDeps } from "./core-bridge.js";
import type { SessionMetadata, CallDirection, EndReason } from "./types.js";
import type { Logger } from "./runtime.js";

/**
 * MsgContext fields needed for session recording.
 * Subset of the full MsgContext type from auto-reply/templating.
 */
interface MsgContext {
  Body?: string;
  From?: string;
  To?: string;
  SenderId?: string;
  SenderName?: string;
  Timestamp?: number;
  Provider?: string;
  Surface?: string;
  ChatType?: string;
  SessionKey?: string;
  // Index signature for Record<string, unknown> compatibility
  [key: string]: string | number | undefined;
}

/**
 * Parameters for TeamsCallSessionRecorder constructor.
 */
export interface TeamsCallSessionRecorderParams {
  storePath: string;
  logger?: Logger;
}

/**
 * Call start event data.
 */
export interface CallStartEvent {
  callId: string;
  direction: CallDirection;
  metadata: SessionMetadata;
}

/**
 * Transcript event data.
 */
export interface TranscriptEvent {
  callId: string;
  text: string;
  isFinal: boolean;
}

/**
 * Call end event data.
 */
export interface CallEndEvent {
  callId: string;
  reason: EndReason;
}

/**
 * Session recorder for MS Teams voice calls.
 *
 * Records call events to Clawdbot's session store for history tracking
 * and multi-turn context. Uses the session key format: `msteams-call:{userId}`
 */
export class TeamsCallSessionRecorder {
  private storePath: string;
  private logger?: Logger;

  // Track callId -> metadata for userId lookup in subsequent events
  private callMetadata = new Map<string, SessionMetadata>();

  // Lazy-loaded core deps for session recording
  private coreDepsPromise: ReturnType<typeof loadCoreAgentDeps> | null = null;

  constructor(params: TeamsCallSessionRecorderParams) {
    this.storePath = params.storePath;
    this.logger = params.logger;
  }

  /**
   * Get core agent deps (lazy loaded).
   */
  private async getCoreDeps() {
    if (!this.coreDepsPromise) {
      this.coreDepsPromise = loadCoreAgentDeps();
    }
    return this.coreDepsPromise;
  }

  /**
   * Build session key from user ID.
   * Format: msteams-call:{userId} (lowercase)
   */
  private buildSessionKey(userId: string): string {
    return `msteams-call:${userId.toLowerCase()}`;
  }

  /**
   * Build MsgContext for session recording.
   */
  private buildMsgContext(params: {
    body: string;
    metadata: SessionMetadata;
  }): MsgContext {
    const { body, metadata } = params;
    const sessionKey = this.buildSessionKey(metadata.userId);

    return {
      Body: body,
      From: metadata.displayName || metadata.userId,
      To: "msteams-call-bot",
      SenderId: metadata.userId,
      SenderName: metadata.displayName,
      Timestamp: Date.now(),
      Provider: "msteams-call",
      Surface: "msteams-call",
      ChatType: "direct",
      SessionKey: sessionKey,
    };
  }

  /**
   * Handle errors from session recording (non-fatal, log only).
   */
  private onRecordError = (err: unknown): void => {
    this.logger?.warn(
      "[msteams-call] Session recording failed:",
      err instanceof Error ? err.message : String(err),
    );
  };

  /**
   * Record call start event.
   */
  async recordCallStart(event: CallStartEvent): Promise<void> {
    const { callId, direction, metadata } = event;

    // Store metadata for lookup in subsequent events
    this.callMetadata.set(callId, metadata);

    const directionLabel = direction === "inbound" ? "Inbound" : "Outbound";
    const body = `${directionLabel} voice call started`;

    const ctx = this.buildMsgContext({ body, metadata });

    const coreDeps = await this.getCoreDeps();
    await coreDeps.recordInboundSession({
      storePath: this.storePath,
      sessionKey: ctx.SessionKey!,
      ctx,
      createIfMissing: true,
      onRecordError: this.onRecordError,
    });

    this.logger?.debug(`[msteams-call] Recorded call start for ${callId}`);
  }

  /**
   * Record transcript event.
   * Only records final transcripts to avoid duplicate entries.
   */
  async recordTranscript(event: TranscriptEvent): Promise<void> {
    const { callId, text, isFinal } = event;

    // Only record final transcripts
    if (!isFinal) return;

    const metadata = this.callMetadata.get(callId);
    if (!metadata) {
      this.logger?.warn(
        `[msteams-call] No metadata for call ${callId}, skipping transcript recording`,
      );
      return;
    }

    const ctx = this.buildMsgContext({ body: text, metadata });

    const coreDeps = await this.getCoreDeps();
    await coreDeps.recordInboundSession({
      storePath: this.storePath,
      sessionKey: ctx.SessionKey!,
      ctx,
      createIfMissing: true,
      onRecordError: this.onRecordError,
    });

    this.logger?.debug(`[msteams-call] Recorded transcript for ${callId}`);
  }

  /**
   * Record call end event.
   */
  async recordCallEnd(event: CallEndEvent): Promise<void> {
    const { callId, reason } = event;

    const metadata = this.callMetadata.get(callId);
    if (!metadata) {
      this.logger?.warn(
        `[msteams-call] No metadata for call ${callId}, skipping end recording`,
      );
      return;
    }

    const reasonLabels: Record<EndReason, string> = {
      "hangup-user": "User hung up",
      "hangup-bot": "Bot hung up",
      error: "Call error",
      timeout: "Call timeout",
    };

    const body = `Voice call ended: ${reasonLabels[reason] || reason}`;
    const ctx = this.buildMsgContext({ body, metadata });

    const coreDeps = await this.getCoreDeps();
    await coreDeps.recordInboundSession({
      storePath: this.storePath,
      sessionKey: ctx.SessionKey!,
      ctx,
      createIfMissing: true,
      onRecordError: this.onRecordError,
    });

    // Clean up stored metadata
    this.callMetadata.delete(callId);

    this.logger?.debug(`[msteams-call] Recorded call end for ${callId}`);
  }

  /**
   * Get the session key for a given user ID.
   * Useful for external callers that need to reference the session.
   */
  getSessionKey(userId: string): string {
    return this.buildSessionKey(userId);
  }
}
