/**
 * Streaming TTS Service
 *
 * Manages parallel TTS synthesis jobs with sequence tracking and cancellation.
 * Uses proper promise-based semaphore instead of busy-wait.
 *
 * Key features:
 * - Efficient semaphore pattern (no CPU burn on wait)
 * - AbortSignal support for true fetch cancellation
 * - Sequence tracking for ordered audio delivery
 */

import { CancellationToken, CancellationError } from "./cancellation-token.js";
import type { Logger } from "./bridge.js";

/**
 * TTS Provider interface with cancellation support.
 * Signal parameter is REQUIRED for proper barge-in cancellation!
 */
export interface StreamingTTSProvider {
  synthesize(text: string, options?: { signal?: AbortSignal }): Promise<Buffer>;
}

/**
 * Result of a TTS synthesis job.
 */
export interface TTSSynthesisResult {
  /** Sequence ID for ordered audio delivery */
  sequenceId: number;
  /** Synthesized audio buffer (24kHz PCM) */
  audio: Buffer;
  /** Synthesis latency in milliseconds */
  latencyMs: number;
}

/**
 * Metrics for monitoring TTS service health.
 */
export interface TTSServiceMetrics {
  /** Number of currently running TTS jobs */
  activeJobs: number;
  /** Number of jobs waiting for semaphore */
  queuedJobs: number;
  /** Maximum allowed concurrent jobs */
  maxParallelJobs: number;
}

/**
 * Options for creating a StreamingTTSService.
 */
export interface StreamingTTSServiceOptions {
  /** TTS provider implementation */
  ttsProvider: StreamingTTSProvider;
  /**
   * Maximum concurrent TTS jobs.
   * Default: 3 (balanced for rate limits and latency)
   */
  maxParallelJobs?: number;
  /** Logger for debug output */
  logger?: Logger;
}

/**
 * Promise-based semaphore for limiting concurrent operations.
 * Uses a wait queue pattern instead of busy-wait for efficiency.
 */
class Semaphore {
  private permits: number;
  private waitQueue: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  /**
   * Acquire a permit, waiting if necessary.
   * Returns a promise that resolves when permit is acquired.
   */
  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }

    // Wait for a permit to be released
    return new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  /**
   * Release a permit, potentially waking a waiter.
   */
  release(): void {
    const next = this.waitQueue.shift();
    if (next) {
      // Give permit to next waiter (don't increment permits)
      next();
    } else {
      // No waiters, increment permits
      this.permits++;
    }
  }

  /** Number of available permits */
  get availablePermits(): number {
    return this.permits;
  }

  /** Number of waiters in queue */
  get queueLength(): number {
    return this.waitQueue.length;
  }
}

/**
 * Manages parallel TTS synthesis with proper concurrency control.
 *
 * Features:
 * - Semaphore-based concurrency limiting (no CPU burn)
 * - AbortSignal propagation for immediate cancellation
 * - Sequence tracking for ordered audio delivery
 * - Metrics for monitoring
 */
export class StreamingTTSService {
  private ttsProvider: StreamingTTSProvider;
  private semaphore: Semaphore;
  private activeJobs = 0;
  private logger?: Logger;
  private readonly maxParallelJobs: number;

  constructor(options: StreamingTTSServiceOptions) {
    this.ttsProvider = options.ttsProvider;
    this.maxParallelJobs = options.maxParallelJobs ?? 3;
    this.semaphore = new Semaphore(this.maxParallelJobs);
    this.logger = options.logger;
  }

  /**
   * Synthesize text with cancellation support.
   * Returns sequence ID with audio buffer for queue ordering.
   *
   * @param params.text - Text to synthesize
   * @param params.sequenceId - Sequence number for ordering
   * @param params.cancellationToken - Token for cancellation
   * @returns Synthesis result with sequence ID and audio buffer
   * @throws CancellationError if cancelled
   */
  async synthesize(params: {
    text: string;
    sequenceId: number;
    cancellationToken: CancellationToken;
  }): Promise<TTSSynthesisResult> {
    const { text, sequenceId, cancellationToken } = params;

    // Check before acquiring semaphore
    cancellationToken.throwIfCancelled();

    // Wait for semaphore (efficient wait, no CPU burn!)
    await this.semaphore.acquire();
    this.activeJobs++;
    const startTime = Date.now();

    try {
      // Check after acquiring semaphore (in case cancelled while waiting)
      cancellationToken.throwIfCancelled();

      // Call TTS provider with AbortSignal for true fetch cancellation
      const audio = await this.ttsProvider.synthesize(text, {
        signal: cancellationToken.signal,
      });

      const latencyMs = Date.now() - startTime;
      this.logger?.debug(
        `[StreamingTTS] Seq ${sequenceId} synthesized in ${latencyMs}ms ` +
          `(${audio.length} bytes, text: "${text.slice(0, 40)}${text.length > 40 ? "..." : ""}")`
      );

      return { sequenceId, audio, latencyMs };
    } catch (err) {
      // Convert AbortError to CancellationError for consistent handling
      if (CancellationError.isAbortError(err)) {
        throw new CancellationError("TTS cancelled");
      }
      throw err;
    } finally {
      this.activeJobs--;
      this.semaphore.release();
    }
  }

  /**
   * Get current metrics for diagnostics.
   */
  getMetrics(): TTSServiceMetrics {
    return {
      activeJobs: this.activeJobs,
      queuedJobs: this.semaphore.queueLength,
      maxParallelJobs: this.maxParallelJobs,
    };
  }

  /**
   * Check if service is at capacity.
   * Useful for back-pressure decisions.
   */
  isAtCapacity(): boolean {
    return this.activeJobs >= this.maxParallelJobs;
  }

  /**
   * Get number of currently active jobs.
   */
  getActiveJobCount(): number {
    return this.activeJobs;
  }
}
