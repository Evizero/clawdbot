/**
 * Realtime Voice Agent
 *
 * Main orchestrator for OpenAI Realtime API voice calls.
 * Uses Realtime API as THE agent (single LLM, direct tool access).
 *
 * Architecture:
 *   User Audio → Realtime API (with tools) → Audio Response
 *                      ↓
 *              [sessions_spawn for heavy tasks]
 *
 * Features:
 * - Single LLM execution (no double model like broken TTS approach)
 * - Direct tool access via function calling
 * - VAD-based turn detection
 * - Barge-in interruption handling
 * - Session duration management (15min OpenAI limit)
 */

import { RealtimeSession, type RealtimeSessionConfig, type FunctionCall } from "./realtime-session.js";
import { VoiceToolAdapter, type ToolExecutionContext, type ToolExecutor } from "./voice-tool-adapter.js";
import { resample16kTo24k, resample24kTo16k, chunkAudio } from "./audio-utils.js";
import type { TeamsAudioBridge, Logger } from "./bridge.js";

/**
 * Configuration for the Realtime Voice Agent.
 */
export interface RealtimeVoiceAgentConfig {
  /** OpenAI API key */
  openaiApiKey: string;
  /** Model to use (default: gpt-4o-realtime-preview) */
  model?: string;
  /** Voice to use (default: coral) */
  voice?: string;
  /** Turn detection settings */
  turnDetection?: {
    type: "server_vad" | "none";
    threshold?: number;
    silenceDurationMs?: number;
  };
  /** Tools configuration */
  tools?: {
    allow?: string[];
    deny?: string[];
  };
  /** Tool executor for realtime function calls */
  toolExecutor?: ToolExecutor;
  /** Optional resolver to enrich tool execution context */
  resolveToolContext?: (context: ToolExecutionContext) => Promise<ToolExecutionContext> | ToolExecutionContext;
  /**
   * Maximum session duration in milliseconds.
   * OpenAI Realtime API has a 15-minute limit.
   * Default: 14 minutes (with 1 minute buffer)
   */
  maxSessionDurationMs?: number;
  /** Logger */
  logger?: Logger;
  /** Input transcript handler (for session recording) */
  onInputTranscript?: (params: { callId: string; text: string; isFinal: boolean }) => void;
  /** Session factory for tests */
  createSession?: (config: RealtimeSessionConfig) => RealtimeSessionLike;
}

/**
 * Agent configuration resolved from bindings.
 */
export interface ResolvedAgentConfig {
  agentId: string;
  systemPrompt: string;
  tools: Array<{
    name: string;
    description?: string;
    parameters?: {
      type: "object";
      properties?: Record<string, unknown>;
      required?: string[];
    };
  }>;
  identity?: { name?: string };
}

/**
 * Voice call state.
 */
interface VoiceCallState {
  callId: string;
  userId: string;
  session: RealtimeSessionLike;
  startedAt: number;
  sessionRefreshTimer?: NodeJS.Timeout;
  isInterrupted: boolean;
  agentConfig: ResolvedAgentConfig;
  // Audio pacing state - Teams buffer is only 1-5 seconds
  audioQueue: Buffer[];
  audioPacingTimer?: NodeJS.Timeout;
  isSpeaking: boolean;
  // Precise timing for audio pacing
  pacingStartTime: number;
  framesSent: number;
  // Track last flush time - need delay before new audio after barge-in
  lastFlushTime: number;
}

interface RealtimeSessionLike {
  connect(events: Parameters<RealtimeSession["connect"]>[0]): Promise<void>;
  isConnected(): boolean;
  sendAudio(audio24k: Buffer): void;
  interrupt(): void;
  close(): void;
  submitToolResult(callId: string, result: string): void;
}

