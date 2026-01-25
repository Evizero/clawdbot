import { describe, it, expect } from "vitest";
import {
  parseInboundMessage,
  serializeOutboundMessage,
  MessageParseError,
  buildInitiateCall,
  buildAudioOut,
  buildHangup,
  buildPong,
  decodeAudioData,
  validateTeamsAudioFrame,
} from "../bridge-messages.js";
import type {
  SessionStartMessage,
  CallStatusMessage,
  AudioInMessage,
  SessionEndMessage,
  SessionResumeMessage,
  PingMessage,
  PongMessage,
  AudioOutMessage,
  HangupMessage,
  InitiateCallMessage,
} from "../types.js";

describe("parseInboundMessage", () => {
  describe("session_start", () => {
    it("parses valid inbound session_start message", () => {
      const raw = JSON.stringify({
        type: "session_start",
        callId: "test-123",
        direction: "inbound",
        metadata: {
          tenantId: "tenant-abc",
          userId: "user-xyz",
          teamsCallId: "teams-call-456",
          displayName: "John Doe",
          userPrincipalName: "john@contoso.com",
        },
      });

      const msg = parseInboundMessage(raw) as SessionStartMessage;

      expect(msg.type).toBe("session_start");
      expect(msg.callId).toBe("test-123");
      expect(msg.direction).toBe("inbound");
      expect(msg.metadata.tenantId).toBe("tenant-abc");
      expect(msg.metadata.userId).toBe("user-xyz");
      expect(msg.metadata.teamsCallId).toBe("teams-call-456");
      expect(msg.metadata.displayName).toBe("John Doe");
      expect(msg.metadata.userPrincipalName).toBe("john@contoso.com");
    });

    it("parses outbound session_start message", () => {
      const raw = JSON.stringify({
        type: "session_start",
        callId: "test-456",
        direction: "outbound",
        metadata: {
          tenantId: "tenant-abc",
          userId: "user-xyz",
          teamsCallId: "teams-call-789",
        },
      });

      const msg = parseInboundMessage(raw) as SessionStartMessage;

      expect(msg.type).toBe("session_start");
      expect(msg.direction).toBe("outbound");
      expect(msg.metadata.displayName).toBeUndefined();
    });

    it("parses session_start with phoneNumber for PSTN calls", () => {
      const raw = JSON.stringify({
        type: "session_start",
        callId: "test-pstn",
        direction: "inbound",
        metadata: {
          tenantId: "tenant-abc",
          userId: "user-xyz",
          teamsCallId: "teams-call-pstn",
          phoneNumber: "+15551234567",
        },
      });

      const msg = parseInboundMessage(raw) as SessionStartMessage;

      expect(msg.type).toBe("session_start");
      expect(msg.metadata.phoneNumber).toBe("+15551234567");
    });

    it("parses session_start without phoneNumber", () => {
      const raw = JSON.stringify({
        type: "session_start",
        callId: "test-teams",
        direction: "inbound",
        metadata: {
          tenantId: "tenant-abc",
          userId: "user-xyz",
          teamsCallId: "teams-call-teams",
        },
      });

      const msg = parseInboundMessage(raw) as SessionStartMessage;

      expect(msg.metadata.phoneNumber).toBeUndefined();
    });

    it("throws on missing metadata", () => {
      const raw = JSON.stringify({
        type: "session_start",
        callId: "test-123",
        direction: "inbound",
      });

      expect(() => parseInboundMessage(raw)).toThrow(MessageParseError);
      expect(() => parseInboundMessage(raw)).toThrow(/metadata/i);
    });

    it("throws on invalid direction", () => {
      const raw = JSON.stringify({
        type: "session_start",
        callId: "test-123",
        direction: "invalid",
        metadata: {
          tenantId: "t",
          userId: "u",
          teamsCallId: "c",
        },
      });

      expect(() => parseInboundMessage(raw)).toThrow(/direction/i);
    });
  });

  describe("call_status", () => {
    it("parses call_status with ringing", () => {
      const raw = JSON.stringify({
        type: "call_status",
        callId: "test-123",
        status: "ringing",
      });

      const msg = parseInboundMessage(raw) as CallStatusMessage;

      expect(msg.type).toBe("call_status");
      expect(msg.callId).toBe("test-123");
      expect(msg.status).toBe("ringing");
      expect(msg.error).toBeUndefined();
    });

    it("parses call_status with answered", () => {
      const raw = JSON.stringify({
        type: "call_status",
        callId: "test-123",
        status: "answered",
      });

      const msg = parseInboundMessage(raw) as CallStatusMessage;
      expect(msg.status).toBe("answered");
    });

    it("parses call_status with failed and error", () => {
      const raw = JSON.stringify({
        type: "call_status",
        callId: "test-123",
        status: "failed",
        error: "User declined the call",
      });

      const msg = parseInboundMessage(raw) as CallStatusMessage;

      expect(msg.status).toBe("failed");
      expect(msg.error).toBe("User declined the call");
    });

    it("parses call_status with busy", () => {
      const raw = JSON.stringify({
        type: "call_status",
        callId: "test-123",
        status: "busy",
      });

      const msg = parseInboundMessage(raw) as CallStatusMessage;
      expect(msg.status).toBe("busy");
    });

    it("parses call_status with no-answer", () => {
      const raw = JSON.stringify({
        type: "call_status",
        callId: "test-123",
        status: "no-answer",
      });

      const msg = parseInboundMessage(raw) as CallStatusMessage;
      expect(msg.status).toBe("no-answer");
    });

    it("throws on invalid status", () => {
      const raw = JSON.stringify({
        type: "call_status",
        callId: "test-123",
        status: "unknown-status",
      });

      expect(() => parseInboundMessage(raw)).toThrow(/status/i);
    });
  });

  describe("audio_in", () => {
    it("parses audio_in message", () => {
      const audioData = Buffer.alloc(640).toString("base64");
      const raw = JSON.stringify({
        type: "audio_in",
        callId: "test-123",
        seq: 42,
        data: audioData,
      });

      const msg = parseInboundMessage(raw) as AudioInMessage;

      expect(msg.type).toBe("audio_in");
      expect(msg.callId).toBe("test-123");
      expect(msg.seq).toBe(42);
      expect(msg.data).toBe(audioData);
    });

    it("handles large sequence numbers", () => {
      const raw = JSON.stringify({
        type: "audio_in",
        callId: "test-123",
        seq: 9007199254740991, // Max safe integer
        data: "AAAA",
      });

      const msg = parseInboundMessage(raw) as AudioInMessage;
      expect(msg.seq).toBe(9007199254740991);
    });

    it("throws on missing seq", () => {
      const raw = JSON.stringify({
        type: "audio_in",
        callId: "test-123",
        data: "AAAA",
      });

      expect(() => parseInboundMessage(raw)).toThrow(/seq/i);
    });

    it("throws on missing data", () => {
      const raw = JSON.stringify({
        type: "audio_in",
        callId: "test-123",
        seq: 0,
      });

      expect(() => parseInboundMessage(raw)).toThrow(/data/i);
    });
  });

  describe("session_end", () => {
    it("parses session_end with hangup-user", () => {
      const raw = JSON.stringify({
        type: "session_end",
        callId: "test-123",
        reason: "hangup-user",
      });

      const msg = parseInboundMessage(raw) as SessionEndMessage;

      expect(msg.type).toBe("session_end");
      expect(msg.callId).toBe("test-123");
      expect(msg.reason).toBe("hangup-user");
    });

    it("parses session_end with hangup-bot", () => {
      const raw = JSON.stringify({
        type: "session_end",
        callId: "test-123",
        reason: "hangup-bot",
      });

      const msg = parseInboundMessage(raw) as SessionEndMessage;
      expect(msg.reason).toBe("hangup-bot");
    });

    it("parses session_end with error", () => {
      const raw = JSON.stringify({
        type: "session_end",
        callId: "test-123",
        reason: "error",
      });

      const msg = parseInboundMessage(raw) as SessionEndMessage;
      expect(msg.reason).toBe("error");
    });

    it("parses session_end with timeout", () => {
      const raw = JSON.stringify({
        type: "session_end",
        callId: "test-123",
        reason: "timeout",
      });

      const msg = parseInboundMessage(raw) as SessionEndMessage;
      expect(msg.reason).toBe("timeout");
    });

    it("throws on invalid reason", () => {
      const raw = JSON.stringify({
        type: "session_end",
        callId: "test-123",
        reason: "invalid-reason",
      });

      expect(() => parseInboundMessage(raw)).toThrow(/reason/i);
    });
  });

  describe("session_resume", () => {
    it("parses valid session_resume message", () => {
      const raw = JSON.stringify({
        type: "session_resume",
        callId: "test-123",
        lastReceivedSeq: 54321,
      });

      const msg = parseInboundMessage(raw) as SessionResumeMessage;

      expect(msg.type).toBe("session_resume");
      expect(msg.callId).toBe("test-123");
      expect(msg.lastReceivedSeq).toBe(54321);
    });

    it("parses session_resume with zero sequence", () => {
      const raw = JSON.stringify({
        type: "session_resume",
        callId: "test-456",
        lastReceivedSeq: 0,
      });

      const msg = parseInboundMessage(raw) as SessionResumeMessage;

      expect(msg.type).toBe("session_resume");
      expect(msg.lastReceivedSeq).toBe(0);
    });

    it("handles large sequence numbers", () => {
      const raw = JSON.stringify({
        type: "session_resume",
        callId: "test-789",
        lastReceivedSeq: 9007199254740991, // Max safe integer
      });

      const msg = parseInboundMessage(raw) as SessionResumeMessage;
      expect(msg.lastReceivedSeq).toBe(9007199254740991);
    });

    it("throws on missing lastReceivedSeq", () => {
      const raw = JSON.stringify({
        type: "session_resume",
        callId: "test-123",
      });

      expect(() => parseInboundMessage(raw)).toThrow(/lastReceivedSeq/i);
    });

    it("throws on invalid lastReceivedSeq type", () => {
      const raw = JSON.stringify({
        type: "session_resume",
        callId: "test-123",
        lastReceivedSeq: "not-a-number",
      });

      expect(() => parseInboundMessage(raw)).toThrow(/lastReceivedSeq/i);
    });

    it("throws on missing callId", () => {
      const raw = JSON.stringify({
        type: "session_resume",
        lastReceivedSeq: 100,
      });

      expect(() => parseInboundMessage(raw)).toThrow(/callId/i);
    });
  });

  describe("ping", () => {
    it("parses valid ping message", () => {
      const raw = JSON.stringify({
        type: "ping",
        callId: "test-123",
      });

      const msg = parseInboundMessage(raw) as PingMessage;

      expect(msg.type).toBe("ping");
      expect(msg.callId).toBe("test-123");
    });

    it("throws on missing callId", () => {
      const raw = JSON.stringify({
        type: "ping",
      });

      expect(() => parseInboundMessage(raw)).toThrow(/callId/i);
    });
  });

  describe("error handling", () => {
    it("throws on invalid JSON", () => {
      expect(() => parseInboundMessage("not json")).toThrow(MessageParseError);
      expect(() => parseInboundMessage("not json")).toThrow(/Invalid JSON/i);
    });

    it("throws on non-object JSON", () => {
      expect(() => parseInboundMessage('"string"')).toThrow(/object/i);
      expect(() => parseInboundMessage("123")).toThrow(/object/i);
      expect(() => parseInboundMessage("null")).toThrow(/object/i);
    });

    it("throws on missing type field", () => {
      const raw = JSON.stringify({ callId: "test" });
      expect(() => parseInboundMessage(raw)).toThrow(/type/i);
    });

    it("throws on unknown message type", () => {
      const raw = JSON.stringify({ type: "unknown_type", callId: "test" });
      expect(() => parseInboundMessage(raw)).toThrow(/unknown message type/i);
    });

    it("includes raw message in error", () => {
      const raw = "invalid json";
      try {
        parseInboundMessage(raw);
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(MessageParseError);
        expect((e as MessageParseError).rawMessage).toBe(raw);
      }
    });
  });
});

