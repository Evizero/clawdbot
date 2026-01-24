import { describe, it, expect } from "vitest";
import {
  resample16kTo24k,
  resample24kTo16k,
  chunkAudio,
  getAudioDurationMs,
  calculateCorrelation,
  generateTone,
  generateSilence,
} from "../audio-utils.js";

describe("resample16kTo24k", () => {
  it("converts 640 bytes (20ms @ 16kHz) to 960 bytes (20ms @ 24kHz)", () => {
    // 16kHz @ 20ms = 320 samples = 640 bytes
    const input = Buffer.alloc(640);
    const output = resample16kTo24k(input);
    // 24kHz @ 20ms = 480 samples = 960 bytes
    expect(output.length).toBe(960);
  });

  it("handles empty buffer", () => {
    const output = resample16kTo24k(Buffer.alloc(0));
    expect(output.length).toBe(0);
  });

  it("handles odd-sized buffer", () => {
    // 100 bytes is not aligned to sample boundary, but should not throw
    const input = Buffer.alloc(100);
    expect(() => resample16kTo24k(input)).not.toThrow();
  });

  it("preserves audio characteristics (sine wave)", () => {
    // Generate a 440Hz tone at 16kHz for 100ms
    const tone16k = generateTone(16000, 100, 440, 0.8);
    const upsampled = resample16kTo24k(tone16k);

    // Verify output size (1.5x input samples)
    const inputSamples = tone16k.length / 2;
    const outputSamples = upsampled.length / 2;
    expect(outputSamples).toBe(Math.floor((inputSamples * 3) / 2));

    // Verify audio is not silent (has signal energy)
    let energy = 0;
    for (let i = 0; i < outputSamples; i++) {
      const sample = upsampled.readInt16LE(i * 2);
      energy += sample * sample;
    }
    expect(energy).toBeGreaterThan(0);
  });

  it("preserves audio quality after round-trip resample", () => {
    // Generate a tone at 16kHz
    const original = generateTone(16000, 100, 440, 0.8);

    // Resample 16kHz → 24kHz → 16kHz
    const upsampled = resample16kTo24k(original);
    const roundTrip = resample24kTo16k(upsampled);

    // Calculate correlation (should be high)
    const correlation = calculateCorrelation(original, roundTrip);
    expect(correlation).toBeGreaterThan(0.95);
  });

  it("correctly upsamples known values", () => {
    // Create a simple ramp: 0, 100, 200
    const input = Buffer.alloc(6); // 3 samples
    input.writeInt16LE(0, 0);
    input.writeInt16LE(100, 2);
    input.writeInt16LE(200, 4);

    const output = resample16kTo24k(input);

    // Output should have 4 samples (3 * 3/2 = 4.5, floor = 4)
    expect(output.length).toBe(8); // 4 samples × 2 bytes

    // First sample should be close to 0
    expect(output.readInt16LE(0)).toBe(0);

    // Intermediate samples should be interpolated
    // The exact values depend on the interpolation position
    // but they should be between the input values
    const s1 = output.readInt16LE(2);
    expect(s1).toBeGreaterThanOrEqual(0);
    expect(s1).toBeLessThanOrEqual(200);
  });
});