/**
 * Realtime Voice Agent.
 *
 * Orchestrates voice calls using OpenAI Realtime API directly as the agent.
 *
 * Usage:
 * 1. Create agent with config
 * 2. Call startCall() when call connects
 * 3. Call handleAudioIn() with incoming audio frames
 * 4. Audio out is sent via bridge automatically
 * 5. Call handleBargeIn() when user interrupts
 * 6. Call endCall() when call ends
 */
export class RealtimeVoiceAgent {
  private config: RealtimeVoiceAgentConfig;
  private bridge: TeamsAudioBridge;
  private toolAdapter: VoiceToolAdapter;
  private activeCalls: Map<string, VoiceCallState> = new Map();
  private logger?: Logger;
  private resolveToolContext?: RealtimeVoiceAgentConfig["resolveToolContext"];
  private onInputTranscript?: RealtimeVoiceAgentConfig["onInputTranscript"];
  private createSession?: RealtimeVoiceAgentConfig["createSession"];

  constructor(
    bridge: TeamsAudioBridge,
    config: RealtimeVoiceAgentConfig,
  ) {
    this.bridge = bridge;
    this.config = {
      model: "gpt-4o-realtime-preview",
      voice: "coral",
      maxSessionDurationMs: 14 * 60 * 1000, // 14 minutes
      ...config,
    };
    this.logger = config.logger;
    this.resolveToolContext = config.resolveToolContext;
    this.onInputTranscript = config.onInputTranscript;
    this.createSession = config.createSession;

    // Initialize tool adapter with config
    this.toolAdapter = new VoiceToolAdapter({
      allowTools: config.tools?.allow,
      denyTools: config.tools?.deny,
      executor: config.toolExecutor,
      logger: config.logger,
    });
  }

  /**
   * Start a voice call with the Realtime API.
   *
   * @param callId Unique call identifier
   * @param userId User identifier (for agent binding resolution)
   * @param agentConfig Resolved agent configuration
   */
  async startCall(
    callId: string,
    userId: string,
    agentConfig: ResolvedAgentConfig,
  ): Promise<void> {
    // Check for existing call
    if (this.activeCalls.has(callId)) {
      this.logger?.warn(`[RealtimeAgent] Call ${callId} already active`);
      return;
    }

    this.logger?.info(
      `[RealtimeAgent] Starting call ${callId} for user ${userId}, agent=${agentConfig.agentId}`
    );

    // Build system prompt with agent identity
    const systemPrompt = this.buildSystemPrompt(agentConfig);

    // Convert tools to Realtime format
    let realtimeTools: RealtimeSessionConfig["tools"] = [];
    if (!this.toolAdapter.hasExecutor()) {
      if (agentConfig.tools.length > 0) {
        this.logger?.warn(
          `[RealtimeAgent] Tool executor missing for call ${callId}; ` +
          `suppressing ${agentConfig.tools.length} tool(s) to avoid failed calls.`
        );
      }
      realtimeTools = [];
    } else {
      realtimeTools = this.toolAdapter.buildRealtimeTools(agentConfig.tools);
      if (realtimeTools.length === 0 && agentConfig.tools.length > 0) {
        this.logger?.warn(
          `[RealtimeAgent] No voice-safe tools configured for call ${callId} (input tools: ${agentConfig.tools.length}).`
        );
      } else if (realtimeTools.length > 0) {
        this.logger?.info(`[RealtimeAgent] Configured ${realtimeTools.length} tools: ${realtimeTools.map(t => t.name).join(', ')}`);
      }
    }

    // Create Realtime session
    const sessionConfig: RealtimeSessionConfig = {
      apiKey: this.config.openaiApiKey,
      model: this.config.model,
      voice: this.config.voice,
      instructions: systemPrompt,
      tools: realtimeTools,
      turnDetection: this.config.turnDetection ?? {
        type: "server_vad",
        threshold: 0.5,
        silenceDurationMs: 300,
      },
      logger: this.logger,
    };

    const session = this.createSession
      ? this.createSession(sessionConfig)
      : new RealtimeSession(sessionConfig);

    // Connect with event handlers
    await session.connect({
      onAudioDelta: (audio) => this.handleAudioOut(callId, audio),
      onAudioDone: () => this.handleAudioDone(callId),
      onFunctionCall: (call) => this.handleFunctionCall(callId, call),
      onUserSpeakingStarted: () => this.handleUserSpeakingStarted(callId),
      onUserSpeakingStopped: () => this.handleUserSpeakingStopped(callId),
      onInputTranscript: (text, isFinal) =>
        this.handleInputTranscript(callId, text, isFinal),
      onResponseCancelled: () => this.handleResponseCancelled(callId),
      onError: (error) => this.handleSessionError(callId, error),
      onClose: (code, reason) => this.handleSessionClose(callId, code, reason),
    });

    // Store call state
    const state: VoiceCallState = {
      callId,
      userId,
      session,
      startedAt: Date.now(),
      isInterrupted: false,
      agentConfig,
      audioQueue: [],
      isSpeaking: false,
      pacingStartTime: 0,
      framesSent: 0,
      lastFlushTime: 0,
    };

    // Set up session refresh timer (OpenAI 15-min limit)
    const maxDuration = this.config.maxSessionDurationMs || 14 * 60 * 1000;
    state.sessionRefreshTimer = setTimeout(() => {
      this.handleSessionTimeout(callId);
    }, maxDuration);

    this.activeCalls.set(callId, state);
    this.logger?.info(`[RealtimeAgent] Call ${callId} started successfully`);
  }

