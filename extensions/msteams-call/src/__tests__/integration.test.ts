import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TeamsCallProvider } from "../provider.js";
import { TeamsAudioBridge } from "../bridge.js";
import { MockTeamsBridge, createTestMockBridge } from "../mock-bridge.js";
import { generateTone } from "../audio-utils.js";
import type { TeamsCallConfig } from "../config.js";

const TEST_PORT = 13339;
const TEST_SECRET = "test-secret-12345678901234567890123456789012";

/** Test configuration */
const testConfig: TeamsCallConfig = {
  enabled: true,
  serve: {
    port: TEST_PORT,
    bind: "127.0.0.1",
    path: "/teams-call/stream",
  },
  bridge: {
    secret: TEST_SECRET,
  },
  authorization: {
    mode: "open",
    allowFrom: [],
    allowedTenants: [],
    allowPstn: false,
  },
  inbound: {
    enabled: true,
    greeting: "Hello! How can I help?",
  },
  outbound: {
    enabled: true,
    ringTimeoutMs: 5000,
    defaultMode: "conversation",
  },
  tts: {
    model: "gpt-4o-mini-tts",
    voice: "coral",
    speed: 1.0,
  },
  streaming: {
    sttModel: "gpt-4o-transcribe",
    silenceDurationMs: 800,
    vadThreshold: 0.5,
  },
  responseModel: "openai/gpt-4o-mini",
  responseTimeoutMs: 30000,
  maxConcurrentCalls: 5,
  maxDurationSeconds: 3600,
};

