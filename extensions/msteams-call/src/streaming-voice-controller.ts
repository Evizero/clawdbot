/**
 * Streaming Voice Controller (Chunked Mode)
 *
 * Orchestrates streaming voice conversations using chunked TTS.
 *
 * Architecture:
 * - User speech → STT → Text → Pi Agent (LLM) → Text → Chunked TTS → Audio
 * - Parallel TTS synthesis with ordered delivery
 * - May have slight prosodic breaks between sentences
 * - Works with any LLM provider
 *
 * NOTE: For realtime mode (single LLM with direct tools), use RealtimeVoiceAgent.
 *
 * Features:
 * - Barge-in with immediate audio stop
 * - Echo cancellation to prevent false barge-in
 * - Multi-turn conversation context
 */

import { CancellationToken, CancellationError } from "./cancellation-token.js";
import { AudioQueue } from "./audio-queue.js";
import {
  StreamingTTSService,
  type StreamingTTSProvider,
} from "./streaming-tts-service.js";
import { ConversationSessionManager } from "./conversation-session-manager.js";
import type { TeamsAudioBridge, Logger } from "./bridge.js";
import { loadCoreAgentDeps, type CoreConfig } from "./core-bridge.js";
import { resample24kTo16k, chunkAudio } from "./audio-utils.js";

/**
 * Configuration for streaming voice responses (chunked mode).
 */
export interface StreamingVoiceConfig {
  /** Minimum characters before sentence break for TTS */
  sentenceMinChars?: number;
  /** Maximum characters per sentence chunk for TTS */
  sentenceMaxChars?: number;
  /** Maximum concurrent TTS synthesis jobs */
  maxParallelTTS?: number;
  /** Jitter buffer size in frames (1 frame = 20ms) */
  jitterBufferFrames?: number;
  /** LLM model for voice responses (provider/model format) */
  responseModel?: string;
  /** Custom system prompt for voice responses */
  responseSystemPrompt?: string;
  /** Timeout for response generation in milliseconds */
  responseTimeoutMs?: number;
  /** Thinking level for LLM responses */
  thinkLevel?: "off" | "low" | "medium" | "high";
  /** OpenAI API key (for TTS) */
  openaiApiKey?: string;
  /** Voice to use for TTS */
  voice?: string;
  /** Speech style instructions */
  instructions?: string;
  /** TTS mode (ignored - always chunked) */
  ttsMode?: string;
}

/**
 * Parameters for creating a StreamingVoiceController.
 */
export interface StreamingVoiceControllerOptions {
  /** Teams audio bridge for sending audio frames */
  bridge: TeamsAudioBridge;
  /** TTS provider for speech synthesis */
  ttsProvider: StreamingTTSProvider;
  /** Session manager for conversation context */
  sessionManager: ConversationSessionManager;
  /** Streaming configuration */
  config: StreamingVoiceConfig;
  /** Logger for debug output */
  logger?: Logger;
}

/**
 * State of the streaming voice controller.
 */
type StreamingState = "idle" | "streaming" | "draining";

/**
 * Result of a streaming response.
 */
export interface StreamingResponseResult {
  /** Number of sentences processed */
  sentenceCount: number;
  /** Total audio duration in milliseconds (approximate) */
  audioDurationMs: number;
  /** Whether response was cancelled (barge-in) */
  cancelled: boolean;
}

/**
 * Orchestrates streaming voice conversations (chunked mode).
 *
 * Flow:
 * 1. Receives transcript from STT
 * 2. Streams LLM response with sentence-level chunks
 * 3. Synthesizes TTS in parallel (3 concurrent jobs)
 * 4. Queues audio frames in order
 * 5. Drains audio to bridge at 20ms intervals
 *
 * Barge-in:
 * - Cancels all in-flight operations
 * - Clears audio queue
 * - Sends flush to gateway
 */
export class StreamingVoiceController {
  private bridge: TeamsAudioBridge;
  private ttsService: StreamingTTSService;
  private sessionManager: ConversationSessionManager;
  private audioQueue: AudioQueue;
  private config: StreamingVoiceConfig;
  private logger?: Logger;

  // Per-response state
  private state: StreamingState = "idle";
  private cancellationToken: CancellationToken | null = null;
  private nextSequenceId = 0;
  private currentCallId: string | null = null;

  // Serialize drain loop to prevent audio glitches
  private drainLock: Promise<void> = Promise.resolve();

  // Echo cancellation - ignore barge-in when bot is speaking
  private isPlayingAudio = false;

  // Back-pressure - limit pending TTS jobs
  private readonly MAX_PENDING_SENTENCES = 5;
  private pendingSentenceCount = 0;

