import { describe, it, expect, vi } from "vitest";
import type { RealtimeSessionConfig, RealtimeSessionEvents } from "../realtime-session.js";
import { RealtimeVoiceAgent } from "../realtime-voice-agent.js";

class FakeSession {
  config: RealtimeSessionConfig;
  events?: RealtimeSessionEvents;

  constructor(config: RealtimeSessionConfig) {
    this.config = config;
  }

  async connect(events: RealtimeSessionEvents): Promise<void> {
    this.events = events;
  }

  isConnected(): boolean {
    return true;
  }

  sendAudio(): void {}
  interrupt(): void {}
  close(): void {}
  submitToolResult(): void {}
}

const createBridge = () => ({
  sendAudioFrame: vi.fn(),
  sendAudioFlush: vi.fn(),
}) as unknown as import("../bridge.js").TeamsAudioBridge;

describe("RealtimeVoiceAgent", () => {
  it("suppresses tools when no executor is configured", async () => {
    const sessions: FakeSession[] = [];
    const agent = new RealtimeVoiceAgent(createBridge(), {
      openaiApiKey: "test-key",
      createSession: (config) => {
        const session = new FakeSession(config);
        sessions.push(session);
        return session as any;
      },
    });

    await agent.startCall("call-1", "user-1", {
      agentId: "main",
      systemPrompt: "",
      tools: [
        {
          name: "sessions_send",
          description: "Send a message",
          parameters: { type: "object", properties: {} },
        },
      ],
      identity: { name: "voice assistant" },
    });

    const tools = sessions[0]?.config.tools ?? [];
    expect(tools.length).toBe(0);
  });

  it("emits input transcripts for session recording", async () => {
    const sessions: FakeSession[] = [];
    const onInputTranscript = vi.fn();
    const agent = new RealtimeVoiceAgent(createBridge(), {
      openaiApiKey: "test-key",
      onInputTranscript,
      createSession: (config) => {
        const session = new FakeSession(config);
        sessions.push(session);
        return session as any;
      },
    });

    await agent.startCall("call-2", "user-2", {
      agentId: "main",
      systemPrompt: "",
      tools: [],
      identity: { name: "voice assistant" },
    });

    sessions[0]?.events?.onInputTranscript?.("hello", true);

    expect(onInputTranscript).toHaveBeenCalledWith({
      callId: "call-2",
      text: "hello",
      isFinal: true,
    });
  });
});