describe("serializeOutboundMessage", () => {
  it("serializes audio_out message", () => {
    const msg: AudioOutMessage = {
      type: "audio_out",
      callId: "test-123",
      seq: 10,
      data: Buffer.alloc(640).toString("base64"),
    };

    const json = serializeOutboundMessage(msg);
    const parsed = JSON.parse(json);

    expect(parsed.type).toBe("audio_out");
    expect(parsed.callId).toBe("test-123");
    expect(parsed.seq).toBe(10);
    expect(parsed.data).toBe(msg.data);
  });

  it("serializes hangup message", () => {
    const msg: HangupMessage = {
      type: "hangup",
      callId: "test-123",
    };

    const json = serializeOutboundMessage(msg);
    const parsed = JSON.parse(json);

    expect(parsed.type).toBe("hangup");
    expect(parsed.callId).toBe("test-123");
  });

  it("serializes initiate_call with user target", () => {
    const msg: InitiateCallMessage = {
      type: "initiate_call",
      callId: "test-123",
      target: { type: "user", userId: "target-user-id" },
      message: "Hello!",
    };

    const json = serializeOutboundMessage(msg);
    const parsed = JSON.parse(json);

    expect(parsed.type).toBe("initiate_call");
    expect(parsed.target.type).toBe("user");
    expect(parsed.target.userId).toBe("target-user-id");
    expect(parsed.message).toBe("Hello!");
  });

  it("serializes initiate_call with phone target", () => {
    const msg: InitiateCallMessage = {
      type: "initiate_call",
      callId: "test-123",
      target: { type: "phone", number: "+15551234567" },
    };

    const json = serializeOutboundMessage(msg);
    const parsed = JSON.parse(json);

    expect(parsed.target.type).toBe("phone");
    expect(parsed.target.number).toBe("+15551234567");
  });

  it("serializes initiate_call without optional message", () => {
    const msg: InitiateCallMessage = {
      type: "initiate_call",
      callId: "test-123",
      target: { type: "user", userId: "target-user-id" },
    };

    const json = serializeOutboundMessage(msg);
    const parsed = JSON.parse(json);

    expect(parsed.message).toBeUndefined();
  });
});

