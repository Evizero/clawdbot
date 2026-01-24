/**
 * MS Teams Voice Call Plugin
 *
 * Enables voice calling via Microsoft Teams through a C# media gateway bridge.
 * This plugin handles the Clawdbot side - the C# gateway must be deployed separately.
 */

import { Type } from "@sinclair/typebox";
import { randomBytes, randomUUID } from "crypto";
import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";
import {
  parseTeamsCallConfig,
  type TeamsCallConfig,
} from "./src/config.js";
import {
  createTeamsCallRuntime,
  type TeamsCallRuntime,
} from "./src/runtime.js";

/**
 * Config schema wrapper for plugin registration.
 */
const teamsCallConfigSchema = {
  parse(value: unknown): TeamsCallConfig {
    // Handle undefined/null config
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      // Use random secret when disabled - never use a known placeholder
      return parseTeamsCallConfig({
        enabled: false,
        bridge: { secret: randomBytes(32).toString("hex") },
      });
    }

    return parseTeamsCallConfig(value);
  },
  uiHints: {
    enabled: { label: "Enable MS Teams Voice Calls" },
    "bridge.secret": {
      label: "Bridge Secret",
      sensitive: true,
      help: "Shared secret for C# gateway authentication (min 32 chars, use: openssl rand -base64 32)",
    },
    "serve.port": { label: "Bridge Port", advanced: true },
    "serve.bind": { label: "Bridge Bind Address", advanced: true },
    "serve.path": { label: "Bridge WebSocket Path", advanced: true },
    "inbound.enabled": { label: "Enable Inbound Calls" },
    "inbound.greeting": { label: "Inbound Greeting" },
    "outbound.enabled": { label: "Enable Outbound Calls" },
    "outbound.ringTimeoutMs": { label: "Ring Timeout (ms)", advanced: true },
    "outbound.defaultMode": { label: "Default Call Mode" },
    "tts.model": { label: "TTS Model", advanced: true },
    "tts.voice": { label: "TTS Voice", advanced: true },
    "tts.instructions": { label: "TTS Instructions", advanced: true },
    "streaming.openaiApiKey": {
      label: "OpenAI API Key",
      sensitive: true,
      advanced: true,
    },
    "streaming.sttModel": { label: "STT Model", advanced: true },
    responseModel: { label: "Response Model", advanced: true },
    responseSystemPrompt: { label: "Response System Prompt", advanced: true },
    maxConcurrentCalls: { label: "Max Concurrent Calls", advanced: true },
  },
};

/**
 * Tool schema for agent usage.
 *
 * Note: Uses Type.Unsafe for action enum to avoid Type.Union (forbidden by project guidelines).
 * Single object with optional fields instead of union of objects.
 */
const TeamsCallToolSchema = Type.Object({
  action: Type.Unsafe<"initiate_call" | "speak" | "end_call" | "get_status">({
    type: "string",
    enum: ["initiate_call", "speak", "end_call", "get_status"],
    description: "Action to perform",
  }),
  to: Type.Optional(Type.String({
    description: "Target Teams user ID (user:xxx) or phone number (+xxx). Required for initiate_call.",
  })),
  callId: Type.Optional(Type.String({
    description: "Call ID. Required for speak/end_call, optional for get_status.",
  })),
  message: Type.Optional(Type.String({
    description: "Message to speak. Optional for initiate_call, required for speak.",
  })),
});

/**
 * Plugin definition.
 */