  /**
   * Handle incoming audio from Teams (16kHz PCM).
   *
   * @param callId Call identifier
   * @param audio16k 16kHz PCM audio buffer
   */
  handleAudioIn(callId: string, audio16k: Buffer): void {
    const state = this.activeCalls.get(callId);
    if (!state || !state.session.isConnected()) {
      return;
    }

    // Resample 16kHz → 24kHz for Realtime API
    const audio24k = resample16kTo24k(audio16k);
    state.session.sendAudio(audio24k);
  }

  /**
   * Handle barge-in (user starts speaking during bot response).
   *
   * @param callId Call identifier
   */
  handleBargeIn(callId: string): void {
    const state = this.activeCalls.get(callId);
    if (!state) {
      return;
    }

    this.logger?.info(`[RealtimeAgent] Barge-in for call ${callId}`);
    state.isInterrupted = true;
    state.session.interrupt();

    // Clear audio queue and stop pacing
    this.clearAudioQueue(callId);

    // Send flush to bridge
    this.bridge.sendAudioFlush(callId);
  }

  /**
   * End a voice call.
   *
   * @param callId Call identifier
   */
  async endCall(callId: string): Promise<void> {
    const state = this.activeCalls.get(callId);
    if (!state) {
      return;
    }

    this.logger?.info(`[RealtimeAgent] Ending call ${callId}`);

    // Clear audio queue and pacing timer
    this.clearAudioQueue(callId);

    // Clear session refresh timer
    if (state.sessionRefreshTimer) {
      clearTimeout(state.sessionRefreshTimer);
    }

    // Close session
    state.session.close();

    // Remove from active calls
    this.activeCalls.delete(callId);
  }

