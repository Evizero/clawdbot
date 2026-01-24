import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockTeamsBridge, createTestMockBridge } from "../mock-bridge.js";
import { TeamsAudioBridge } from "../bridge.js";
import { generateTone } from "../audio-utils.js";

const TEST_PORT = 13338;
const TEST_SECRET = "test-secret-12345678901234567890123456789012";

describe("MockTeamsBridge", () => {
  let bridge: TeamsAudioBridge;
  let mockBridge: MockTeamsBridge;

  beforeEach(async () => {
    // Start the real bridge server
    bridge = new TeamsAudioBridge({
      port: TEST_PORT,
      secret: TEST_SECRET,
    });
    await bridge.start();

    // Create mock bridge (WebSocket client)
    mockBridge = createTestMockBridge(TEST_PORT, { secret: TEST_SECRET });
  });

  afterEach(async () => {
    await mockBridge.stop();
    await bridge.stop();
  });

  describe("connection", () => {
    it("connects with valid secret", async () => {
      await mockBridge.connect();
      expect(mockBridge.isConnected()).toBe(true);
    });

    it("fails with invalid secret", async () => {
      const badMock = new MockTeamsBridge({
        port: TEST_PORT,
        secret: "wrong-secret-that-is-long-enough-to-pass",
      });

      await expect(badMock.connect()).rejects.toThrow();
      await badMock.stop();
    });

    it("isConnected returns false before connect", () => {
      expect(mockBridge.isConnected()).toBe(false);
    });

    it("isConnected returns false after stop", async () => {
      await mockBridge.connect();
      expect(mockBridge.isConnected()).toBe(true);

      await mockBridge.stop();
      expect(mockBridge.isConnected()).toBe(false);
    });
  });

  describe("simulateInboundCall", () => {
    it("sends session_start message", async () => {
      await mockBridge.connect();
      await mockBridge.simulateInboundCall("mock-001", {
        displayName: "Test User",
      });

      await sleep(100);

      // Verify message was sent
      const sent = mockBridge.getSentMessagesForCall("mock-001");
      expect(sent.length).toBeGreaterThan(0);
      expect(sent[0].type).toBe("session_start");
    });

    it("creates session on bridge", async () => {
      await mockBridge.connect();
      await mockBridge.simulateInboundCall("mock-002");

      await sleep(100);

      const session = bridge.getSession("mock-002");
      expect(session).toBeDefined();
      expect(session?.direction).toBe("inbound");
    });
  });

  describe("simulateCallAnswered", () => {
    it("sends ringing, answered, and session_start", async () => {
      await mockBridge.connect();
      await mockBridge.simulateCallAnswered("mock-answered-001");

      await sleep(100);

      const sent = mockBridge.getSentMessagesForCall("mock-answered-001");
      const types = sent.map((m) => m.type);
      expect(types).toContain("call_status");
      expect(types).toContain("session_start");
    });
  });

  describe("simulateCallFailed", () => {
    it("sends failed status with error", async () => {
      await mockBridge.connect();
      await mockBridge.simulateCallFailed("mock-fail-001", "User busy");

      await sleep(100);

      const sent = mockBridge.getSentMessagesForCall("mock-fail-001");
      expect(sent.length).toBeGreaterThan(0);
      expect(sent[0].type).toBe("call_status");
      expect((sent[0].data as { status: string }).status).toBe("failed");
    });
  });

  describe("streamAudio", () => {
    it("splits buffer into 640-byte frames", async () => {
      await mockBridge.connect();
      await mockBridge.simulateInboundCall("mock-audio-001");

      await sleep(100);

      // 200ms of 16kHz audio = 6400 bytes = 10 frames
      const audio = generateTone(16000, 200, 440);
      await mockBridge.streamAudio("mock-audio-001", audio);

      await sleep(100);

      const sent = mockBridge.getSentMessagesForCall("mock-audio-001");
      const audioFrames = sent.filter((m) => m.type === "audio_in");
      expect(audioFrames.length).toBe(10);
    });

    it("increments sequence numbers", async () => {
      await mockBridge.connect();
      await mockBridge.simulateInboundCall("mock-audio-002");

      await sleep(100);

      const audio = generateTone(16000, 60, 440); // 3 frames
      await mockBridge.streamAudio("mock-audio-002", audio);

      await sleep(100);

      const sent = mockBridge.getSentMessagesForCall("mock-audio-002");
      const audioFrames = sent.filter((m) => m.type === "audio_in");
      const seqs = audioFrames.map((m) => (m.data as { seq: number }).seq);
      expect(seqs).toEqual([0, 1, 2]);
    });

    it("continues sequence across multiple streamAudio calls", async () => {
      await mockBridge.connect();
      await mockBridge.simulateInboundCall("mock-audio-003");

      await sleep(100);

      const audio = generateTone(16000, 40, 440); // 2 frames
      await mockBridge.streamAudio("mock-audio-003", audio);
      await mockBridge.streamAudio("mock-audio-003", audio);

      await sleep(100);

      const sent = mockBridge.getSentMessagesForCall("mock-audio-003");
      const audioFrames = sent.filter((m) => m.type === "audio_in");
      const seqs = audioFrames.map((m) => (m.data as { seq: number }).seq);
      expect(seqs).toEqual([0, 1, 2, 3]);
    });
  });

  describe("simulateHangup", () => {
    it("sends session_end message", async () => {
      await mockBridge.connect();
      await mockBridge.simulateInboundCall("mock-hangup-001");

      await sleep(100);

      await mockBridge.simulateHangup("mock-hangup-001", "hangup-user");

      await sleep(100);

      const sent = mockBridge.getSentMessagesForCall("mock-hangup-001");
      const endMsg = sent.find((m) => m.type === "session_end");
      expect(endMsg).toBeDefined();
      expect((endMsg?.data as { reason: string }).reason).toBe("hangup-user");
    });

    it("cleans up session on bridge", async () => {
      await mockBridge.connect();
      await mockBridge.simulateInboundCall("mock-hangup-002");

      await sleep(100);
      expect(bridge.getSession("mock-hangup-002")).toBeDefined();

      await mockBridge.simulateHangup("mock-hangup-002", "hangup-user");

      await sleep(100);
      expect(bridge.getSession("mock-hangup-002")).toBeUndefined();
    });
  });

  describe("assertion helpers", () => {
    it("assertReceivedAudioOut works", async () => {
      await mockBridge.connect();
      await mockBridge.simulateInboundCall("mock-assert-001");

      await sleep(100);

      // Set up mock TTS to send audio
      bridge.setMockTTS(async () => Buffer.alloc(960 * 5)); // 5 frames at 24kHz

      await bridge.speak("mock-assert-001", "Test");

      await sleep(200);

      // Should not throw
      mockBridge.assertReceivedAudioOut("mock-assert-001", 1);

      // Should throw for too many frames
      expect(() => {
        mockBridge.assertReceivedAudioOut("mock-assert-001", 100);
      }).toThrow();
    });

    it("assertReceivedHangup works", async () => {
      await mockBridge.connect();
      await mockBridge.simulateInboundCall("mock-assert-002");

      await sleep(100);

      // Should throw before hangup
      expect(() => {
        mockBridge.assertReceivedHangup("mock-assert-002");
      }).toThrow();

      await bridge.endCall("mock-assert-002");

      await sleep(100);

      // Should not throw after hangup
      mockBridge.assertReceivedHangup("mock-assert-002");
    });

    it("getReceivedAudioFrames returns decoded buffers", async () => {
      await mockBridge.connect();
      await mockBridge.simulateInboundCall("mock-assert-003");

      await sleep(100);

      bridge.setMockTTS(async () => Buffer.alloc(960 * 3));

      await bridge.speak("mock-assert-003", "Test");

      await sleep(200);

      const frames = mockBridge.getReceivedAudioFrames("mock-assert-003");
      expect(frames.length).toBeGreaterThan(0);
      expect(frames[0]).toBeInstanceOf(Buffer);
    });
  });

  describe("waitForMessage", () => {
    it("resolves when message is received", async () => {
      await mockBridge.connect();

      // Set up mock TTS
      bridge.setMockTTS(async () => Buffer.alloc(960));

      await mockBridge.simulateInboundCall("mock-wait-001");

      // Wait for session to be created
      await sleep(100);

      // Start speaking which will trigger audio_out
      await bridge.speak("mock-wait-001", "Test");

      // Wait for audio_out message
      const msg = await mockBridge.waitForMessage("mock-wait-001", "audio_out", 2000);
      expect(msg.type).toBe("audio_out");
    });

    it("times out if message not received", async () => {
      await mockBridge.connect();
      await mockBridge.simulateInboundCall("mock-wait-002");

      await expect(
        mockBridge.waitForMessage("mock-wait-002", "audio_out", 100),
      ).rejects.toThrow("Timeout");
    });
  });

  describe("clearMessages", () => {
    it("clears sent and received messages", async () => {
      await mockBridge.connect();
      await mockBridge.simulateInboundCall("mock-clear-001");

      await sleep(100);

      expect(mockBridge.sentMessages.length).toBeGreaterThan(0);

      mockBridge.clearMessages();

      expect(mockBridge.sentMessages.length).toBe(0);
      expect(mockBridge.receivedMessages.length).toBe(0);
    });
  });

  describe("createTestMockBridge helper", () => {
    it("creates mock with default test config", async () => {
      const testMock = createTestMockBridge(TEST_PORT);
      expect(testMock).toBeInstanceOf(MockTeamsBridge);
      await testMock.stop();
    });

    it("allows config overrides", async () => {
      const testMock = createTestMockBridge(TEST_PORT, {
        responseDelay: 50,
      });
      // Just verify it doesn't throw
      await testMock.stop();
    });
  });
});

/** Helper to wait for async operations */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
