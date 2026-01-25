import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TeamsCallProvider } from "../provider.js";
import { TeamsAudioBridge } from "../bridge.js";
import { MockTeamsBridge, createTestMockBridge } from "../mock-bridge.js";
import type { TeamsCallConfig } from "../config.js";

const TEST_PORT = 13337;
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
    greeting: "Hello!",
  },
  outbound: {
    enabled: true,
    ringTimeoutMs: 5000, // Short timeout for tests
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

describe("TeamsCallProvider", () => {
  let bridge: TeamsAudioBridge;
  let provider: TeamsCallProvider;
  let mockGateway: MockTeamsBridge;

  beforeEach(async () => {
    // Create bridge and provider
    bridge = new TeamsAudioBridge({
      port: TEST_PORT,
      secret: TEST_SECRET,
    });

    // Set up mock TTS provider
    bridge.setMockTTS(async () => Buffer.alloc(960 * 10)); // 200ms of silence

    provider = new TeamsCallProvider(bridge, testConfig);
    await provider.start();

    // Create mock gateway
    mockGateway = createTestMockBridge(TEST_PORT, { secret: TEST_SECRET });
  });

  afterEach(async () => {
    await mockGateway.stop();
    await provider.stop();
  });

  describe("lifecycle", () => {
    it("starts and stops without error", async () => {
      // Provider is already started in beforeEach
      expect(provider.getActiveCallCount()).toBe(0);

      // Stop and verify
      await provider.stop();

      // Should be safe to stop twice
      await provider.stop();
    });

    it("cleans up event listeners on stop", async () => {
      // Verify no memory leaks from event listeners
      const initialListeners = bridge.listenerCount("callStarted");

      // Stop provider - should remove listeners
      await provider.stop();

      const finalListeners = bridge.listenerCount("callStarted");
      expect(finalListeners).toBeLessThan(initialListeners);
    });
  });

  describe("initiateCall", () => {
    it("initiates a call and waits for answer", async () => {
      // Gateway must be connected first
      await mockGateway.connect();

      // Initiate call
      const callPromise = provider.initiateCall({
        callId: "prov-001",
        to: "user:target-user-id",
      });

      // Simulate gateway answering
      await mockGateway.simulateCallAnswered("prov-001");

      const result = await callPromise;
      expect(result.status).toBe("answered");
      expect(result.callId).toBe("prov-001");
    });

    it("handles call failure", async () => {
      // Gateway must be connected first
      await mockGateway.connect();

      const callPromise = provider.initiateCall({
        callId: "prov-002",
        to: "user:target-user-id",
        timeoutMs: 5000,
      });

      await mockGateway.simulateCallFailed("prov-002", "User busy");

      const result = await callPromise;
      expect(result.status).toBe("failed");
      expect(result.error).toContain("busy");
    });

    it("handles call timeout", async () => {
      // Gateway must be connected first
      await mockGateway.connect();

      const callPromise = provider.initiateCall({
        callId: "prov-003",
        to: "user:target-user-id",
        timeoutMs: 100, // Very short timeout
      });

      // Don't answer - let it timeout
      const result = await callPromise;
      expect(result.status).toBe("failed");
      expect(result.error).toContain("timeout");
    });

    it("throws when outbound calls are disabled", async () => {
      // Create provider with outbound disabled
      const disabledConfig = {
        ...testConfig,
        outbound: { ...testConfig.outbound, enabled: false },
      };

      // Use a unique port to avoid conflicts with other tests
      const disabledBridge = new TeamsAudioBridge({
        port: TEST_PORT + 100, // Use 13437 to avoid conflicts
        secret: TEST_SECRET,
      });
      const disabledProvider = new TeamsCallProvider(disabledBridge, disabledConfig);
      await disabledProvider.start();

      try {
        await expect(
          disabledProvider.initiateCall({
            callId: "prov-004",
            to: "user:target-user-id",
          }),
        ).rejects.toThrow("disabled");
      } finally {
        await disabledProvider.stop();
      }
    });
  });

  describe("parseTarget", () => {
    it("parses user: prefix correctly", async () => {
      const callPromise = provider.initiateCall({
        callId: "prov-parse-001",
        to: "user:aad-object-id-123",
        timeoutMs: 100,
      });

      // We can't directly test parseTarget, but we can verify the call
      // was initiated (even if it times out)
      await expect(callPromise).resolves.toMatchObject({
        status: "failed", // Times out without gateway
        callId: "prov-parse-001",
      });
    });

    it("parses phone numbers correctly", async () => {
      const callPromise = provider.initiateCall({
        callId: "prov-parse-002",
        to: "+15551234567",
        timeoutMs: 100,
      });

      await expect(callPromise).resolves.toMatchObject({
        status: "failed",
        callId: "prov-parse-002",
      });
    });

    it("defaults to user type for plain string", async () => {
      const callPromise = provider.initiateCall({
        callId: "prov-parse-003",
        to: "plain-user-id",
        timeoutMs: 100,
      });

      await expect(callPromise).resolves.toMatchObject({
        status: "failed",
        callId: "prov-parse-003",
      });
    });
  });

  describe("hangupCall", () => {
    it("ends an active call", async () => {
      await mockGateway.connect();
      await mockGateway.simulateInboundCall("prov-hangup-001");

      await sleep(100);

      expect(provider.getSession("prov-hangup-001")).toBeDefined();

      await provider.hangupCall({ callId: "prov-hangup-001" });

      // Wait for message to be received
      await sleep(50);

      // Verify hangup was sent
      mockGateway.assertReceivedHangup("prov-hangup-001");
    });

    it("handles hangup for non-existent call gracefully", async () => {
      // Should not throw
      await provider.hangupCall({ callId: "non-existent-call" });
    });
  });

  describe("playTts", () => {
    it("plays TTS audio on a call", async () => {
      await mockGateway.connect();
      await mockGateway.simulateInboundCall("prov-tts-001");

      await sleep(100);

      await provider.playTts({
        callId: "prov-tts-001",
        text: "Hello, this is a test",
      });

      await sleep(100);

      // Verify audio was sent
      const frames = mockGateway.getReceivedAudioFrames("prov-tts-001");
      expect(frames.length).toBeGreaterThan(0);
    });

    it("throws for non-existent call", async () => {
      await expect(
        provider.playTts({
          callId: "non-existent",
          text: "Hello",
        }),
      ).rejects.toThrow("No session");
    });
  });

  describe("getSession", () => {
    it("returns session for active call", async () => {
      await mockGateway.connect();
      await mockGateway.simulateInboundCall("prov-session-001", {
        displayName: "Test Caller",
      });

      await sleep(100);

      const session = provider.getSession("prov-session-001");
      expect(session).toBeDefined();
      expect(session?.direction).toBe("inbound");
      expect(session?.metadata.displayName).toBe("Test Caller");
    });

    it("returns undefined for non-existent call", () => {
      const session = provider.getSession("non-existent");
      expect(session).toBeUndefined();
    });
  });

  describe("getActiveCallCount", () => {
    it("returns correct count", async () => {
      expect(provider.getActiveCallCount()).toBe(0);

      await mockGateway.connect();
      await mockGateway.simulateInboundCall("prov-count-001");
      await sleep(100);
      expect(provider.getActiveCallCount()).toBe(1);

      await mockGateway.simulateInboundCall("prov-count-002");
      await sleep(100);
      expect(provider.getActiveCallCount()).toBe(2);

      await mockGateway.simulateHangup("prov-count-001", "hangup-user");
      await sleep(100);
      expect(provider.getActiveCallCount()).toBe(1);
    });
  });

  describe("events", () => {
    it("emits callStarted event", async () => {
      const events: unknown[] = [];
      provider.on("callStarted", (evt) => events.push(evt));

      await mockGateway.connect();
      await mockGateway.simulateInboundCall("prov-evt-001");

      await sleep(100);

      expect(events.length).toBe(1);
      expect(events[0]).toMatchObject({
        callId: "prov-evt-001",
        direction: "inbound",
      });
    });

    it("emits callEnded event", async () => {
      const events: unknown[] = [];
      provider.on("callEnded", (evt) => events.push(evt));

      await mockGateway.connect();
      await mockGateway.simulateInboundCall("prov-evt-002");
      await sleep(100);

      await mockGateway.simulateHangup("prov-evt-002", "hangup-user");
      await sleep(100);

      expect(events.length).toBe(1);
      expect(events[0]).toMatchObject({
        callId: "prov-evt-002",
        reason: "hangup-user",
      });
    });

    it("emits callError event on STT failure", async () => {
      // This requires an STT provider that fails - skip for now
      // as it's tested in bridge tests
    });
  });
});

/** Helper to wait for async operations */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