  // Track pending TTS promises for cleanup
  private pendingTTSPromises: Set<Promise<unknown>> = new Set();

  // Track total audio duration for metrics
  private totalAudioFrames = 0;

  constructor(options: StreamingVoiceControllerOptions) {
    this.bridge = options.bridge;
    this.ttsService = new StreamingTTSService({
      ttsProvider: options.ttsProvider,
      maxParallelJobs: options.config.maxParallelTTS ?? 3,
      logger: options.logger,
    });
    this.sessionManager = options.sessionManager;
    this.audioQueue = new AudioQueue({
      logger: options.logger,
      minJitterFrames: options.config.jitterBufferFrames ?? 25,
    });
    this.config = options.config;
    this.logger = options.logger;
  }

  /**
   * Check if barge-in should be ignored (echo cancellation).
   * Returns true if bot is currently speaking.
   */
  shouldIgnoreBargeIn(): boolean {
    return this.isPlayingAudio;
  }

  /**
   * Get current state of the controller.
   */
  getState(): StreamingState {
    return this.state;
  }

  /**
   * Check if currently streaming a response.
   */
  isStreaming(): boolean {
    return this.state !== "idle";
  }

  /**
   * Stream a response for a user message.
   * Called when STT emits a final transcript.
   *
   * @param params.callId - Unique call identifier
   * @param params.userMessage - Transcribed user message
   * @param params.userId - User identifier for session
   * @param params.coreConfig - Clawdbot core configuration
   */
  async streamResponse(params: {
    callId: string;
    userMessage: string;
    userId: string;
    coreConfig: CoreConfig;
  }): Promise<StreamingResponseResult> {
    const { callId, userMessage, userId, coreConfig } = params;

    if (this.state !== "idle") {
      this.logger?.warn(
        "[StreamingVoice] Already streaming, cancelling previous response"
      );
      await this.cancel();
    }

    // Initialize state for new response
    this.state = "streaming";
    this.currentCallId = callId;
    this.nextSequenceId = 0;
    this.pendingSentenceCount = 0;
    this.totalAudioFrames = 0;
    this.cancellationToken = new CancellationToken();
    this.audioQueue.reset();
    this.pendingTTSPromises.clear();

    // Get or create conversation session
    const session = this.sessionManager.getSession(callId, userId);
    session.transcript.push({
      speaker: "user",
      text: userMessage,
      timestamp: Date.now(),
    });

    // Build history context for multi-turn conversation
    const historyContext = this.sessionManager.buildHistoryContext(callId, 10);

    let cancelled = false;

    try {
      const deps = await loadCoreAgentDeps();

      // Resolve agent configuration
      const agentDir = deps.resolveAgentDir(coreConfig, "main");
      const workspaceDir = deps.resolveAgentWorkspaceDir(coreConfig, "main");
      const sessionFile = deps.resolveSessionFilePath(
        session.sessionId,
        {},
        { agentId: "main" }
      );

      // Resolve model from config
      const modelRef =
        this.config.responseModel ||
        `${deps.DEFAULT_PROVIDER}/${deps.DEFAULT_MODEL}`;
      const [provider, ...modelParts] = modelRef.includes("/")
        ? modelRef.split("/")
        : [deps.DEFAULT_PROVIDER, modelRef];
      const model = modelParts.join("/") || deps.DEFAULT_MODEL;

      this.logger?.info(
        `[StreamingVoice] Starting response for call ${callId}, model=${provider}/${model}`
      );

      // Resolve thinking level from config or defaults
      const thinkLevel =
        this.config.thinkLevel ??
        deps.resolveThinkingDefault({ cfg: coreConfig, provider, model }) ??
        "low";

      // Build system prompt for voice responses
      const agentIdentity = deps.resolveAgentIdentity(coreConfig, "main");
      const systemPrompt = this.buildSystemPrompt(agentIdentity, historyContext);

      // Chunking config for sentence-level TTS
      const chunkingConfig = {
        minChars: this.config.sentenceMinChars ?? 20,
        maxChars: this.config.sentenceMaxChars ?? 200,
        breakPreference: "sentence" as const,
      };

      // Run embedded agent with streaming callbacks
      await deps.runEmbeddedPiAgent({
        sessionId: session.sessionId,
        sessionKey: session.sessionKey,
        messageProvider: "msteams-call",
        sessionFile,
        workspaceDir,
        agentDir,
        config: coreConfig,
        prompt: userMessage,
        provider,
        model,
        thinkLevel,
        verboseLevel: "off",
        timeoutMs: this.config.responseTimeoutMs ?? 30000,
        runId: `voice:${callId}:${Date.now()}`,
        lane: "voice",
        extraSystemPrompt: systemPrompt,
        abortSignal: this.cancellationToken.signal,

        // Streaming callbacks
        onBlockReply: (payload) => this.handleBlockReply(payload),

        // Enable tool result narration
        shouldEmitToolResult: () => true,
        onToolResult: (payload) => this.handleToolResult(payload),

        // Chunking config
        blockReplyChunking: chunkingConfig,
        blockReplyBreak: "text_end",
      });

      // Wait for all pending TTS jobs to complete or cancel
      await Promise.allSettled([...this.pendingTTSPromises]);

      // Transition to draining state while queue empties
      if (
        this.audioQueue.hasPending() &&
        !this.cancellationToken.isCancelled()
      ) {
        this.state = "draining";
        await this.drainLock;
      }

      this.logger?.debug(
        `[StreamingVoice] Response complete: ${this.nextSequenceId} chunks, ` +
          `${this.totalAudioFrames} frames (~${this.totalAudioFrames * 20}ms audio)`
      );
    } catch (err) {
      if (CancellationError.isCancellation(err)) {
        this.logger?.debug("[StreamingVoice] Response cancelled (barge-in)");
        cancelled = true;
      } else {
        this.logger?.error("[StreamingVoice] Response error:", err);
      }
    } finally {
      this.state = "idle";
      this.currentCallId = null;
      this.cancellationToken = null;
      this.isPlayingAudio = false;
    }

    return {
      sentenceCount: this.nextSequenceId,
      audioDurationMs: this.totalAudioFrames * 20,
      cancelled,
    };
  }

