---
summary: "MS Teams Voice Call plugin: inbound + outbound voice calls via Teams (requires C# media gateway)"
read_when:
  - You want to enable voice calling with Microsoft Teams
  - You are deploying or configuring the msteams-call plugin
---

# MS Teams Voice Call (plugin)

Voice calls for Clawdbot via Microsoft Teams. Supports inbound and outbound calls with real-time speech-to-text and text-to-speech.

**Important:** This plugin requires a separate C# media gateway running on Azure Windows Server. The gateway handles the Teams media processing, while Clawdbot handles the AI conversation.

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
