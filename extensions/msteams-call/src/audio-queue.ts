/**
 * Ordered Audio Frame Queue with Jitter Buffer
 *
 * Delivers frames in sequence order even when TTS jobs complete out of order.
 * Includes jitter buffer to handle:
 * - Network latency variance
 * - TTS completion time variance
 * - Prevents audio gaps when sequences complete out of order
 */

import type { Logger } from "./bridge.js";

/**
 * Options for creating an AudioQueue.
 */
export interface AudioQueueOptions {
  /** Logger for debug output */
  logger?: Logger;
  /**
   * Minimum frames to buffer before starting playback.
   * Prevents gaps when TTS jobs complete out of order.
   * Default: 25 frames = 500ms at 20ms/frame.
   */
  minJitterFrames?: number;
}

/**
 * Audio queue metrics for monitoring.
 */
export interface AudioQueueMetrics {
  /** Total number of frames currently queued across all sequences */
  depth: number;
  /** Number of sequences with pending frames */
  pendingSequences: number;
  /** Whether jitter buffer has been filled (playback has started) */
  jitterFilled: boolean;
  /** Next sequence ID expected for dequeue */
  nextDequeueSequence: number;
}

/**
 * Ordered audio frame queue that delivers frames in sequence order
 * even when TTS jobs complete out of order.
 *
 * Key features:
 * - Maintains frame order across parallel TTS synthesis
 * - Jitter buffer prevents gaps during playback
 * - Efficient clear() for barge-in scenarios
 */
export class AudioQueue {
  private nextDequeueSequence = 0;
  private framesBySequence = new Map<number, Buffer[]>();
  private skippedSequences = new Set<number>();
  private logger?: Logger;

  /**
   * Minimum frames to buffer before starting playback.
   * ~25 frames = 500ms of audio at 20ms/frame.
   */
  private readonly minJitterFrames: number;
  private jitterBufferFilled = false;

  constructor(options?: AudioQueueOptions) {
    this.logger = options?.logger;
    this.minJitterFrames = options?.minJitterFrames ?? 25;
  }

  /**
   * Enqueue frames for a sequence ID.
   * Frames will only be dequeued when:
   * 1. All prior sequences are exhausted (ordering)
   * 2. Jitter buffer is filled (smoothing)
   *
   * @param sequenceId - Sequence number for ordering (0, 1, 2, ...)
   * @param frames - Array of audio frames (640 bytes each for 20ms @ 16kHz)
   */
  enqueue(sequenceId: number, frames: Buffer[]): void {
    if (frames.length === 0) return;

    // Store frames for this sequence
    const existing = this.framesBySequence.get(sequenceId);
    if (existing) {
      // Append to existing frames (shouldn't normally happen, but handle it)
      existing.push(...frames);
    } else {
      this.framesBySequence.set(sequenceId, [...frames]);
    }

    this.logger?.debug(
      `[AudioQueue] Enqueued ${frames.length} frames for seq=${sequenceId}, ` +
        `total depth=${this.getDepth()}, pending seqs=${this.framesBySequence.size}`
    );
  }

  /**
   * Check if jitter buffer has enough data to start playback.
   * Only matters for initial fill; once playing, we drain continuously.
   */
  private checkJitterBuffer(): boolean {
    this.advanceSkippedSequences();
    if (this.jitterBufferFilled) return true;

    const depth = this.getDepth();
    if (depth >= this.minJitterFrames) {
      this.jitterBufferFilled = true;
      this.logger?.debug(`[AudioQueue] Jitter buffer filled (${depth} frames)`);
      return true;
    }

    // Also fill if we have the first sequence complete (don't wait forever)
    // This handles short responses that may not fill the jitter buffer
    const nextFrames = this.framesBySequence.get(this.nextDequeueSequence);
    if (nextFrames && nextFrames.length > 0) {
      this.jitterBufferFilled = true;
      this.logger?.debug(
        `[AudioQueue] Jitter buffer filled (sequence ${this.nextDequeueSequence} ready with ${nextFrames.length} frames)`
      );
      return true;
    }
    }

    return false;
  }

  /**
   * Dequeue next frame in order.
   * Returns null if:
   * - Queue is empty
   * - Waiting for a prior sequence (ordering)
   * - Jitter buffer not yet filled (smoothing)
   */
  dequeueNext(): Buffer | null {
    if (!this.checkJitterBuffer()) {
      return null;
    }

    this.advanceSkippedSequences();
    const frames = this.framesBySequence.get(this.nextDequeueSequence);
    if (!frames || frames.length === 0) {
      // No frames for current sequence
      // This could mean we're waiting for a slower TTS job
      return null;
    }

    const frame = frames.shift()!;

    // If sequence exhausted, move to next
    if (frames.length === 0) {
      this.framesBySequence.delete(this.nextDequeueSequence);
      this.nextDequeueSequence++;
    }

    return frame;
  }

  /**
   * Clear all pending frames (for barge-in).
   * Resets all state so queue is ready for next response.
   */
  clear(): void {
    this.framesBySequence.clear();
    this.nextDequeueSequence = 0;
    this.jitterBufferFilled = false;
    this.skippedSequences.clear();
    this.logger?.debug("[AudioQueue] Cleared all pending frames");
  }

  /**
   * Reset for new conversation turn.
   * Alias for clear() with semantic meaning.
   */
  reset(): void {
    this.clear();
  }

  /**
   * Check if there are any pending frames.
   */
  hasPending(): boolean {
    return this.framesBySequence.size > 0;
  }

  /**
   * Check if there are frames ready to dequeue.
   * This is different from hasPending() - it checks if we can actually
   * dequeue a frame right now (respecting jitter buffer and ordering).
   */
  hasReadyFrames(): boolean {
    if (!this.jitterBufferFilled && !this.checkJitterBuffer()) {
      return false;
    }
    this.advanceSkippedSequences();
    const frames = this.framesBySequence.get(this.nextDequeueSequence);
    return frames !== undefined && frames.length > 0;
  }

  /**
   * Get total number of frames across all sequences.
   */
  getDepth(): number {
    let total = 0;
    for (const frames of this.framesBySequence.values()) {
      total += frames.length;
    }
    return total;
  }

  /**
   * Get metrics for monitoring.
   */
  getMetrics(): AudioQueueMetrics {
    return {
      depth: this.getDepth(),
      pendingSequences: this.framesBySequence.size,
      jitterFilled: this.jitterBufferFilled,
      nextDequeueSequence: this.nextDequeueSequence,
    };
  }

  /**
   * Get the next expected sequence ID for enqueueing.
   * Useful for tracking what sequence ID to use next.
   */
  getNextEnqueueSequence(): number {
    let maxSeq = -1;
    for (const seq of this.framesBySequence.keys()) {
      if (seq > maxSeq) maxSeq = seq;
    }
    return Math.max(this.nextDequeueSequence, maxSeq + 1);
  }

  /**
   * Skip a sequence ID to prevent stalls when a chunk is dropped or fails.
   */
  skip(sequenceId: number): void {
    if (sequenceId < this.nextDequeueSequence) return;
    if (this.framesBySequence.has(sequenceId)) return;
    this.skippedSequences.add(sequenceId);
    this.advanceSkippedSequences();
    this.logger?.debug(`[AudioQueue] Skipped seq=${sequenceId}`);
  }

  private advanceSkippedSequences(): void {
    while (this.skippedSequences.has(this.nextDequeueSequence)) {
      this.skippedSequences.delete(this.nextDequeueSequence);
      this.nextDequeueSequence++;
    }
  }
}
