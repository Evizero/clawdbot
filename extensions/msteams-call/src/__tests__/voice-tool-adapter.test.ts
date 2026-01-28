import { describe, it, expect, vi } from "vitest";
import { VoiceToolAdapter, createClawdbotToolExecutor } from "../voice-tool-adapter.js";

const stubTool = {
  name: "sessions_send",
  execute: vi.fn(async (toolCallId: string, params: Record<string, unknown>) => ({
    toolCallId,
    params,
  })),
};

describe("VoiceToolAdapter", () => {
  it("returns an error when no executor is configured", async () => {
    const adapter = new VoiceToolAdapter();
    const result = await adapter.executeTool("sessions_send", "{}", {
      callId: "call-1",
      userId: "user-1",
    });

    expect(result).toContain("No tool executor configured");
  });

  it("executes tools via createClawdbotToolExecutor", async () => {
    const executor = createClawdbotToolExecutor({
      createTools: async () => [stubTool],
    });

    const adapter = new VoiceToolAdapter({
      executor,
      allowTools: ["sessions_send"],
    });

    const result = await adapter.executeTool(
      "sessions_send",
      JSON.stringify({ message: "hi" }),
      {
        callId: "call-1",
        toolCallId: "tool-123",
        userId: "user-1",
      }
    );

    expect(stubTool.execute).toHaveBeenCalledWith("tool-123", { message: "hi" });
    expect(result).toContain("tool-123");
  });
});
