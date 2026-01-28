import { describe, it, expect } from "vitest";
import { AudioQueue } from "../audio-queue.js";

const frame = (value: number) => Buffer.from([value]);

describe("AudioQueue skip", () => {
  it("advances past skipped sequences", () => {
    const queue = new AudioQueue({ minJitterFrames: 1 });

    queue.skip(0);
    const expected = frame(1);
    queue.enqueue(1, [expected]);

    const out = queue.dequeueNext();
    expect(out).toBe(expected);
  });

  it("continues after a gap in the middle", () => {
    const queue = new AudioQueue({ minJitterFrames: 1 });

    const a = frame(1);
    const b = frame(2);
    const c = frame(3);

    queue.enqueue(0, [a, b]);
    queue.skip(1);
    queue.enqueue(2, [c]);

    expect(queue.dequeueNext()).toBe(a);
    expect(queue.dequeueNext()).toBe(b);
    expect(queue.dequeueNext()).toBe(c);
  });
});
