/**
 * Voice Tool Adapter
 *
 * Converts Clawdbot tool schemas to OpenAI Realtime API format.
 * Filters tools appropriate for voice interaction (fast, sync operations).
 *
 * Voice-appropriate tools:
 * - memory_search - Quick context lookup
 * - sessions_spawn - Delegate heavy tasks asynchronously
 * - sessions_send - Send to other channels
 * - web_search - Quick web lookup
 *
 * Excluded tools (too slow or inappropriate for voice):
 * - browser_* - Interactive browsing
 * - edit, write, run - File/code operations
 * - read - File reading (usually too verbose)
 * - Complex multi-step tools
 */

import type { RealtimeTool } from "./realtime-session.js";
import type { Logger } from "./bridge.js";

/**
 * Tool schema from Clawdbot (simplified).
 */
export interface ClawdbotToolSchema {
  name: string;
  description?: string;
  parameters?: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Tool execution context.
 */
export interface ToolExecutionContext {
  callId: string;
  toolCallId?: string;
  userId: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  workspaceDir?: string;
}

/**
 * Tool executor function type.
 */
export type ToolExecutor = (
  name: string,
  args: Record<string, unknown>,
  context: ToolExecutionContext,
) => Promise<unknown>;

/**
 * Configuration for the voice tool adapter.
 */
export interface VoiceToolAdapterConfig {
  /** Tools to explicitly allow (overrides defaults) */
  allowTools?: string[];
  /** Tools to explicitly deny (applied after allow) */
  denyTools?: string[];
  /** Custom tool executor */
  executor?: ToolExecutor;
  /** Logger */
  logger?: Logger;
}

/**
 * Default voice-safe tools.
 * These are fast, synchronous operations suitable for voice interaction.
 */
const DEFAULT_VOICE_SAFE_TOOLS = new Set([
  // Memory and context
  "memory_search",
  "memory_add",

  // Session delegation (for heavy tasks)
  "sessions_spawn",
  "sessions_send",
  "sessions_list",

  // Information retrieval
  "web_search",
  "web_fetch",

  // Calendar/scheduling (if available)
  "calendar_list",
  "calendar_create",

  // Reminders (if available)
  "reminder_create",
  "reminder_list",
]);

/**
 * Tools that should never be used in voice mode.
 * These are too slow, interactive, or inappropriate.
 */
const VOICE_BLOCKED_TOOLS = new Set([
  // File operations (too verbose/slow)
  "read",
  "write",
  "edit",
  "glob",
  "grep",

  // Code execution (too slow/dangerous)
  "run",
  "bash",
  "shell",

  // Browser (interactive)
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_screenshot",
  "browser_scroll",

  // Git operations (too slow)
  "git_status",
  "git_commit",
  "git_push",
  "git_pull",

  // Long-running operations
  "deploy",
  "build",
  "test",
]);

/**
 * Voice Tool Adapter.
 *
 * Converts and filters Clawdbot tools for use with OpenAI Realtime API.
 */
export class VoiceToolAdapter {
  private allowedTools: Set<string>;
  private blockedTools: Set<string>;
  private executor?: ToolExecutor;
  private logger?: Logger;

  constructor(config: VoiceToolAdapterConfig = {}) {
    // Build allowed tools set
    this.allowedTools = config.allowTools
      ? new Set(config.allowTools)
      : new Set(DEFAULT_VOICE_SAFE_TOOLS);

    // Build blocked tools set
    this.blockedTools = new Set(VOICE_BLOCKED_TOOLS);
    if (config.denyTools) {
      for (const tool of config.denyTools) {
        this.blockedTools.add(tool);
      }
    }

    this.executor = config.executor;
    this.logger = config.logger;
  }

  hasExecutor(): boolean {
    return Boolean(this.executor);
  }

  /**
   * Check if a tool is voice-appropriate.
   */
  isVoiceSafe(toolName: string): boolean {
    // Blocked tools are never allowed
    if (this.blockedTools.has(toolName)) {
      return false;
    }

    // Check if explicitly allowed
    return this.allowedTools.has(toolName);
  }

  /**
   * Convert Clawdbot tool schemas to Realtime API format.
   * Filters to only voice-appropriate tools.
   *
   * @param tools Array of Clawdbot tool schemas
   * @returns Array of Realtime API tool definitions
   */
  buildRealtimeTools(tools: ClawdbotToolSchema[]): RealtimeTool[] {
    const realtimeTools: RealtimeTool[] = [];

    for (const tool of tools) {
      // Skip non-voice-safe tools
      if (!this.isVoiceSafe(tool.name)) {
        this.logger?.debug(
          `[VoiceToolAdapter] Skipping non-voice-safe tool: ${tool.name}`
        );
        continue;
      }

      // Convert to Realtime format
      const realtimeTool: RealtimeTool = {
        type: "function",
        name: tool.name,
        description: tool.description || `Execute ${tool.name}`,
        parameters: {
          type: "object",
          properties: tool.parameters?.properties ?? {},
          required: tool.parameters?.required,
        },
      };

      realtimeTools.push(realtimeTool);
      this.logger?.debug(
        `[VoiceToolAdapter] Added voice tool: ${tool.name}`
      );
    }

    this.logger?.info(
      `[VoiceToolAdapter] Built ${realtimeTools.length} voice tools from ${tools.length} total`
    );

    return realtimeTools;
  }