  /**
   * Handle audio output from Realtime API (24kHz PCM).
   * Buffers audio and sends at real-time pace (20ms per frame) to avoid
   * overwhelming Teams media bridge buffer (1-5 seconds).
   */
  private handleAudioOut(callId: string, audio24k: Buffer): void {
    const state = this.activeCalls.get(callId);
    if (!state) {
      this.logger?.warn(`[RealtimeAgent] handleAudioOut: no state for ${callId}`);
      return;
    }
    if (state.isInterrupted) {
      this.logger?.info(`[RealtimeAgent] handleAudioOut: dropping audio (isInterrupted=true) - check if this is expected`);
      return;
    }

    // After flush, give the C# gateway time to reset before sending new audio
    // This prevents audio being dropped after barge-in
    if (state.lastFlushTime > 0) {
      const timeSinceFlush = Date.now() - state.lastFlushTime;
      const FLUSH_RECOVERY_MS = 100; // 100ms delay after flush
      if (timeSinceFlush < FLUSH_RECOVERY_MS) {
        // Still in recovery - drop this audio (it's likely stale from old response)
        this.logger?.debug(`[RealtimeAgent] handleAudioOut: dropping audio during flush recovery (${timeSinceFlush}ms)`);
        return;
      }
      // Recovery complete
      this.logger?.info(`[RealtimeAgent] Flush recovery complete (${timeSinceFlush}ms), resuming audio`);
      state.lastFlushTime = 0;
    }

    this.logger?.debug(`[RealtimeAgent] handleAudioOut: received ${audio24k.length} bytes (isSpeaking=${state.isSpeaking}, queueLen=${state.audioQueue.length})`);

    // Resample 24kHz → 16kHz for Teams
    const audio16k = resample24kTo16k(audio24k);

    // Chunk into frames and add to queue
    for (const chunk of chunkAudio(audio16k, 640)) {
      // Pad undersized frames
      const frame = chunk.length < 640
        ? Buffer.concat([chunk, Buffer.alloc(640 - chunk.length)])
        : chunk;
      state.audioQueue.push(frame);
    }

    // Start pacing timer if not already running
    if (!state.audioPacingTimer) {
      this.logger?.info(
        `[RealtimeAgent] Starting audio pacing (queued ${state.audioQueue.length} frames, ` +
        `isInterrupted=${state.isInterrupted}, afterFlush=${state.lastFlushTime === 0})`
      );
      state.isSpeaking = true;
      this.startAudioPacing(callId);
    }
  }

  /**
   * Start the audio pacing timer that sends frames at precise 20ms intervals.
   * Uses timestamp-based scheduling to avoid drift from setInterval imprecision.
   */
  private startAudioPacing(callId: string): void {
    const state = this.activeCalls.get(callId);
    if (!state) return;

    // Initialize timing for this playback session
    state.pacingStartTime = Date.now();
    state.framesSent = 0;

    this.scheduleNextFrame(callId);
  }

  /**
   * Schedule the next frame with precise timing.
   */
  private scheduleNextFrame(callId: string): void {
    const state = this.activeCalls.get(callId);
    if (!state || !state.isSpeaking) {
      this.logger?.debug(`[RealtimeAgent] scheduleNextFrame: skipping (state=${!!state}, isSpeaking=${state?.isSpeaking})`);
      return;
    }

    const frame = state.audioQueue.shift();
    if (!frame) {
      // Queue empty - stop pacing
      this.logger?.debug(`[RealtimeAgent] scheduleNextFrame: queue empty, stopping (sent ${state.framesSent} frames)`);
      this.stopAudioPacing(callId);
      return;
    }

    // Send this frame
    this.bridge.sendAudioFrame(callId, frame);
    state.framesSent++;

    // Log occasionally to confirm frames are being sent
    if (state.framesSent === 1 || state.framesSent % 50 === 0) {
      this.logger?.debug(`[RealtimeAgent] Sent frame ${state.framesSent}, queue depth: ${state.audioQueue.length}`);
    }

    // Calculate when next frame should be sent based on elapsed time
    // This prevents drift by always calculating from the start time
    const expectedTime = state.pacingStartTime + (state.framesSent * 20);
    const now = Date.now();
    const delay = Math.max(0, expectedTime - now);

    // Schedule next frame
    state.audioPacingTimer = setTimeout(() => {
      this.scheduleNextFrame(callId);
    }, delay);
  }

  /**
   * Stop audio pacing and clear queue.
   */
  private stopAudioPacing(callId: string): void {
    const state = this.activeCalls.get(callId);
    if (!state) return;

    if (state.audioPacingTimer) {
      clearTimeout(state.audioPacingTimer);
      state.audioPacingTimer = undefined;
    }
    state.isSpeaking = false;
    state.framesSent = 0;
  }

