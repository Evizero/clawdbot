/**
 * OpenAI TTS Provider for MS Teams
 *
 * Generates speech audio using OpenAI's text-to-speech API.
 * Outputs 24kHz PCM which the bridge resamples to 16kHz for Teams.
 */

import type { TTSProvider } from "../bridge.js";

/**
 * OpenAI TTS configuration.
 */
export interface OpenAITTSConfig {
  /** OpenAI API key (uses OPENAI_API_KEY env if not set) */
  apiKey?: string;
  /**
   * TTS model:
   * - gpt-4o-mini-tts: newest, supports instructions for tone/style control
   * - tts-1: lower latency
   * - tts-1-hd: higher quality
   */
  model?: string;
  /**
   * Voice to use.
   * All voices: alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer, verse, marin, cedar
   */
  voice?: string;
  /** Speed multiplier (0.25 to 4.0) */
  speed?: number;
  /**
   * Instructions for speech style (only works with gpt-4o-mini-tts model).
   */
  instructions?: string;
}

/**
 * OpenAI TTS Provider that outputs 24kHz PCM.
 */
export class OpenAITTSProvider implements TTSProvider {
  private apiKey: string;
  private model: string;
  private voice: string;
  private speed: number;
  private instructions?: string;

  constructor(config: OpenAITTSConfig = {}) {
    this.apiKey = config.apiKey || process.env.OPENAI_API_KEY || "";
    this.model = config.model || "gpt-4o-mini-tts";
    this.voice = config.voice || "coral";
    this.speed = config.speed || 1.0;
    this.instructions = config.instructions;

    if (!this.apiKey) {
      throw new Error(
        "OpenAI API key required (set OPENAI_API_KEY or pass apiKey)",
      );
    }
  }

  /**
   * Generate speech audio from text.
   * Returns raw PCM audio data (24kHz, mono, 16-bit).
   */
  async synthesize(text: string, instructions?: string): Promise<Buffer> {
    const body: Record<string, unknown> = {
      model: this.model,
      input: text,
      voice: this.voice,
      response_format: "pcm", // Raw PCM audio (24kHz, mono, 16-bit signed LE)
      speed: this.speed,
    };

    // Add instructions if using gpt-4o-mini-tts model
    const effectiveInstructions = instructions || this.instructions;
    if (effectiveInstructions && this.model.includes("gpt-4o-mini-tts")) {
      body.instructions = effectiveInstructions;
    }

    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI TTS failed: ${response.status} - ${error}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
