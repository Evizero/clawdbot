---
summary: "MS Teams Voice Call plugin: inbound + outbound voice calls via Teams (requires C# media gateway)"
read_when:
  - You want to enable voice calling with Microsoft Teams
  - You are deploying or configuring the msteams-call plugin
---

# MS Teams Voice Call (plugin)

Status: ready for inbound and outbound voice calls via Microsoft Teams.

**Important:** This plugin requires a separate C# media gateway running on Azure Windows Server. The gateway handles the Teams media processing, while Clawdbot handles the AI conversation.

## Quick setup

1. Install the plugin: `clawdbot plugins install @clawdbot/msteams-call`
2. Deploy the C# Media Gateway to an Azure Windows VM
3. Configure the bridge secret (same 32+ char value in both configs)
4. Set your OpenAI API key (for TTS/STT)
5. Start the gateway

Minimal config:
```json5
{
  plugins: {
    entries: {
      "msteams-call": {
        enabled: true,
        config: {
          bridge: {
            // Generate with: openssl rand -base64 32
            secret: "your-shared-secret-min-32-chars"
          }
        }
      }
    }
  }
}
```

## Goals

- Voice calls via Teams (inbound and outbound)
- Real-time speech-to-text via OpenAI Realtime API
- Text-to-speech responses via OpenAI TTS
- Call authorization (disabled, allowlist, tenant-only, or open)
- Integration with C# media gateway for Teams SDK compatibility

## Architecture

```
Teams User <-> Teams Cloud <-> C# Media Gateway <-> Clawdbot (this plugin)
                              (Azure Windows)       (your server)
```

The plugin provides:
- WebSocket server for C# gateway connections
- Audio format conversion (Teams 16kHz <-> OpenAI 24kHz)
- TTS via OpenAI
- STT via OpenAI Realtime API
- Call state management
- **Call authorization** (single source of truth for auth policy)

## Prerequisites

Before configuring Clawdbot:

1. **Azure Bot** registered with calling enabled
2. **Teams app manifest** with `supportsCalling: true`
3. **C# Media Gateway** deployed on Azure Windows Server
4. **Graph API permissions** (with admin consent):
   - `Calls.Initiate.All` (outbound calls)
   - `Calls.AccessMedia.All` (application-hosted media)