describe("resample24kTo16k", () => {
  it("converts 960 bytes (20ms @ 24kHz) to 640 bytes (20ms @ 16kHz)", () => {
    // 24kHz @ 20ms = 480 samples = 960 bytes
    const input = Buffer.alloc(960);
    const output = resample24kTo16k(input);
    // 16kHz @ 20ms = 320 samples = 640 bytes
    expect(output.length).toBe(640);
  });

  it("handles empty buffer", () => {
    const output = resample24kTo16k(Buffer.alloc(0));
    expect(output.length).toBe(0);
  });

  it("preserves audio characteristics (sine wave)", () => {
    // Generate a 440Hz tone at 24kHz for 100ms
    const tone24k = generateTone(24000, 100, 440, 0.8);
    const downsampled = resample24kTo16k(tone24k);

    // Verify output size (2/3 of input samples)
    const inputSamples = tone24k.length / 2;
    const outputSamples = downsampled.length / 2;
    expect(outputSamples).toBe(Math.floor((inputSamples * 2) / 3));

    // Verify audio is not silent
    let energy = 0;
    for (let i = 0; i < outputSamples; i++) {
      const sample = downsampled.readInt16LE(i * 2);
      energy += sample * sample;
    }
    expect(energy).toBeGreaterThan(0);
  });

  it("correctly downsamples known values", () => {
    // Create a ramp: 0, 50, 100, 150, 200, 250
    const input = Buffer.alloc(12); // 6 samples
    input.writeInt16LE(0, 0);
    input.writeInt16LE(50, 2);
    input.writeInt16LE(100, 4);
    input.writeInt16LE(150, 6);
    input.writeInt16LE(200, 8);
    input.writeInt16LE(250, 10);

    const output = resample24kTo16k(input);

    // Output should have 4 samples (6 * 2/3 = 4)
    expect(output.length).toBe(8); // 4 samples × 2 bytes

    // First sample should be close to 0 (dithering adds +/- 1)
    const firstSample = output.readInt16LE(0);
    expect(firstSample).toBeGreaterThanOrEqual(-2);
    expect(firstSample).toBeLessThanOrEqual(2);

    // All values should be within input range (with small tolerance for dithering)
    for (let i = 0; i < 4; i++) {
      const sample = output.readInt16LE(i * 2);
      expect(sample).toBeGreaterThanOrEqual(-2);
      expect(sample).toBeLessThanOrEqual(252);
    }
  });
});

describe("chunkAudio", () => {
  it("splits audio into fixed-size chunks", () => {
    const audio = Buffer.alloc(1920); // 3 × 640 bytes
    const chunks = [...chunkAudio(audio, 640)];

    expect(chunks).toHaveLength(3);
    expect(chunks[0].length).toBe(640);
    expect(chunks[1].length).toBe(640);
    expect(chunks[2].length).toBe(640);
  });

  it("handles non-aligned buffer sizes", () => {
    const audio = Buffer.alloc(1000); // Not divisible by 640
    const chunks = [...chunkAudio(audio, 640)];

    expect(chunks).toHaveLength(2);
    expect(chunks[0].length).toBe(640);
    expect(chunks[1].length).toBe(360); // Remainder
  });

  it("handles buffer smaller than chunk size", () => {
    const audio = Buffer.alloc(100);
    const chunks = [...chunkAudio(audio, 640)];

    expect(chunks).toHaveLength(1);
    expect(chunks[0].length).toBe(100);
  });

  it("handles empty buffer", () => {
    const audio = Buffer.alloc(0);
    const chunks = [...chunkAudio(audio, 640)];

    expect(chunks).toHaveLength(0);
  });
});

describe("getAudioDurationMs", () => {
  it("calculates duration for 16kHz audio", () => {
    // 640 bytes = 320 samples = 20ms @ 16kHz
    const buffer = Buffer.alloc(640);
    expect(getAudioDurationMs(buffer, 16000)).toBe(20);
  });

  it("calculates duration for 24kHz audio", () => {
    // 960 bytes = 480 samples = 20ms @ 24kHz
    const buffer = Buffer.alloc(960);
    expect(getAudioDurationMs(buffer, 24000)).toBe(20);
  });

  it("calculates 1 second duration", () => {
    // 16kHz: 16000 samples = 32000 bytes
    const buffer = Buffer.alloc(32000);
    expect(getAudioDurationMs(buffer, 16000)).toBe(1000);
  });
});