describe("message builders", () => {
  describe("buildInitiateCall", () => {
    it("builds user target message", () => {
      const msg = buildInitiateCall(
        "call-123",
        { type: "user", userId: "user-456" },
        "Hello!",
      );

      expect(msg.type).toBe("initiate_call");
      expect(msg.callId).toBe("call-123");
      expect(msg.target).toEqual({ type: "user", userId: "user-456" });
      expect(msg.message).toBe("Hello!");
    });

    it("builds phone target message without initial message", () => {
      const msg = buildInitiateCall("call-123", {
        type: "phone",
        number: "+15551234567",
      });

      expect(msg.target).toEqual({ type: "phone", number: "+15551234567" });
      expect(msg.message).toBeUndefined();
    });
  });

  describe("buildAudioOut", () => {
    it("builds audio_out with base64 encoding", () => {
      const pcmData = Buffer.from([0x01, 0x02, 0x03, 0x04]);
      const msg = buildAudioOut("call-123", 5, pcmData);

      expect(msg.type).toBe("audio_out");
      expect(msg.callId).toBe("call-123");
      expect(msg.seq).toBe(5);
      expect(msg.data).toBe(pcmData.toString("base64"));
    });

    it("builds audio_out with 20ms frame", () => {
      const pcmData = Buffer.alloc(640); // 20ms @ 16kHz
      const msg = buildAudioOut("call-123", 0, pcmData);

      expect(Buffer.from(msg.data, "base64").length).toBe(640);
    });
  });

  describe("buildHangup", () => {
    it("builds hangup message", () => {
      const msg = buildHangup("call-123");

      expect(msg.type).toBe("hangup");
      expect(msg.callId).toBe("call-123");
    });
  });

  describe("buildPong", () => {
    it("builds pong response message", () => {
      const msg = buildPong("call-123");

      expect(msg.type).toBe("pong");
      expect(msg.callId).toBe("call-123");
    });
  });
});