See [C# Gateway Implementation Guide](/plugins/msteams-call/csharp-gateway) for gateway setup.

## Install

```bash
clawdbot plugins install @clawdbot/msteams-call
```

Restart the Gateway afterwards.

## Config

Set config under `plugins.entries.msteams-call.config`:

```json5
{
  plugins: {
    entries: {
      "msteams-call": {
        enabled: true,
        config: {
          // Bridge server (Clawdbot listens, C# gateway connects)
          serve: {
            port: 3335,
            bind: "127.0.0.1",
            path: "/teams-call/stream"
          },

          // Authentication (share with C# gateway)
          bridge: {
            secret: "your-shared-secret-min-32-chars"
          },

          // Inbound calls
          inbound: {
            enabled: true,
            greeting: "Hello! How can I help you?"
          },

          // Outbound calls
          outbound: {
            enabled: true,
            ringTimeoutMs: 30000
          },

          // TTS settings
          tts: {
            model: "gpt-4o-mini-tts",
            voice: "coral"
          },

          // STT settings (OpenAI Realtime)
          streaming: {
            openaiApiKey: "sk-...", // or use OPENAI_API_KEY env
            sttModel: "gpt-4o-transcribe",
            silenceDurationMs: 800
          },

          // Call authorization (who can call the bot)
          // Authorization is handled entirely in Clawdbot (not the C# gateway)
          authorization: {
            mode: "allowlist", // disabled | open | allowlist | tenant-only
            allowFrom: ["user@example.com", "user-object-id"],
            allowedTenants: ["your-tenant-guid"],
            allowPstn: false
          }
        }
      }
    }
  }
}
```

## Configuration Options

| Option | Description | Default |
|--------|-------------|---------|
| `serve.port` | WebSocket server port | 3335 |
| `serve.bind` | Bind address | 127.0.0.1 |
| `serve.path` | WebSocket path | /teams-call/stream |
| `bridge.secret` | Shared secret (min 32 chars, use: `openssl rand -base64 32`) | required |
| `inbound.enabled` | Enable inbound calls | true |
| `inbound.greeting` | Initial greeting message | none |
| `outbound.enabled` | Enable outbound calls | true |
| `outbound.ringTimeoutMs` | Max ring time (ms) | 30000 |
| `outbound.defaultMode` | Call mode: `notify` or `conversation` | conversation |
| `tts.model` | OpenAI TTS model | gpt-4o-mini-tts |
| `tts.voice` | TTS voice | coral |
| `tts.speed` | Speech speed (0.25-4.0) | 1.0 |
| `tts.instructions` | TTS style instructions | none |
| `streaming.openaiApiKey` | OpenAI API key | OPENAI_API_KEY env |
| `streaming.sttModel` | STT model | gpt-4o-transcribe |
| `streaming.silenceDurationMs` | Silence before speech ends (ms) | 800 |
| `streaming.vadThreshold` | VAD threshold (0-1) | 0.5 |
| `responseModel` | Response generation model | openai/gpt-4o-mini |
| `responseSystemPrompt` | System prompt for responses | none |
| `responseTimeoutMs` | Response timeout (ms) | 30000 |
| `maxConcurrentCalls` | Max simultaneous calls | 5 |
| `maxDurationSeconds` | Max call duration (s) | 3600 |
| `authorization.mode` | Call authorization: `disabled`, `open`, `allowlist`, or `tenant-only` | disabled |
| `authorization.allowFrom` | Email addresses or AAD object IDs allowed to call (when mode=allowlist). Empty list = reject all. | [] |
| `authorization.allowedTenants` | Tenant GUIDs allowed (when mode=tenant-only or allowlist). Empty list = reject all. | [] |
| `authorization.allowPstn` | Allow PSTN (phone) callers | false |

## Call Authorization

Authorization for inbound calls is handled **entirely in Clawdbot**. The C# Media Gateway delegates all authorization decisions to Clawdbot via WebSocket messages, making Clawdbot the single source of truth for authorization policy.

### Authorization Modes

| Mode | Description |
|------|-------------|
| `disabled` | Reject ALL inbound calls. This is the **default** (fail-closed). |
| `open` | Allow all callers (use with caution). |
| `allowlist` | Only allow callers in `allowFrom` list. |
| `tenant-only` | Only allow callers from tenants in `allowedTenants` list. |

### Fail-Closed Security

The authorization system follows fail-closed principles:

- **Default mode is `disabled`**: All calls are rejected until you explicitly configure authorization.
- **Empty lists reject all**: If `allowFrom` or `allowedTenants` is empty when required by the mode, calls are rejected.
- **Must configure before enabling**: You must set up authorization BEFORE enabling inbound calls in production.

### Example Configuration

```json
{
  "msteams-call": {
    "enabled": true,
    "bridge": {
      "secret": "your-32-char-minimum-secret-here"
    },
    "authorization": {
      "mode": "allowlist",
      "allowFrom": ["user@example.com", "user-object-id"],
      "allowedTenants": ["tenant-guid-here"],
      "allowPstn": false
    }
  }
}
```

### Deployment Notes

> **Breaking Change**: Authorization has moved from the C# Gateway to Clawdbot. Both components must be updated together.

- The C# Gateway no longer has its own `CallAuthMode`, `AllowedUsers`, or `AllowedTenants` settings.
- All authorization configuration is now in the Clawdbot `msteams-call` plugin config.
- The default `disabled` mode means calls will be rejected until you configure authorization.
- When upgrading from an older version, migrate your authorization settings from the gateway's `appsettings.json` to the Clawdbot plugin config.

## Agent Tool

The plugin provides a `teams_voice_call` tool for agents:

```typescript
// Initiate a call
{ action: "initiate_call", to: "user:aad-object-id", message: "Hello!" }

// Speak to active call
{ action: "speak", callId: "teams-xxx", message: "How can I help?" }

// End a call
{ action: "end_call", callId: "teams-xxx" }

// Get call status
{ action: "get_status", callId: "teams-xxx" }
```

## Gateway Methods

For programmatic access:

| Method | Parameters | Description |
|--------|------------|-------------|
| `teamscall.initiate` | `to`, `message?` | Start outbound call |
| `teamscall.speak` | `callId`, `message` | Speak TTS on call |
| `teamscall.end` | `callId` | End call |
| `teamscall.status` | `callId?` | Get call/active status |

## Call Flow

### Inbound Calls

1. User calls the Teams bot
2. C# gateway receives the call and connects to Clawdbot WebSocket
3. Gateway sends `session_start` message
4. Clawdbot plays greeting (if configured)
5. Gateway streams audio to Clawdbot, which transcribes via STT
6. Clawdbot generates responses and sends TTS audio back
7. Call ends when user or bot hangs up

### Outbound Calls

1. Agent/CLI triggers `teamscall.initiate`
2. Clawdbot waits for gateway connection
3. C# gateway creates Teams call via Graph API
4. Gateway connects to Clawdbot on call answer
5. Conversation proceeds as with inbound calls

## Audio Format

| System | Sample Rate | Format |
|--------|-------------|--------|
| Teams | 16kHz | PCM 16-bit mono |
| OpenAI Realtime | 24kHz | PCM 16-bit mono |

The bridge automatically resamples between formats.

## Troubleshooting

### Gateway won't connect

- Verify `bridge.secret` matches on both sides
- Check firewall allows connections to `serve.port`
- Verify C# gateway has correct WebSocket URL

### No audio

- Check OpenAI API key is valid
- Verify TTS/STT providers are initialized (check logs)
- Confirm audio frames are being exchanged (debug logging)

### Calls fail immediately

- Verify C# gateway is running
- Check Teams bot permissions
- Review C# gateway logs for Graph API errors

## Related

- [C# Gateway Implementation Guide](/plugins/msteams-call/csharp-gateway)
- [Voice Call Plugin](/plugins/voice-call) (Twilio/Telnyx)
- [MS Teams Chat](/channels/msteams) (text messaging)
