/**
 * Audio Filters for MS Teams Voice Call
 *
 * FIR low-pass filter implementation for anti-aliasing before downsampling.
 * Required to prevent aliasing when converting 24kHz → 16kHz.
 */

/**
 * Pre-computed FIR low-pass filter coefficients.
 *
 * Specifications:
 * - Type: Windowed-sinc (Blackman window)
 * - Cutoff: 7200 Hz (0.6 × Nyquist @ 24kHz = 0.6 × 12kHz)
 * - Order: 64 taps (provides ~80dB stopband attenuation)
 * - Normalized to unity gain at DC
 *
 * This filter attenuates frequencies above 7.2kHz before downsampling
 * to 16kHz (Nyquist = 8kHz), preventing aliasing artifacts.
 */
const FIR_LOWPASS_8K: readonly number[] = generateFirCoefficients(64, 0.6);

/**
 * Generate FIR low-pass filter coefficients using windowed-sinc method.
 *
 * @param taps Number of filter taps (order)
 * @param cutoff Normalized cutoff frequency (0-1, where 1 = Nyquist)
 * @returns Array of filter coefficients
 */
function generateFirCoefficients(taps: number, cutoff: number): number[] {
  const coefficients: number[] = new Array(taps);
  const center = (taps - 1) / 2;
  let sum = 0;

  for (let i = 0; i < taps; i++) {
    const x = i - center;

    // Sinc function
    let sinc: number;
    if (x === 0) {
      sinc = 2 * Math.PI * cutoff;
    } else {
      sinc = Math.sin(2 * Math.PI * cutoff * x) / x;
    }

    // Blackman window for better stopband attenuation
    const window =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) +
      0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));

    coefficients[i] = sinc * window;
    sum += coefficients[i];
  }

  // Normalize to unity gain
  for (let i = 0; i < taps; i++) {
    coefficients[i] /= sum;
  }

  return coefficients;
}

/**
 * Apply FIR low-pass filter to audio buffer.
 *
 * This function applies an anti-aliasing filter before downsampling.
 * The filter cutoff is set just below the Nyquist frequency of the
 * target sample rate to prevent aliasing.
 *
 * @param input Audio buffer (16-bit PCM, little-endian)
 * @param inputSampleRate Input sample rate in Hz
 * @param targetNyquist Nyquist frequency of target format (half of target sample rate)
 * @returns Filtered audio buffer
 */
export function applyLowPassFilter(
  input: Buffer,
  inputSampleRate: number,
  targetNyquist: number,
): Buffer {
  if (input.length === 0) {
    return Buffer.alloc(0);
  }

  const inputSamples = Math.floor(input.length / 2);
  const output = Buffer.alloc(inputSamples * 2);

  // Use pre-computed coefficients if we're filtering for 8kHz Nyquist
  // (i.e., downsampling 24kHz → 16kHz)
  const coefficients =
    targetNyquist === 8000 && inputSampleRate === 24000
      ? FIR_LOWPASS_8K
      : generateFirCoefficients(64, targetNyquist / (inputSampleRate / 2));

  const taps = coefficients.length;
  const halfTaps = Math.floor(taps / 2);

  // Apply convolution
  for (let i = 0; i < inputSamples; i++) {
    let sum = 0;

    for (let j = 0; j < taps; j++) {
      const sampleIdx = i - halfTaps + j;

      // Get sample with zero-padding at boundaries
      let sample: number;
      if (sampleIdx < 0 || sampleIdx >= inputSamples) {
        sample = 0;
      } else {
        sample = input.readInt16LE(sampleIdx * 2);
      }

      sum += sample * coefficients[j];
    }

    // Clamp and write output
    const clamped = Math.max(-32768, Math.min(32767, Math.round(sum)));
    output.writeInt16LE(clamped, i * 2);
  }

  return output;
}

/**
 * Get filter delay in samples.
 * FIR filters have a linear phase delay of (taps - 1) / 2 samples.
 */
export function getFilterDelay(): number {
  return (FIR_LOWPASS_8K.length - 1) / 2;
}

/**
 * Generate TPDF (Triangular Probability Density Function) dither.
 *
 * TPDF dither reduces quantization distortion and replaces it with
 * low-level white noise, which is perceptually less objectionable
 * than the original quantization distortion, especially in quiet passages.
 *
 * @returns Dither value in range [-1, 1]
 */
export function generateTpdfDither(): number {
  // TPDF: sum of two uniform random values - 1
  // This produces a triangular distribution centered at 0
  return (Math.random() + Math.random() - 1);
}