  /**
   * Clear audio queue (for barge-in).
   */
  private clearAudioQueue(callId: string): void {
    const state = this.activeCalls.get(callId);
    if (!state) return;

    const droppedFrames = state.audioQueue.length;
    this.stopAudioPacing(callId);
    state.audioQueue = [];

    if (droppedFrames > 0) {
      this.logger?.debug(`[RealtimeAgent] Cleared ${droppedFrames} queued frames`);
    }
  }

  /**
   * Handle audio completion.
   */
  private handleAudioDone(callId: string): void {
    const state = this.activeCalls.get(callId);
    if (!state) {
      return;
    }

    // Reset interrupt flag
    state.isInterrupted = false;
    this.logger?.debug(`[RealtimeAgent] Audio done for call ${callId}`);
  }

  /**
   * Handle function call from the model.
   */
  private async handleFunctionCall(callId: string, call: FunctionCall): Promise<void> {
    const state = this.activeCalls.get(callId);
    if (!state) {
      this.logger?.warn(`[RealtimeAgent] handleFunctionCall: no state for ${callId}`);
      return;
    }

    this.logger?.info(
      `[RealtimeAgent] Function call for ${callId}: ${call.name}(${call.arguments.slice(0, 100)})`
    );

    // Build execution context
    const baseContext: ToolExecutionContext = {
      callId,
      toolCallId: call.callId,
      userId: state.userId,
      sessionId: state.callId,
      agentId: state.agentConfig.agentId,
    };
    const context = this.resolveToolContext
      ? await this.resolveToolContext(baseContext)
      : baseContext;
    if (!context.toolCallId) {
      context.toolCallId = call.callId;
    }

    // Execute tool
    const result = await this.toolAdapter.executeTool(
      call.name,
      call.arguments,
      context,
    );

    this.logger?.info(`[RealtimeAgent] Tool result for ${call.name}: ${String(result).slice(0, 200)}`);

    // Submit result back to model (triggers response.create)
    if (state.session.isConnected()) {
      this.logger?.info(`[RealtimeAgent] Submitting tool result for ${call.callId} and triggering response.create`);
      state.session.submitToolResult(call.callId, result);
    } else {
      this.logger?.warn(`[RealtimeAgent] Session disconnected, cannot submit tool result for ${call.callId}`);
    }
  }

  /**
   * Handle user starting to speak (VAD detected by Realtime API).
   * This triggers barge-in - clear buffered audio so user isn't waiting.
   */
  private handleUserSpeakingStarted(callId: string): void {
    const state = this.activeCalls.get(callId);
    if (!state) return;

    this.logger?.info(
      `[RealtimeAgent] VAD speech_started for ${callId} ` +
      `(isSpeaking=${state.isSpeaking}, queueLen=${state.audioQueue.length}, isInterrupted=${state.isInterrupted})`
    );

    // Only trigger barge-in if we're actually speaking (have buffered audio)
    if (state.isSpeaking || state.audioQueue.length > 0) {
      this.logger?.info(`[RealtimeAgent] Barge-in (VAD): clearing ${state.audioQueue.length} buffered frames`);

      // Clear our audio buffer
      this.clearAudioQueue(callId);

      // Tell bridge to flush any pending audio
      this.bridge.sendAudioFlush(callId);

      // Mark that we just flushed - need small delay before new audio
      state.lastFlushTime = Date.now();

      // The Realtime API will automatically cancel its response via VAD
      // so we don't need to call session.interrupt() here
    }
  }

  /**
   * Handle user stopping speaking.
   */
  private handleUserSpeakingStopped(callId: string): void {
    this.logger?.debug(`[RealtimeAgent] User speaking stopped: ${callId}`);
  }