describe("Integration: Full Call Flow", () => {
  let bridge: TeamsAudioBridge;
  let provider: TeamsCallProvider;
  let mockGateway: MockTeamsBridge;

  beforeEach(async () => {
    // Create bridge with mock TTS
    bridge = new TeamsAudioBridge({
      port: TEST_PORT,
      secret: TEST_SECRET,
    });

    // Mock TTS returns 24kHz audio (will be downsampled to 16kHz)
    bridge.setMockTTS(async (text) => {
      // Generate 24kHz audio based on text length (rough approximation)
      const durationMs = Math.max(100, text.length * 30); // ~30ms per char
      return generateTone(24000, durationMs, 440);
    });

    provider = new TeamsCallProvider(bridge, testConfig);
    await provider.start();

    mockGateway = createTestMockBridge(TEST_PORT, { secret: TEST_SECRET });
  });

  afterEach(async () => {
    await mockGateway.stop();
    await provider.stop();
  });

  describe("complete inbound call flow", () => {
    it("handles full inbound call: connect -> audio -> TTS response -> hangup", async () => {
      // Track events
      const events: Array<{ type: string; data: unknown }> = [];
      provider.on("callStarted", (d) => events.push({ type: "callStarted", data: d }));
      provider.on("callEnded", (d) => events.push({ type: "callEnded", data: d }));

      // 1. Gateway connects and starts inbound call
      await mockGateway.connect();
      await mockGateway.simulateInboundCall("int-inbound-001", {
        displayName: "Integration Tester",
      });

      await sleep(100);

      // Verify call started
      expect(events.find((e) => e.type === "callStarted")).toBeDefined();
      expect(bridge.getSession("int-inbound-001")).toBeDefined();

      // 2. Send audio from user (simulating speech)
      const userAudio = generateTone(16000, 200, 440); // 200ms of audio
      await mockGateway.streamAudio("int-inbound-001", userAudio);

      await sleep(100);

      // Verify audio was received
      const session = bridge.getSession("int-inbound-001");
      expect(session?.audioFramesReceived).toBeGreaterThan(0);

      // 3. Trigger TTS response
      await provider.playTts({
        callId: "int-inbound-001",
        text: "Hello, I received your message!",
      });

      await sleep(200);

      // Verify TTS audio was sent back to gateway
      const audioFrames = mockGateway.getReceivedAudioFrames("int-inbound-001");
      expect(audioFrames.length).toBeGreaterThan(0);

      // Verify frames are 640 bytes (16kHz, 20ms), except last frame which may be smaller
      for (let i = 0; i < audioFrames.length; i++) {
        const frame = audioFrames[i];
        if (i < audioFrames.length - 1) {
          expect(frame.length).toBe(640);
        } else {
          // Last frame can be <= 640 bytes
          expect(frame.length).toBeLessThanOrEqual(640);
          expect(frame.length).toBeGreaterThan(0);
        }
      }

      // 4. End call from user
      await mockGateway.simulateHangup("int-inbound-001", "hangup-user");

      await sleep(100);

      // Verify call ended
      expect(events.find((e) => e.type === "callEnded")).toBeDefined();
      expect(bridge.getSession("int-inbound-001")).toBeUndefined();
    });

    it("handles bot-initiated hangup", async () => {
      await mockGateway.connect();
      await mockGateway.simulateInboundCall("int-inbound-002");

      await sleep(100);

      // Bot ends the call
      await provider.hangupCall({ callId: "int-inbound-002" });

      await sleep(100);

      // Verify hangup was sent to gateway
      mockGateway.assertReceivedHangup("int-inbound-002");
    });
  });

  describe("complete outbound call flow", () => {
    it("handles full outbound call: initiate -> answered -> speak -> hangup", async () => {
      const events: Array<{ type: string; data: unknown }> = [];
      provider.on("callStarted", (d) => events.push({ type: "callStarted", data: d }));
      provider.on("callEnded", (d) => events.push({ type: "callEnded", data: d }));

      // 1. Gateway must be connected first
      await mockGateway.connect();

      // 2. Initiate outbound call
      const callPromise = provider.initiateCall({
        callId: "int-outbound-001",
        to: "user:target-aad-id",
        message: "Hello, this is an automated call",
      });

      // 3. Simulate gateway answering the call
      await mockGateway.simulateCallAnswered("int-outbound-001");

      // 3. Wait for call to be established
      const result = await callPromise;
      expect(result.status).toBe("answered");
      expect(result.callId).toBe("int-outbound-001");

      await sleep(100);

      // Verify session exists
      const session = bridge.getSession("int-outbound-001");
      expect(session).toBeDefined();
      expect(session?.direction).toBe("outbound");

      // 4. Speak on the call
      await provider.playTts({
        callId: "int-outbound-001",
        text: "Do you have any questions?",
      });

      await sleep(200);

      // Verify audio was sent
      const audioFrames = mockGateway.getReceivedAudioFrames("int-outbound-001");
      expect(audioFrames.length).toBeGreaterThan(0);

      // 5. End the call
      await provider.hangupCall({ callId: "int-outbound-001" });

      await sleep(100);

      mockGateway.assertReceivedHangup("int-outbound-001");
    });

    it("handles outbound call failure gracefully", async () => {
      // Gateway must be connected first
      await mockGateway.connect();

      const callPromise = provider.initiateCall({
        callId: "int-outbound-002",
        to: "user:unavailable-user",
      });

      await mockGateway.simulateCallFailed("int-outbound-002", "User unavailable");

      const result = await callPromise;
      expect(result.status).toBe("failed");
      expect(result.error).toContain("unavailable");
    });
  });

  describe("multiple concurrent calls", () => {
    it("handles multiple simultaneous inbound calls", async () => {
      await mockGateway.connect();

      // Start 3 calls
      await Promise.all([
        mockGateway.simulateInboundCall("int-multi-001", { displayName: "User 1" }),
        mockGateway.simulateInboundCall("int-multi-002", { displayName: "User 2" }),
        mockGateway.simulateInboundCall("int-multi-003", { displayName: "User 3" }),
      ]);

      await sleep(200);

      // Verify all sessions exist
      expect(provider.getActiveCallCount()).toBe(3);
      expect(provider.getSession("int-multi-001")).toBeDefined();
      expect(provider.getSession("int-multi-002")).toBeDefined();
      expect(provider.getSession("int-multi-003")).toBeDefined();

      // Send audio to each
      const testAudio = generateTone(16000, 40, 440); // 2 frames
      await Promise.all([
        mockGateway.streamAudio("int-multi-001", testAudio),
        mockGateway.streamAudio("int-multi-002", testAudio),
        mockGateway.streamAudio("int-multi-003", testAudio),
      ]);

      await sleep(100);

      // Verify each received audio
      expect(provider.getSession("int-multi-001")?.audioFramesReceived).toBeGreaterThan(0);
      expect(provider.getSession("int-multi-002")?.audioFramesReceived).toBeGreaterThan(0);
      expect(provider.getSession("int-multi-003")?.audioFramesReceived).toBeGreaterThan(0);

      // End all calls
      await Promise.all([
        mockGateway.simulateHangup("int-multi-001", "hangup-user"),
        mockGateway.simulateHangup("int-multi-002", "hangup-user"),
        mockGateway.simulateHangup("int-multi-003", "hangup-user"),
      ]);

      await sleep(100);

      expect(provider.getActiveCallCount()).toBe(0);
    });

    it("isolates audio between calls", async () => {
      await mockGateway.connect();

      await mockGateway.simulateInboundCall("int-isolate-001");
      await mockGateway.simulateInboundCall("int-isolate-002");

      await sleep(100);

      // Speak on call 1 only
      await provider.playTts({
        callId: "int-isolate-001",
        text: "Message for call 1",
      });

      await sleep(200);

      // Verify audio only went to call 1
      const frames1 = mockGateway.getReceivedAudioFrames("int-isolate-001");
      const frames2 = mockGateway.getReceivedAudioFrames("int-isolate-002");

      expect(frames1.length).toBeGreaterThan(0);
      expect(frames2.length).toBe(0);
    });
  });

  describe("audio format conversion", () => {
    it("correctly resamples 16kHz input to 24kHz for STT", async () => {
      // Track STT input
      const sttInputs: Buffer[] = [];
      bridge.onSTTInput((callId, audio) => {
        if (callId === "int-format-001") {
          sttInputs.push(audio);
        }
      });

      await mockGateway.connect();
      await mockGateway.simulateInboundCall("int-format-001");

      await sleep(100);

      // Send 16kHz audio (640 bytes = 20ms)
      const frame16k = generateTone(16000, 20, 440);
      expect(frame16k.length).toBe(640);

      await mockGateway.sendAudioFrame("int-format-001", frame16k);

      await sleep(100);

      // Verify STT received 24kHz (960 bytes = 20ms)
      expect(sttInputs.length).toBeGreaterThan(0);
      expect(sttInputs[0].length).toBe(960);
    });

    it("correctly resamples 24kHz TTS output to 16kHz for Teams", async () => {
      await mockGateway.connect();
      await mockGateway.simulateInboundCall("int-format-002");

      await sleep(100);

      // Speak (TTS returns 24kHz)
      await provider.playTts({
        callId: "int-format-002",
        text: "Test",
      });

      await sleep(200);

      // Verify gateway received 16kHz frames (640 bytes each)
      const frames = mockGateway.getReceivedAudioFrames("int-format-002");
      expect(frames.length).toBeGreaterThan(0);
      for (const frame of frames) {
        expect(frame.length).toBe(640);
      }
    });
  });

  describe("error handling", () => {
    it("recovers from gateway disconnect", async () => {
      const endedEvents: unknown[] = [];
      provider.on("callEnded", (d) => endedEvents.push(d));

      await mockGateway.connect();
      await mockGateway.simulateInboundCall("int-disconnect-001");

      await sleep(100);
      expect(provider.getActiveCallCount()).toBe(1);

      // Abruptly disconnect gateway
      await mockGateway.stop();

      await sleep(200);

      // Call should be ended with error
      expect(endedEvents.length).toBe(1);
      expect((endedEvents[0] as { reason: string }).reason).toBe("error");
      expect(provider.getActiveCallCount()).toBe(0);
    });

    it("handles TTS on non-existent call", async () => {
      await expect(
        provider.playTts({
          callId: "non-existent-call",
          text: "Hello",
        }),
      ).rejects.toThrow("No session");
    });
  });

  describe("event ordering", () => {
    it("emits events in correct order for inbound call", async () => {
      const eventOrder: string[] = [];
      provider.on("callStarted", () => eventOrder.push("callStarted"));
      provider.on("callEnded", () => eventOrder.push("callEnded"));

      await mockGateway.connect();
      await mockGateway.simulateInboundCall("int-order-001");
      await sleep(100);
      await mockGateway.simulateHangup("int-order-001", "hangup-user");
      await sleep(100);

      expect(eventOrder).toEqual(["callStarted", "callEnded"]);
    });
  });
});

/** Helper to wait for async operations */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
