/**
 * Audio Format Utilities for MS Teams ↔ OpenAI
 *
 * Handles conversion between:
 * - Teams: 16kHz PCM, 16-bit mono, little-endian
 * - OpenAI Realtime: 24kHz PCM, 16-bit mono, little-endian
 *
 * The conversion uses a 3:2 ratio (16kHz × 1.5 = 24kHz).
 *
 * Key features:
 * - Anti-aliasing filter before downsampling (prevents aliasing artifacts)
 * - TPDF dithering for quantization noise reduction
 */

import { applyLowPassFilter, generateTpdfDither } from "./filters.js";

/**
 * Resample 16kHz PCM to 24kHz (3:2 upsample ratio).
 * For Teams → OpenAI Realtime.
 *
 * Uses linear interpolation with TPDF dithering for improved audio quality.
 * Note: Upsampling doesn't require anti-aliasing filter (no aliasing on upsample).
 *
 * Input: 16kHz PCM, 16-bit signed LE, mono
 * Output: 24kHz PCM, 16-bit signed LE, mono
 *
 * @param input Buffer containing 16kHz PCM audio
 * @returns Buffer containing 24kHz PCM audio
 */
export function resample16kTo24k(input: Buffer): Buffer {
  if (input.length === 0) {
    return Buffer.alloc(0);
  }

  // Each sample is 2 bytes (16-bit)
  const inputSamples = Math.floor(input.length / 2);
  // 16kHz to 24kHz is 3:2 ratio (multiply by 1.5)
  const outputSamples = Math.floor((inputSamples * 3) / 2);
  const output = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    // Calculate the position in the input (2:3 ratio)
    const srcPos = (i * 2) / 3;
    const srcIdx = Math.floor(srcPos);
    const frac = srcPos - srcIdx;

    // Read samples for interpolation
    const s0 = readSample(input, srcIdx);
    const s1 = readSample(input, srcIdx + 1);

    // Linear interpolation with TPDF dither
    const interpolated = s0 + frac * (s1 - s0);
    const dither = generateTpdfDither() * 0.5; // Scale dither appropriately
    const sample = Math.round(interpolated + dither);
    output.writeInt16LE(clamp16(sample), i * 2);
  }

  return output;
}

/**
 * Resample 24kHz PCM to 16kHz (3:2 downsample ratio).
 * For OpenAI TTS → Teams.
 *
 * IMPORTANT: Applies anti-aliasing filter before downsampling to prevent
 * aliasing artifacts. Without this filter, frequencies between 8-12kHz
 * would alias back into the audible range (0-8kHz).
 *
 * Input: 24kHz PCM, 16-bit signed LE, mono
 * Output: 16kHz PCM, 16-bit signed LE, mono
 *
 * @param input Buffer containing 24kHz PCM audio
 * @returns Buffer containing 16kHz PCM audio
 */
export function resample24kTo16k(input: Buffer): Buffer {
  if (input.length === 0) {
    return Buffer.alloc(0);
  }

  // Apply anti-aliasing low-pass filter (cutoff at 8kHz for 16kHz target)
  // This prevents frequencies above Nyquist from aliasing back into audible range
  const filtered = applyLowPassFilter(input, 24000, 8000);

  // Each sample is 2 bytes (16-bit)
  const inputSamples = Math.floor(filtered.length / 2);
  // 24kHz to 16kHz is 2:3 ratio (multiply by 2/3)
  const outputSamples = Math.floor((inputSamples * 2) / 3);
  const output = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    // Calculate the position in the input (3:2 ratio)
    const srcPos = (i * 3) / 2;
    const srcIdx = Math.floor(srcPos);
    const frac = srcPos - srcIdx;

    // Read samples for interpolation
    const s0 = readSample(filtered, srcIdx);
    const s1 = readSample(filtered, srcIdx + 1);

    // Linear interpolation with TPDF dither
    const interpolated = s0 + frac * (s1 - s0);
    const dither = generateTpdfDither() * 0.5; // Scale dither appropriately
    const sample = Math.round(interpolated + dither);
    output.writeInt16LE(clamp16(sample), i * 2);
  }

  return output;
}