const msteamsCallPlugin = {
  id: "msteams-call",
  name: "MS Teams Voice Call",
  description: "Voice calling via Microsoft Teams (requires C# media gateway)",
  configSchema: teamsCallConfigSchema,

  register(api: ClawdbotPluginApi) {
    const cfg = teamsCallConfigSchema.parse(api.pluginConfig);

    // Early exit if disabled
    if (!cfg.enabled) {
      api.logger.debug("[msteams-call] Plugin disabled");
      return;
    }

    // Lazy runtime initialization
    let runtimePromise: Promise<TeamsCallRuntime> | null = null;
    let runtime: TeamsCallRuntime | null = null;

    const ensureRuntime = async () => {
      if (!cfg.enabled) {
        throw new Error("MS Teams voice call disabled in plugin config");
      }
      if (runtime) return runtime;
      if (!runtimePromise) {
        runtimePromise = createTeamsCallRuntime({
          config: cfg,
          coreConfig: api.config,
          logger: api.logger,
        });
      }
      runtime = await runtimePromise;
      return runtime;
    };

    const sendError = (
      respond: (ok: boolean, payload?: unknown) => void,
      err: unknown,
    ) => {
      respond(false, { error: err instanceof Error ? err.message : String(err) });
    };

    // Gateway methods
    api.registerGatewayMethod(
      "teamscall.initiate",
      async ({ params, respond }) => {
        try {
          const p = params as Record<string, unknown> | undefined;
          const to = typeof p?.to === "string" ? p.to.trim() : "";
          const message = typeof p?.message === "string" ? p.message.trim() : undefined;

          if (!to) {
            respond(false, { error: "to required" });
            return;
          }

          const rt = await ensureRuntime();
          const callId = `teams-${randomUUID()}`;

          const result = await rt.provider.initiateCall({
            callId,
            to,
            message,
          });

          if (result.status === "failed") {
            respond(false, { error: result.error || "initiate failed" });
            return;
          }

          respond(true, { callId: result.callId, initiated: true });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "teamscall.speak",
      async ({ params, respond }) => {
        try {
          const p = params as Record<string, unknown> | undefined;
          const callId = typeof p?.callId === "string" ? p.callId.trim() : "";
          const message = typeof p?.message === "string" ? p.message.trim() : "";

          if (!callId || !message) {
            respond(false, { error: "callId and message required" });
            return;
          }

          const rt = await ensureRuntime();
          await rt.provider.playTts({ callId, text: message });
          respond(true, { success: true });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "teamscall.end",
      async ({ params, respond }) => {
        try {
          const p = params as Record<string, unknown> | undefined;
          const callId = typeof p?.callId === "string" ? p.callId.trim() : "";

          if (!callId) {
            respond(false, { error: "callId required" });
            return;
          }

          const rt = await ensureRuntime();
          await rt.provider.hangupCall({ callId });
          respond(true, { success: true });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "teamscall.status",
      async ({ params, respond }) => {
        try {
          const p = params as Record<string, unknown> | undefined;
          const callId = typeof p?.callId === "string" ? p.callId.trim() : "";

          const rt = await ensureRuntime();

          if (callId) {
            const session = rt.provider.getSession(callId);
            if (!session) {
              respond(true, { found: false });
              return;
            }
            respond(true, { found: true, call: session });
          } else {
            // Return count of active calls
            respond(true, { activeCalls: rt.provider.getActiveCallCount() });
          }
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    // Register tool for agent use
    api.registerTool({
      name: "teams_voice_call",
      label: "Teams Voice Call",
      description:
        "Make voice calls to Teams users. Requires C# media gateway to be running.",
      parameters: TeamsCallToolSchema,
      async execute(_toolCallId, params) {
        const p = params as Record<string, unknown>;
        const action = p.action as string;
        const rt = await ensureRuntime();

        switch (action) {
          case "initiate_call": {
            const to = p.to as string;
            const message = p.message as string | undefined;
            const callId = `teams-${randomUUID()}`;

            const result = await rt.provider.initiateCall({
              callId,
              to,
              message,
            });

            return {
              success: result.status === "answered",
              callId: result.callId,
              error: result.error,
            };
          }

          case "speak": {
            const callId = p.callId as string;
            const message = p.message as string;

            await rt.provider.playTts({ callId, text: message });
            return { success: true };
          }

          case "end_call": {
            const callId = p.callId as string;
            await rt.provider.hangupCall({ callId });
            return { success: true };
          }

          case "get_status": {
            const callId = p.callId as string | undefined;
            if (callId) {
              const session = rt.provider.getSession(callId);
              return session
                ? { found: true, call: session }
                : { found: false };
            }
            return { activeCalls: rt.provider.getActiveCallCount() };
          }

          default:
            throw new Error(`Unknown action: ${action}`);
        }
      },
    });

    // Register service lifecycle
    api.registerService({
      id: "msteams-call",
      async start() {
        const rt = await ensureRuntime();
        await rt.start();
      },
      async stop() {
        if (runtime) {
          await runtime.stop();
          runtime = null;
          runtimePromise = null;
        }
      },
    });
  },
};

export default msteamsCallPlugin;