describe("calculateCorrelation", () => {
  it("returns 1 for identical signals", () => {
    const tone = generateTone(16000, 50, 440);
    const correlation = calculateCorrelation(tone, tone);
    expect(correlation).toBeCloseTo(1, 5);
  });

  it("returns -1 for inverted signals", () => {
    const tone = generateTone(16000, 50, 440, 0.5);
    const inverted = Buffer.alloc(tone.length);
    for (let i = 0; i < tone.length / 2; i++) {
      inverted.writeInt16LE(-tone.readInt16LE(i * 2), i * 2);
    }
    const correlation = calculateCorrelation(tone, inverted);
    expect(correlation).toBeCloseTo(-1, 5);
  });

  it("returns ~0 for uncorrelated signals", () => {
    // Two different frequencies should have low correlation
    const tone1 = generateTone(16000, 50, 440); // A4
    const tone2 = generateTone(16000, 50, 880); // A5

    const correlation = calculateCorrelation(tone1, tone2);
    // For different frequencies, correlation should be relatively low
    expect(Math.abs(correlation)).toBeLessThan(0.5);
  });

  it("handles empty buffers", () => {
    const empty = Buffer.alloc(0);
    expect(calculateCorrelation(empty, empty)).toBe(0);
  });

  it("handles different length buffers (uses shorter)", () => {
    const short = generateTone(16000, 50, 440);
    const long = generateTone(16000, 100, 440);

    const correlation = calculateCorrelation(short, long);
    // Should still correlate well since they're the same frequency
    expect(correlation).toBeGreaterThan(0.9);
  });
});

describe("generateTone", () => {
  it("generates correct buffer size", () => {
    // 16kHz for 100ms = 1600 samples = 3200 bytes
    const tone = generateTone(16000, 100);
    expect(tone.length).toBe(3200);
  });

  it("generates non-silent audio", () => {
    const tone = generateTone(16000, 100, 440, 0.5);

    let hasNonZero = false;
    for (let i = 0; i < tone.length / 2; i++) {
      if (tone.readInt16LE(i * 2) !== 0) {
        hasNonZero = true;
        break;
      }
    }
    expect(hasNonZero).toBe(true);
  });

  it("respects amplitude", () => {
    const fullAmplitude = generateTone(16000, 100, 440, 1.0);
    const halfAmplitude = generateTone(16000, 100, 440, 0.5);

    // Find max absolute value in each
    let maxFull = 0;
    let maxHalf = 0;
    for (let i = 0; i < fullAmplitude.length / 2; i++) {
      maxFull = Math.max(maxFull, Math.abs(fullAmplitude.readInt16LE(i * 2)));
      maxHalf = Math.max(maxHalf, Math.abs(halfAmplitude.readInt16LE(i * 2)));
    }

    // Full amplitude should be roughly 2x half amplitude
    expect(maxFull).toBeGreaterThan(maxHalf * 1.5);
  });
});

describe("generateSilence", () => {
  it("generates correct buffer size", () => {
    // 16kHz for 100ms = 1600 samples = 3200 bytes
    const silence = generateSilence(16000, 100);
    expect(silence.length).toBe(3200);
  });

  it("generates all zeros", () => {
    const silence = generateSilence(16000, 100);

    for (let i = 0; i < silence.length / 2; i++) {
      expect(silence.readInt16LE(i * 2)).toBe(0);
    }
  });
});

describe("Teams ↔ OpenAI format conversion", () => {
  it("correctly converts Teams 20ms frame to OpenAI format", () => {
    // Teams sends 640 bytes per 20ms frame (16kHz × 0.02s × 2 bytes)
    const teamsFrame = generateTone(16000, 20, 440);
    expect(teamsFrame.length).toBe(640);

    // Convert to OpenAI format (24kHz)
    const openaiFrame = resample16kTo24k(teamsFrame);

    // Should be 960 bytes (24kHz × 0.02s × 2 bytes)
    expect(openaiFrame.length).toBe(960);
  });

  it("correctly converts OpenAI TTS output to Teams format", () => {
    // OpenAI TTS outputs 24kHz, e.g., 1 second = 24000 samples = 48000 bytes
    const openaiAudio = generateTone(24000, 1000, 440);
    expect(openaiAudio.length).toBe(48000);

    // Convert to Teams format (16kHz)
    const teamsAudio = resample24kTo16k(openaiAudio);

    // Should be 32000 bytes (16kHz × 1s × 2 bytes)
    expect(teamsAudio.length).toBe(32000);
  });
});
