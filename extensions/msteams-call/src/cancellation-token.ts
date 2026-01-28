/**
 * Cancellation Token with AbortController
 *
 * Provides coordinated async cancellation for streaming voice operations.
 * Uses AbortSignal for fetch() cancellation and manual checks for other operations.
 *
 * CRITICAL: Uses AbortController for true fetch cancellation!
 * The "check-then-act" pattern is racy - fetch() would continue
 * even after cancellation. AbortSignal is the proper solution.
 */

/**
 * Cancellation token for coordinating async cancellation across
 * multiple operations (TTS synthesis, audio queuing, etc.)
 */
export class CancellationToken {
  private readonly abortController = new AbortController();

  /**
   * Get the AbortSignal for use with fetch() and other abort-aware APIs.
   */
  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /**
   * Cancel all operations using this token.
   * - AbortSignal.aborted becomes true
   * - In-flight fetch() calls abort immediately
   */
  abort(): void {
    this.abortController.abort();
  }

  /**
   * Check if cancelled (for non-fetch operations).
   */
  isCancelled(): boolean {
    return this.abortController.signal.aborted;
  }

  /**
   * Throw if cancelled (for checkpoint-style cancellation).
   * Use this at checkpoints between async operations.
   */
  throwIfCancelled(): void {
    if (this.isCancelled()) {
      throw new CancellationError("Operation cancelled");
    }
  }
}

/**
 * Error thrown when an operation is cancelled.
 */
export class CancellationError extends Error {
  constructor(message = "Cancelled") {
    super(message);
    this.name = "CancellationError";
  }

  /**
   * Check if an error is an AbortError (from fetch abort).
   * AbortError is thrown by fetch() when aborted via AbortSignal.
   */
  static isAbortError(err: unknown): boolean {
    return err instanceof Error && err.name === "AbortError";
  }

  /**
   * Check if an error is a cancellation (either CancellationError or AbortError).
   */
  static isCancellation(err: unknown): boolean {
    return err instanceof CancellationError || CancellationError.isAbortError(err);
  }
}