  /**
   * Handle response cancelled (due to interruption).
   * Reset state so next response can play.
   */
  private handleResponseCancelled(callId: string): void {
    const state = this.activeCalls.get(callId);
    if (!state) return;

    this.logger?.info(
      `[RealtimeAgent] Response cancelled for ${callId} - resetting state ` +
      `(was: isInterrupted=${state.isInterrupted}, isSpeaking=${state.isSpeaking}, queueLen=${state.audioQueue.length})`
    );

    // Reset interrupt flag so next response can play
    state.isInterrupted = false;

    // Clear any remaining buffered audio
    this.clearAudioQueue(callId);

    this.logger?.info(`[RealtimeAgent] State reset complete - ready for next response`);
  }

  /**
   * Handle input transcript.
   */
  private handleInputTranscript(
    _callId: string,
    text: string,
    isFinal: boolean,
  ): void {
    if (isFinal) {
      this.logger?.info(`[RealtimeAgent] User said: "${text}"`);
      this.onInputTranscript?.({ callId: _callId, text, isFinal });
      // Could emit event for logging/session recording
    }
  }

  /**
   * Handle session error.
   */
  private handleSessionError(callId: string, error: Error): void {
    this.logger?.error(
      `[RealtimeAgent] Session error for ${callId}: ${error.message}`
    );
    // Could attempt reconnection or end call
  }

  /**
   * Handle session close.
   */
  private handleSessionClose(callId: string, code: number, reason: string): void {
    this.logger?.info(
      `[RealtimeAgent] Session closed for ${callId}: ${code} ${reason}`
    );
    // Clean up if not already ended
    this.activeCalls.delete(callId);
  }

  /**
   * Handle session timeout (OpenAI 15-min limit).
   */
  private handleSessionTimeout(callId: string): void {
    const state = this.activeCalls.get(callId);
    if (!state) {
      return;
    }

    this.logger?.warn(
      `[RealtimeAgent] Session timeout for ${callId} (OpenAI 15-min limit)`
    );

    // For now, just end the call
    // TODO: Implement session refresh/reconnection
    void this.endCall(callId);
  }

  /**
   * Build system prompt from agent configuration.
   */
  private buildSystemPrompt(agentConfig: ResolvedAgentConfig): string {
    const agentName = agentConfig.identity?.name || "voice assistant";

    // Base prompt for voice interaction
    const voiceGuidelines = `
You are ${agentName}, a helpful voice assistant on a phone call.

Voice Interaction Guidelines:
- Keep responses brief and conversational (1-3 sentences typically)
- Be natural and friendly, like talking to a real person
- Use simple language, avoid technical jargon unless asked
- When using tools, briefly announce what you're doing (e.g., "Let me check that for you...")
- For async tasks (sessions_spawn), let the user know an agent is working on it

Tool Usage:
- Use tools when they would be helpful, but don't over-explain
- For quick lookups, just provide the answer naturally
- For tasks that take time, delegate via sessions_spawn and let the user know
`;

    // Combine with agent's system prompt if provided
    if (agentConfig.systemPrompt) {
      return `${agentConfig.systemPrompt}\n\n${voiceGuidelines}`;
    }

    return voiceGuidelines.trim();
  }

  /**
   * Get count of active calls.
   */
  getActiveCallCount(): number {
    return this.activeCalls.size;
  }

  /**
   * Get call state (for debugging/monitoring).
   */
  getCallState(callId: string): {
    callId: string;
    userId: string;
    agentId: string;
    durationMs: number;
    isConnected: boolean;
  } | undefined {
    const state = this.activeCalls.get(callId);
    if (!state) return undefined;

    return {
      callId: state.callId,
      userId: state.userId,
      agentId: state.agentConfig.agentId,
      durationMs: Date.now() - state.startedAt,
      isConnected: state.session.isConnected(),
    };
  }

  /**
   * Clean up all calls and resources.
   */
  async dispose(): Promise<void> {
    for (const callId of this.activeCalls.keys()) {
      await this.endCall(callId);
    }
  }
}