  /**
   * Handle text chunk from LLM streaming.
   */
  private handleBlockReply(payload: {
    text?: string;
    mediaUrls?: string[];
  }): void {
    const text = payload.text?.trim();
    if (
      !text ||
      !this.cancellationToken ||
      this.cancellationToken.isCancelled()
    ) {
      return;
    }

    const seqId = this.nextSequenceId++;
    this.logger?.info(
      `[StreamingVoice] Chunk ${seqId}: "${text.slice(0, 50)}${text.length > 50 ? "..." : ""}"`
    );

    // Track bot response in transcript
    if (this.currentCallId) {
      this.sessionManager.addTranscript(this.currentCallId, {
        speaker: "bot",
        text,
      });
    }

    // Send to chunked TTS
    this.handleChunkedTTS(text, seqId);
  }

  /**
   * Handle text with chunked TTS (parallel synthesis).
   */
  private handleChunkedTTS(sentence: string, seqId: number): void {
    // Back-pressure - don't queue if too many pending
    if (this.pendingSentenceCount >= this.MAX_PENDING_SENTENCES) {
      this.logger?.warn(
        "[StreamingVoice] Back-pressure: dropping sentence (too many pending)"
      );
      this.audioQueue.skip(seqId);
      void this.scheduleDrain();
      return;
    }

    this.pendingSentenceCount++;

    // Queue TTS job (runs in parallel with other sentences)
    const ttsPromise = this.ttsService
      .synthesize({
        text: sentence,
        sequenceId: seqId,
        cancellationToken: this.cancellationToken!,
      })
      .then((result) => {
        if (this.cancellationToken?.isCancelled()) return;

        // Convert 24kHz TTS output to 16kHz for Teams
        const frames = this.prepareAudioFrames(result.audio);
        this.audioQueue.enqueue(result.sequenceId, frames);
        this.totalAudioFrames += frames.length;

        // Trigger drain
        void this.scheduleDrain();
      })
      .catch((err) => {
        if (!CancellationError.isCancellation(err)) {
          this.logger?.error(`[StreamingVoice] TTS failed for seq ${seqId}:`, err);
          this.audioQueue.skip(seqId);
          void this.scheduleDrain();
        }
      })
      .finally(() => {
        this.pendingSentenceCount--;
        this.pendingTTSPromises.delete(ttsPromise);
      });

    this.pendingTTSPromises.add(ttsPromise);
  }

  /**
   * Handle tool status updates.
   * Narrates what the agent is doing during long tool executions.
   */
  private handleToolResult(payload: { text?: string; mediaUrls?: string[] }): void {
    const status = payload.text?.trim();
    if (!status) return;

    // Queue tool status as a sentence for TTS
    this.handleBlockReply({ text: status });
  }

  /**
   * Prepare audio frames from TTS buffer.
   * Resamples 24kHz -> 16kHz and chunks to 640-byte frames.
   */
  private prepareAudioFrames(audio24k: Buffer): Buffer[] {
    // Resample to 16kHz for Teams
    const audio16k = resample24kTo16k(audio24k);
    const frames: Buffer[] = [];

    for (const chunk of chunkAudio(audio16k, 640)) {
      // Pad undersized frames to 640 bytes
      if (chunk.length < 640) {
        const padded = Buffer.alloc(640);
        chunk.copy(padded);
        frames.push(padded);
      } else {
        frames.push(chunk);
      }
    }

    return frames;
  }