/**
 * Read a sample from a buffer, returning 0 if out of bounds.
 */
function readSample(buffer: Buffer, sampleIndex: number): number {
  const byteIndex = sampleIndex * 2;
  if (byteIndex < 0 || byteIndex + 1 >= buffer.length) {
    // Return the last valid sample or 0
    if (byteIndex < 0) return 0;
    const lastIdx = Math.floor(buffer.length / 2) - 1;
    if (lastIdx >= 0) {
      return buffer.readInt16LE(lastIdx * 2);
    }
    return 0;
  }
  return buffer.readInt16LE(byteIndex);
}

/**
 * Clamp value to 16-bit signed integer range.
 */
function clamp16(value: number): number {
  return Math.max(-32768, Math.min(32767, value));
}

/**
 * Split audio buffer into fixed-size chunks.
 *
 * @param audio Audio buffer to chunk
 * @param chunkSize Bytes per chunk (default: 640 for 20ms @ 16kHz PCM)
 * @returns Generator yielding audio chunks
 */
export function* chunkAudio(
  audio: Buffer,
  chunkSize = 640,
): Generator<Buffer, void, unknown> {
  for (let i = 0; i < audio.length; i += chunkSize) {
    yield audio.subarray(i, Math.min(i + chunkSize, audio.length));
  }
}

/**
 * Calculate audio duration in milliseconds.
 *
 * @param buffer Audio buffer
 * @param sampleRate Sample rate in Hz
 * @returns Duration in milliseconds
 */
export function getAudioDurationMs(buffer: Buffer, sampleRate: number): number {
  const samples = buffer.length / 2; // 16-bit = 2 bytes per sample
  return (samples / sampleRate) * 1000;
}

/**
 * Calculate correlation coefficient between two audio buffers.
 * Used for testing to verify audio quality after resampling.
 *
 * @returns Correlation coefficient between -1 and 1
 */
export function calculateCorrelation(a: Buffer, b: Buffer): number {
  // Use the shorter buffer length
  const samples = Math.min(
    Math.floor(a.length / 2),
    Math.floor(b.length / 2),
  );

  if (samples === 0) return 0;

  // Calculate means
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < samples; i++) {
    sumA += a.readInt16LE(i * 2);
    sumB += b.readInt16LE(i * 2);
  }
  const meanA = sumA / samples;
  const meanB = sumB / samples;

  // Calculate correlation
  let numerator = 0;
  let denomA = 0;
  let denomB = 0;
  for (let i = 0; i < samples; i++) {
    const diffA = a.readInt16LE(i * 2) - meanA;
    const diffB = b.readInt16LE(i * 2) - meanB;
    numerator += diffA * diffB;
    denomA += diffA * diffA;
    denomB += diffB * diffB;
  }

  const denominator = Math.sqrt(denomA * denomB);
  if (denominator === 0) return 0;

  return numerator / denominator;
}

/**
 * Generate a sine wave tone for testing.
 *
 * @param sampleRate Sample rate in Hz (e.g., 16000, 24000)
 * @param durationMs Duration in milliseconds
 * @param frequency Tone frequency in Hz (default: 440Hz, A4)
 * @param amplitude Amplitude 0-1 (default: 0.5)
 * @returns Buffer containing PCM audio
 */
export function generateTone(
  sampleRate: number,
  durationMs: number,
  frequency = 440,
  amplitude = 0.5,
): Buffer {
  const samples = Math.floor((sampleRate * durationMs) / 1000);
  const buffer = Buffer.alloc(samples * 2);

  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    const sample = Math.sin(2 * Math.PI * frequency * t) * 0x7fff * amplitude;
    buffer.writeInt16LE(Math.round(sample), i * 2);
  }

  return buffer;
}

/**
 * Generate silence (zeros) for testing.
 *
 * @param sampleRate Sample rate in Hz
 * @param durationMs Duration in milliseconds
 * @returns Buffer containing silence
 */
export function generateSilence(sampleRate: number, durationMs: number): Buffer {
  const samples = Math.floor((sampleRate * durationMs) / 1000);
  return Buffer.alloc(samples * 2);
}