describe("serializeOutboundMessage - pong", () => {
  it("serializes pong message", () => {
    const msg: PongMessage = {
      type: "pong",
      callId: "test-123",
    };

    const json = serializeOutboundMessage(msg);
    const parsed = JSON.parse(json);

    expect(parsed.type).toBe("pong");
    expect(parsed.callId).toBe("test-123");
  });
});

describe("decodeAudioData", () => {
  it("decodes base64 audio data", () => {
    const original = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]);
    const msg: AudioInMessage = {
      type: "audio_in",
      callId: "test",
      seq: 0,
      data: original.toString("base64"),
    };

    const decoded = decodeAudioData(msg);

    expect(decoded).toEqual(original);
  });

  it("decodes 20ms Teams frame", () => {
    const original = Buffer.alloc(640);
    for (let i = 0; i < 640; i++) {
      original[i] = i % 256;
    }

    const msg: AudioInMessage = {
      type: "audio_in",
      callId: "test",
      seq: 0,
      data: original.toString("base64"),
    };

    const decoded = decodeAudioData(msg);

    expect(decoded.length).toBe(640);
    expect(decoded).toEqual(original);
  });
});

describe("validateTeamsAudioFrame", () => {
  it("returns true for 640-byte frame", () => {
    const frame = Buffer.alloc(640);
    expect(validateTeamsAudioFrame(frame)).toBe(true);
  });

  it("returns false for smaller frame", () => {
    const frame = Buffer.alloc(320);
    expect(validateTeamsAudioFrame(frame)).toBe(false);
  });

  it("returns false for larger frame", () => {
    const frame = Buffer.alloc(1280);
    expect(validateTeamsAudioFrame(frame)).toBe(false);
  });

  it("returns false for empty frame", () => {
    const frame = Buffer.alloc(0);
    expect(validateTeamsAudioFrame(frame)).toBe(false);
  });
});