  /**
   * Execute a tool and return the result.
   *
   * @param name Tool name
   * @param argsJson JSON string of arguments
   * @param context Execution context
   * @returns Tool result (stringified)
   */
  async executeTool(
    name: string,
    argsJson: string,
    context: ToolExecutionContext,
  ): Promise<string> {
    if (!this.executor) {
      return JSON.stringify({ error: "No tool executor configured" });
    }

    // Validate tool is allowed
    if (!this.isVoiceSafe(name)) {
      this.logger?.warn(`[VoiceToolAdapter] Blocked tool execution: ${name}`);
      return JSON.stringify({
        error: `Tool '${name}' is not available in voice mode`,
      });
    }

    try {
      // Parse arguments
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(argsJson);
      } catch {
        args = {};
      }

      this.logger?.debug(
        `[VoiceToolAdapter] Executing tool: ${name}(${JSON.stringify(args).slice(0, 100)})`
      );

      // Execute tool
      const result = await this.executor(name, args, context);

      // Format result
      const resultStr = this.formatToolResult(result);
      this.logger?.debug(
        `[VoiceToolAdapter] Tool result: ${resultStr.slice(0, 200)}`
      );

      return resultStr;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger?.error(`[VoiceToolAdapter] Tool execution error: ${errorMsg}`);
      return JSON.stringify({ error: errorMsg });
    }
  }

  /**
   * Format tool result for voice response.
   * Keeps results concise for voice readback.
   */
  private formatToolResult(result: unknown): string {
    if (result === undefined || result === null) {
      return "Done";
    }

    if (typeof result === "string") {
      // Truncate long strings for voice
      if (result.length > 1000) {
        return result.slice(0, 1000) + "... (truncated)";
      }
      return result;
    }

    if (typeof result === "object") {
      // Check for error
      const obj = result as Record<string, unknown>;
      if (obj.error) {
        return JSON.stringify({ error: obj.error });
      }

      // Check for text/message field (common pattern)
      if (typeof obj.text === "string") {
        return obj.text;
      }
      if (typeof obj.message === "string") {
        return obj.message;
      }
      if (typeof obj.result === "string") {
        return obj.result;
      }

      // Stringify object, truncate if too long
      const json = JSON.stringify(result);
      if (json.length > 1000) {
        return json.slice(0, 1000) + "... (truncated)";
      }
      return json;
    }

    return String(result);
  }

  /**
   * Get the list of currently allowed tools.
   */
  getAllowedTools(): string[] {
    return [...this.allowedTools];
  }

  /**
   * Get the list of blocked tools.
   */
  getBlockedTools(): string[] {
    return [...this.blockedTools];
  }
}

/**
 * Create a tool executor that uses the Clawdbot tool registry.
 * This is a placeholder - actual implementation will use core bridge.
 */
export function createClawdbotToolExecutor(deps: {
  logger?: Logger;
  normalizeToolName?: (name: string) => string;
  createTools: (context: ToolExecutionContext) => Promise<Array<{
    name: string;
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
    ) => Promise<unknown> | unknown;
  }>>;
}): ToolExecutor {
  const normalize =
    deps.normalizeToolName ?? ((value) => value.trim().toLowerCase());
  const cache = new Map<string, Promise<Map<string, { execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<unknown> | unknown }>>>();

  const getToolMap = async (context: ToolExecutionContext) => {
    const cacheKey = context.sessionKey || context.agentId || "default";
    let cached = cache.get(cacheKey);
    if (!cached) {
      cached = deps.createTools(context).then((tools) => {
        const map = new Map<string, { execute: (
          toolCallId: string,
          params: Record<string, unknown>,
          signal?: AbortSignal,
        ) => Promise<unknown> | unknown }>();
        for (const tool of tools) {
          const normalized = normalize(tool.name);
          if (!normalized) continue;
          map.set(normalized, { execute: tool.execute });
        }
        return map;
      });
      cache.set(cacheKey, cached);
    }
    return cached;
  };

  return async (name, args, context) => {
    const normalized = normalize(name);
    if (!normalized) {
      return { error: "Tool name missing" };
    }

    const toolMap = await getToolMap(context);
    const tool = toolMap.get(normalized);
    if (!tool) {
      deps.logger?.warn(`[VoiceToolAdapter] Tool not found: ${name}`);
      return { error: `Tool '${name}' not found` };
    }

    const toolCallId = context.toolCallId || context.callId;
    return await tool.execute(toolCallId, args);
  };
}