  /**
   * Schedule drain with serialization.
   * Prevents concurrent drain loops (audio glitches).
   */
  private scheduleDrain(): void {
    this.drainLock = this.drainLock.then(() => this.drainAudioQueue());
  }

  /**
   * Drain audio queue to bridge.
   * Sends frames at ~20ms intervals to match real-time playback.
   */
  private async drainAudioQueue(): Promise<void> {
    if (!this.currentCallId) return;

    while (this.cancellationToken && !this.cancellationToken.isCancelled()) {
      const frame = this.audioQueue.dequeueNext();
      if (!frame) {
        // Queue empty or waiting for in-order sequence
        break;
      }

      // Set echo cancellation flag on first frame
      if (!this.isPlayingAudio) {
        this.isPlayingAudio = true;
        this.logger?.debug(
          "[StreamingVoice] Started playing audio (echo cancellation active)"
        );
      }

      // Send frame to bridge
      this.bridge.sendAudioFrame(this.currentCallId, frame);

      // Sleep slightly under 20ms to prevent gaps between frames
      await this.sleep(18);
    }

    // Check if we've finished draining
    if (!this.audioQueue.hasPending()) {
      this.isPlayingAudio = false;
      this.logger?.debug(
        "[StreamingVoice] Finished playing audio (echo cancellation inactive)"
      );
    }
  }

  /**
   * Cancel current streaming response (barge-in).
   */
  async cancel(): Promise<void> {
    if (this.state === "idle") return;

    this.logger?.info("[StreamingVoice] Cancelling response (barge-in)");

    // 1. Abort all in-flight operations
    this.cancellationToken?.abort();

    // 2. Clear pending audio frames
    this.audioQueue.clear();

    // 3. Send audio_flush to stop in-transit frames on gateway
    if (this.currentCallId) {
      this.bridge.sendAudioFlush(this.currentCallId);
    }

    // 4. Wait for pending TTS promises to settle
    await Promise.allSettled([...this.pendingTTSPromises]);

    // 5. Reset state
    this.state = "idle";
    this.isPlayingAudio = false;
    this.pendingSentenceCount = 0;
  }

  /**
   * Build system prompt for voice responses.
   */
  private buildSystemPrompt(
    agentIdentity: { name?: string | null } | null | undefined,
    history: string
  ): string {
    const agentName = agentIdentity?.name || "voice assistant";
    const base =
      this.config.responseSystemPrompt ??
      `You are ${agentName}, a helpful voice assistant on a Microsoft Teams call. ` +
        "Keep responses brief and conversational (1-2 sentences). " +
        "Be natural and friendly. You have access to tools - use them when helpful.";

    return base + history;
  }

  /**
   * Sleep for specified milliseconds.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get metrics for monitoring.
   */
  getMetrics(): {
    state: StreamingState;
    queueDepth: number;
    pendingSentences: number;
    isPlayingAudio: boolean;
    ttsMetrics: { activeJobs: number; queuedJobs: number; maxParallelJobs: number };
  } {
    return {
      state: this.state,
      queueDepth: this.audioQueue.getDepth(),
      pendingSentences: this.pendingSentenceCount,
      isPlayingAudio: this.isPlayingAudio,
      ttsMetrics: this.ttsService.getMetrics(),
    };
  }

  /**
   * Speak a greeting or one-shot message with TTS.
   *
   * @param callId - Call to speak on
   * @param text - Text to speak
   */
  async speakGreeting(callId: string, text: string): Promise<void> {
    if (this.state !== "idle") {
      this.logger?.warn("[StreamingVoice] Cannot speak greeting while streaming");
      return;
    }

    this.state = "streaming";
    this.currentCallId = callId;
    this.isPlayingAudio = true;

    try {
      const cancellationToken = new CancellationToken();
      const result = await this.ttsService.synthesize({
        text,
        sequenceId: 0,
        cancellationToken,
      });

      const frames = this.prepareAudioFrames(result.audio);
      for (const frame of frames) {
        this.bridge.sendAudioFrame(callId, frame);
        await this.sleep(18);
      }
    } catch (err) {
      if (!CancellationError.isCancellation(err)) {
        this.logger?.error("[StreamingVoice] Greeting error:", err);
      }
    } finally {
      this.state = "idle";
      this.currentCallId = null;
      this.isPlayingAudio = false;
    }
  }

  /**
   * Clean up resources.
   */
  async dispose(): Promise<void> {
    await this.cancel();
  }
}
