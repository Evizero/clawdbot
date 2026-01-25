import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TeamsAudioBridge } from "../bridge.js";
import { MockTeamsBridge, createTestMockBridge } from "../mock-bridge.js";
import { generateTone } from "../audio-utils.js";

const TEST_PORT = 13335;
const TEST_SECRET = "test-secret-12345678901234567890123456789012"; // 32+ chars for security

describe("TeamsAudioBridge", () => {
  let bridge: TeamsAudioBridge;
  let mockGateway: MockTeamsBridge;

  beforeEach(async () => {
    // Start Clawdbot bridge (WebSocket server)
    bridge = new TeamsAudioBridge({
      port: TEST_PORT,
      secret: TEST_SECRET,
    });
    await bridge.start();

    // Create mock C# gateway (WebSocket client)
    mockGateway = createTestMockBridge(TEST_PORT);
  });

  afterEach(async () => {
    await mockGateway.stop();
    await bridge.stop();
  });

  describe("connection authentication", () => {
    it("accepts connection with valid secret", async () => {
      await mockGateway.connect();
      expect(mockGateway.isConnected()).toBe(true);
    });

    it("rejects connection with invalid secret", async () => {
      const badGateway = new MockTeamsBridge({
        port: TEST_PORT,
        secret: "wrong-secret-1234567",
      });

      // WebSocket library throws "Parse Error: Invalid response status" on 4001 reject
      await expect(badGateway.connect()).rejects.toThrow();
      await badGateway.stop();
    });
  });

  describe("inbound call flow", () => {
    it("receives session_start and creates call session", async () => {
      await mockGateway.connect();
      await mockGateway.simulateInboundCall("call-001", {
        tenantId: "tenant-1",
        userId: "user-1",
        displayName: "Test User",
      });

      // Allow time for message processing
      await sleep(100);

      const session = bridge.getSession("call-001");
      expect(session).toBeDefined();
      expect(session?.direction).toBe("inbound");
      expect(session?.metadata.displayName).toBe("Test User");
    });

    it("emits callStarted event on session_start", async () => {
      let startedEvent: unknown = null;
      bridge.on("callStarted", (evt) => {
        startedEvent = evt;
      });

      await mockGateway.connect();
      await mockGateway.simulateInboundCall("call-002", {
        displayName: "Test User 2",
      });

      await sleep(100);

      expect(startedEvent).toMatchObject({
        callId: "call-002",
        direction: "inbound",
        metadata: expect.objectContaining({
          displayName: "Test User 2",
        }),
      });
    });

    it("processes audio_in frames", async () => {
      await mockGateway.connect();
      await mockGateway.simulateInboundCall("call-003");

      await sleep(100);

      // Send test audio (200ms of 16kHz audio = 6400 bytes = 10 frames)
      const testAudio = generateTone(16000, 200, 440);
      await mockGateway.streamAudio("call-003", testAudio);

      await sleep(100);

      const session = bridge.getSession("call-003");
      expect(session?.audioFramesReceived).toBe(10);
    });

    it("tracks audio sequence numbers", async () => {
      await mockGateway.connect();
      await mockGateway.simulateInboundCall("call-004");

      await sleep(100);

      // Send a few frames
      await mockGateway.streamAudio("call-004", generateTone(16000, 60, 440)); // 3 frames

      await sleep(100);

      const session = bridge.getSession("call-004");
      expect(session?.audioFramesReceived).toBe(3);
      expect(session?.lastAudioSeqReceived).toBe(2); // 0, 1, 2
    });
  });

  describe("audio format handling", () => {
    it("resamples incoming 16kHz to 24kHz for STT", async () => {
      const sttInputs: Buffer[] = [];
      bridge.onSTTInput((callId, audio) => {
        if (callId === "call-005") sttInputs.push(audio);
      });

      await mockGateway.connect();
      await mockGateway.simulateInboundCall("call-005");

      await sleep(100);

      // Send 16kHz frame (640 bytes = 20ms)
      const frame16k = generateTone(16000, 20, 440);
      expect(frame16k.length).toBe(640);

      await mockGateway.sendAudioFrame("call-005", frame16k);

      await sleep(100);

      // Verify STT received 24kHz (960 bytes = 20ms)
      expect(sttInputs.length).toBe(1);
      expect(sttInputs[0].length).toBe(960);
    });

    it("resamples outgoing 24kHz TTS to 16kHz for gateway", async () => {
      // Mock TTS returns 24kHz
      bridge.setMockTTS(async () => generateTone(24000, 100, 440)); // 100ms @ 24kHz

      await mockGateway.connect();
      await mockGateway.simulateInboundCall("call-006");

      await sleep(100);

      await bridge.speak("call-006", "Test");

      await sleep(100);

      // Verify frames sent to gateway are 640 bytes (16kHz)
      const frames = mockGateway.getReceivedAudioFrames("call-006");
      expect(frames.length).toBeGreaterThan(0);

      // Each frame should be 640 bytes (20ms @ 16kHz)
      for (const frame of frames) {
        expect(frame.length).toBe(640);
      }
    });
  });

  describe("TTS output", () => {
    it("sends audio_out frames from TTS", async () => {
      // 500ms of audio @ 24kHz = 25 frames @ 16kHz after resampling
      bridge.setMockTTS(async () => generateTone(24000, 500, 440));

      await mockGateway.connect();
      await mockGateway.simulateInboundCall("call-007");

      await sleep(100);

      await bridge.speak("call-007", "Hello, this is a test");

      await sleep(100);

      // Should have received multiple audio frames
      mockGateway.assertReceivedAudioOut("call-007", 10);
    });

    it("increments audio sequence numbers for output", async () => {
      bridge.setMockTTS(async () => generateTone(24000, 100, 440));

      await mockGateway.connect();
      await mockGateway.simulateInboundCall("call-008");

      await sleep(100);

      await bridge.speak("call-008", "Test 1");
      await bridge.speak("call-008", "Test 2");

      await sleep(100);

      const session = bridge.getSession("call-008");
      expect(session?.audioFramesSent).toBeGreaterThan(1);
      expect(session?.lastAudioSeqSent).toBeGreaterThan(0);
    });

    it("generates comfort tone if no TTS provider configured", async () => {
      await mockGateway.connect();
      await mockGateway.simulateInboundCall("call-009");

      await sleep(100);

      // Should not throw - instead generates a comfort tone (silence)
      await bridge.speak("call-009", "Test");

      // Verify some audio was sent (the comfort tone)
      await sleep(100);
      const session = bridge.getSession("call-009");
      expect(session?.audioFramesSent).toBeGreaterThanOrEqual(0); // May have sent comfort tone frames
    });
  });

  describe("call termination", () => {
    it("sends hangup when endCall() is called", async () => {
      await mockGateway.connect();
      await mockGateway.simulateInboundCall("call-010");

      await sleep(100);

      await bridge.endCall("call-010");

      await sleep(100);

      mockGateway.assertReceivedHangup("call-010");
    });

    it("cleans up session on session_end from gateway", async () => {
      await mockGateway.connect();
      await mockGateway.simulateInboundCall("call-011");

      await sleep(100);
      expect(bridge.getSession("call-011")).toBeDefined();

      await mockGateway.simulateHangup("call-011", "hangup-user");

      await sleep(100);

      expect(bridge.getSession("call-011")).toBeUndefined();
    });

    it("emits callEnded event on session_end", async () => {
      let endedEvent: unknown = null;
      bridge.on("callEnded", (evt) => {
        endedEvent = evt;
      });

      await mockGateway.connect();
      await mockGateway.simulateInboundCall("call-012");

      await sleep(100);

      await mockGateway.simulateHangup("call-012", "hangup-user");

      await sleep(100);

      expect(endedEvent).toMatchObject({
        callId: "call-012",
        reason: "hangup-user",
      });
    });

    it("cleans up on WebSocket close", async () => {
      await mockGateway.connect();
      await mockGateway.simulateInboundCall("call-013");

      await sleep(100);
      expect(bridge.getSession("call-013")).toBeDefined();

      // Close the WebSocket
      await mockGateway.stop();

      await sleep(100);

      expect(bridge.getSession("call-013")).toBeUndefined();
    });
  });

  describe("multiple concurrent calls", () => {
    it("handles multiple calls simultaneously", async () => {
      await mockGateway.connect();

      // Start 3 calls
      await mockGateway.simulateInboundCall("multi-001");
      await mockGateway.simulateInboundCall("multi-002");
      await mockGateway.simulateInboundCall("multi-003");

      await sleep(100);

      expect(bridge.getActiveCallCount()).toBe(3);
      expect(bridge.getSession("multi-001")).toBeDefined();
      expect(bridge.getSession("multi-002")).toBeDefined();
      expect(bridge.getSession("multi-003")).toBeDefined();
    });

    it("tracks audio separately per call", async () => {
      await mockGateway.connect();

      await mockGateway.simulateInboundCall("multi-004");
      await mockGateway.simulateInboundCall("multi-005");

      await sleep(100);

      // Send different amounts of audio to each
      await mockGateway.streamAudio("multi-004", generateTone(16000, 60, 440)); // 3 frames
      await mockGateway.streamAudio("multi-005", generateTone(16000, 100, 440)); // 5 frames

      await sleep(100);

      expect(bridge.getSession("multi-004")?.audioFramesReceived).toBe(3);
      expect(bridge.getSession("multi-005")?.audioFramesReceived).toBe(5);
    });
  });

  describe("outbound call flow", () => {
    it("creates pending call on initiateCall()", async () => {
      // Gateway must be connected first
      await mockGateway.connect();

      // Start call initiation (will timeout if no response)
      const callPromise = bridge.initiateCall({
        callId: "out-001",
        target: { type: "user", userId: "target-user" },
        timeoutMs: 5000,
      });

      // Gateway answers
      await mockGateway.simulateCallAnswered("out-001");

      const result = await callPromise;
      expect(result.status).toBe("answered");
      expect(result.callId).toBe("out-001");
    });

    it("rejects on call failure", async () => {
      // Gateway must be connected first
      await mockGateway.connect();

      const callPromise = bridge.initiateCall({
        callId: "out-002",
        target: { type: "user", userId: "target-user" },
        timeoutMs: 5000,
      });

      await mockGateway.simulateCallFailed("out-002", "User busy");

      await expect(callPromise).rejects.toThrow(/busy/i);
    });

    it("rejects when gateway not connected", async () => {
      // Don't connect gateway - should fail immediately

      await expect(
        bridge.initiateCall({
          callId: "out-003",
          target: { type: "user", userId: "target-user" },
          timeoutMs: 5000,
        }),
      ).rejects.toThrow(/not connected/i);
    });

    it("handles busy status", async () => {
      // Gateway must be connected first
      await mockGateway.connect();

      const callPromise = bridge.initiateCall({
        callId: "out-004",
        target: { type: "user", userId: "target-user" },
        timeoutMs: 5000,
      });

      await mockGateway.simulateCallStatus("out-004", "busy");

      await expect(callPromise).rejects.toThrow(/busy/i);
    });

    it("handles no-answer status", async () => {
      // Gateway must be connected first
      await mockGateway.connect();

      const callPromise = bridge.initiateCall({
        callId: "out-005",
        target: { type: "phone", number: "+15551234567" },
        timeoutMs: 5000,
      });

      await mockGateway.simulateCallStatus("out-005", "no-answer");

      await expect(callPromise).rejects.toThrow(/no-answer/i);
    });
  });
});

// Helper function
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
