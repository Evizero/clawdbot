---
summary: "C# Media Gateway implementation guide for MS Teams Voice Call plugin"
read_when:
  - You are building the C# media gateway for Teams voice
  - You need the bridge protocol specification
---

# C# Media Gateway Implementation

This guide covers everything needed to build the C# gateway that bridges Teams voice with Clawdbot.

## Overview

The C# gateway is a Windows application that:
1. Receives Teams call notifications via webhook
2. Handles application-hosted media (audio processing)
3. Connects to Clawdbot via WebSocket
4. Relays audio bidirectionally

**Hosting Requirements:**
- Windows Server on Azure (Cloud Service, VMSS, IaaS VM, or AKS)
- NOT Azure Web Apps (not supported for app-hosted media)
- Minimum: 2 CPU cores (Dv2-series VM recommended)

**Required NuGet packages:**
- `Microsoft.Graph.Communications.Calls`
- `Microsoft.Graph.Communications.Calls.Media`

**Important:** The Media SDK must be updated monthly. Versions >3 months old stop working.

## Graph API Permissions

Required permissions (all need admin consent):

| Permission | Purpose |
|------------|---------|
| `Calls.Initiate.All` | Outbound 1:1 calls |
| `Calls.InitiateGroupCall.All` | Group calls (if needed) |
| `Calls.JoinGroupCall.All` | Meeting joins (if needed) |
| `Calls.AccessMedia.All` | Application-hosted media (REQUIRED) |

## Teams App Manifest

Include in your Teams app manifest:

```json
{
  "bots": [{
    "supportsCalling": true,
    "supportsVideo": false
  }]
}
```

## Connection Lifecycle

```
1. Call arrives at Teams -> Teams notifies your /api/calling webhook
2. Your gateway validates the notification (JWT, 15s deadline)
3. Answer the call with application-hosted media
4. IMMEDIATELY connect WebSocket to Clawdbot:
   wss://<clawdbot-host>:<port>/teams-call/stream
5. Send session_start message
6. Begin audio frame relay (both directions)
7. On call end, send session_end and close WebSocket
```

## WebSocket Protocol

### Connection

**URL:** `wss://<clawdbot-host>:3335/teams-call/stream` (default)

**Authentication:** Include shared secret in upgrade request:
```
GET /teams-call/stream HTTP/1.1
Upgrade: websocket
Connection: Upgrade
X-Bridge-Secret: <your-shared-secret>
```

**Timing:**
- Connect within 2 seconds of answering Teams call
- Retry up to 3 times with 500ms backoff
- If all retries fail, hang up Teams call

**Keep-Alive:** Send ping every 30 seconds; expect pong within 5 seconds

### Messages (C# -> Clawdbot)

All messages are JSON. Audio data is base64-encoded.

#### session_start (send immediately after WebSocket connects)

```json
{
  "type": "session_start",
  "callId": "uuid-generated-by-gateway",
  "direction": "inbound",
  "metadata": {
    "tenantId": "azure-tenant-id",
    "userId": "teams-user-aad-object-id",
    "teamsCallId": "teams-call-id",
    "displayName": "John Doe",
    "userPrincipalName": "john@contoso.com"
  }
}
```

#### audio_in (send every 20ms while call is active)

```json
{
  "type": "audio_in",
  "callId": "uuid",
  "seq": 12345,
  "data": "base64..."
}
```

Audio format: 640 bytes of 16kHz PCM, 16-bit mono, little-endian

#### call_status (for outbound calls only)

```json
{
  "type": "call_status",
  "callId": "uuid",
  "status": "ringing",
  "error": null
}
```

Status values: `ringing`, `answered`, `failed`, `busy`, `no-answer`

#### session_end

```json
{
  "type": "session_end",
  "callId": "uuid",
  "reason": "hangup-user"
}
```

Reason values: `hangup-user`, `hangup-bot`, `error`, `timeout`

### Messages (Clawdbot -> C#)

#### audio_out (TTS output)

```json
{
  "type": "audio_out",
  "callId": "uuid",
  "seq": 789,
  "data": "base64..."
}
```

Audio format: 640 bytes of 16kHz PCM

#### hangup

```json
{
  "type": "hangup",
  "callId": "uuid"
}
```

## Audio Format

The bridge protocol uses Teams native format:

| Parameter | Value |
|-----------|-------|
| Sample rate | 16000 Hz |
| Bit depth | 16-bit signed |
| Channels | 1 (mono) |
| Byte order | Little-endian |
| Frame duration | 20ms |
| Bytes per frame | 640 |

**Important:** Clawdbot handles all resampling to/from OpenAI's 24kHz format. You just send/receive 16kHz PCM.

## Audio Handling

### Receiving from Teams

```csharp
void OnAudioReceived(AudioMediaBuffer buffer)
{
    // Assuming buffer.Data is already 16kHz PCM mono
    byte[] pcmData = new byte[buffer.Length];
    Marshal.Copy(buffer.Data, pcmData, 0, (int)buffer.Length);

    // Split into 640-byte chunks (20ms frames)
    for (int i = 0; i < pcmData.Length; i += 640)
    {
        int chunkSize = Math.Min(640, pcmData.Length - i);
        byte[] frame = new byte[chunkSize];
        Array.Copy(pcmData, i, frame, 0, chunkSize);

        SendToClawdbot(new AudioInMessage
        {
            Type = "audio_in",
            CallId = _callId,
            Seq = _sequenceNumber++,
            Data = Convert.ToBase64String(frame)
        });
    }
}
```

### Sending to Teams

**Problem:** TTS generates audio in bursts, but Teams expects real-time pacing.

**Solution:** Implement a playout queue with 20ms pacing:

```csharp
class AudioPlayoutQueue
{
    private readonly ConcurrentQueue<byte[]> _queue = new();
    private readonly Timer _playoutTimer;

    public AudioPlayoutQueue(Action<byte[]> onPlayFrame)
    {
        // Fire every 20ms
        _playoutTimer = new Timer(_ =>
        {
            if (_queue.TryDequeue(out var frame))
            {
                onPlayFrame(frame);
            }
            else
            {
                // Queue empty - send silence to maintain timing
                onPlayFrame(new byte[640]);
            }
        }, null, 0, 20);
    }

    public void Enqueue(byte[] frame) => _queue.Enqueue(frame);
}
```

### Jitter Buffer

For audio from Clawdbot, implement a reorder buffer:

```csharp
class JitterBuffer
{
    private readonly SortedDictionary<long, byte[]> _buffer = new();
    private long _nextExpectedSeq = 0;
    private const int MaxBufferMs = 60;  // 3 frames

    public byte[]? GetNextFrame(long seq, byte[] data)
    {
        _buffer[seq] = data;

        if (_buffer.TryGetValue(_nextExpectedSeq, out var frame))
        {
            _buffer.Remove(_nextExpectedSeq);
            _nextExpectedSeq++;
            return frame;
        }

        // If buffer too full, skip missing frame
        if (_buffer.Count > MaxBufferMs / 20)
        {
            _nextExpectedSeq = _buffer.Keys.Min();
            return GetNextFrame(seq, data);
        }

        return null;  // Wait for expected frame
    }
}
```

## REST Control Plane

The C# gateway exposes REST endpoints for Clawdbot to initiate outbound calls and manage call lifecycle.

### Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/control/initiateCall` | POST | Start an outbound call |
| `/control/hangup` | POST | End an active call |
| `/health` | GET | Health check |

### Authentication

All control plane endpoints require the shared secret in the `X-Bridge-Secret` header:

```
POST /control/initiateCall HTTP/1.1
Host: gateway.example.com
X-Bridge-Secret: <your-shared-secret>
Content-Type: application/json
```

### POST /control/initiateCall

**Request:**
```json
{
  "target": {
    "type": "user",
    "userId": "aad-object-id"
  },
  "message": "Optional initial message to speak"
}
```

Or for phone numbers (requires PSTN license):
```json
{
  "target": {
    "type": "phone",
    "number": "+15551234567"
  }
}
```

**Response (202 Accepted):**
```json
{
  "callId": "uuid-generated-by-gateway"
}
```

**Error Responses:**
- `401 Unauthorized` - Invalid or missing secret
- `400 Bad Request` - Invalid target format

### POST /control/hangup

**Request:**
```json
{
  "callId": "uuid-of-call-to-end"
}
```

**Response (200 OK):**
```json
{
  "success": true
}
```

### GET /health

**Response (200 OK):**
```json
{
  "status": "healthy",
  "activeCalls": 2,
  "sdkVersion": "1.2.0.12345"
}
```

## Outbound Calls

For application-hosted media, use the Graph Communications Calling SDK with `IMediaSession`:

```csharp
// Controller endpoint
[HttpPost("/control/initiateCall")]
public async Task<IActionResult> InitiateCall([FromBody] InitiateCallRequest req)
{
    if (!ValidateBridgeSecret(Request.Headers["X-Bridge-Secret"]))
        return Unauthorized();

    var callId = Guid.NewGuid().ToString();
    _ = Task.Run(() => CreateOutboundCallAsync(callId, req));
    return Accepted(new { callId });
}

async Task CreateOutboundCallAsync(string callId, InitiateCallRequest req)
{
    // 1. Create IMediaSession (REQUIRED for app-hosted media)
    var mediaSession = _communicationsClient.CreateMediaSession(
        new AudioSocketSettings
        {
            StreamDirection = StreamDirection.SendRecv,
            SupportedAudioFormat = AudioFormat.Pcm16K
        },
        // VideoSocketSettings, DataSocketSettings if needed
    );

    // 2. Build call request
    var callRequest = new Call
    {
        Direction = CallDirection.Outgoing,
        CallbackUri = $"https://{_config.Host}/api/calling?callId={callId}",
        Source = new ParticipantInfo { Identity = _botIdentity },
        Targets = new[] {
            new InvitationParticipantInfo {
                Identity = new IdentitySet {
                    User = new Identity { Id = req.Target.UserId }
                }
            }
        },
        MediaConfig = new AppHostedMediaConfig {
            Blob = mediaSession.GetMediaConfiguration()
        },
        TenantId = _config.TenantId
    };

    // 3. Create call (passes IMediaSession)
    var call = await _communicationsClient.Calls().AddAsync(
        callRequest,
        mediaSession
    );

    _activeCalls[callId] = new CallSession {
        CallId = callId,
        TeamsCallId = call.Id,
        MediaSession = mediaSession
    };
}
```

## Webhook Handling

### Legacy Protocol

Teams may send initial notifications in legacy format. Respond with 204:

```csharp
[HttpPost("/api/calling")]
public async Task<IActionResult> HandleCallingWebhook()
{
    if (IsLegacyProtocol(Request))
    {
        return NoContent();  // 204 - Teams will resend in Graph format
    }

    var notification = await ParseGraphNotification(Request);
    await ProcessNotification(notification);
    return Ok();
}
```

### OAuth Validation

Validate the bearer token on all webhook requests:

```csharp
var token = Request.Headers["Authorization"].ToString().Replace("Bearer ", "");
if (!await ValidateBotFrameworkToken(token))
{
    return Unauthorized();
}
```

## Error Handling

```csharp
// WebSocket connection failure
if (!await ConnectToClawdbot(retries: 3))
{
    await HangupTeamsCall("Unable to connect to AI service");
    return;
}

// Audio gap handling
// If Teams audio missing >500ms, continue (silence is normal)
// If Clawdbot stops sending for >5s during TTS, log warning

// Termination
// On Teams disconnect: send session_end with reason="error"
// On Clawdbot hangup: terminate Teams call within 1 second
// On WebSocket drop: terminate and attempt reconnect if call active
```

## Compliance

**Microsoft explicitly prohibits:**

> "You may NOT use the Cloud Communications APIs to record or otherwise persist media content from calls or meetings."

**Implications:**
- Process audio **in-memory only** (stream to OpenAI, discard after)
- Store only call metadata (callId, timestamps, duration)
- Do NOT persist transcripts by default

## Timing Budget

| Operation | Target | Max Allowed |
|-----------|--------|-------------|
| Answer Teams call | <2s | 15s (Teams limit) |
| Connect to Clawdbot | <500ms | 2s |
| Send session_start | <100ms | 500ms |
| Audio frame relay | <50ms | 100ms |
| Process hangup | <500ms | 1s |

## Common Pitfalls

1. **Base64 Padding** - Ensure proper padding (`=`)
2. **Audio Byte Order** - PCM must be little-endian
3. **Frame Alignment** - Always send exactly 640 bytes (pad with zeros at end)
4. **Sequence Overflow** - Use int64 for sequence numbers
5. **WebSocket Buffering** - Flush sends immediately; don't batch
6. **TLS Certificate** - Must be valid (not self-signed in prod)
7. **Media SDK Staleness** - Update monthly
8. **Audio Pacing** - Don't burst-send TTS; pace at 20ms

## Testing

### Without Teams (Mock Mode)

1. Create WebSocket client that sends fake `session_start` and `audio_in`
2. Verify Clawdbot responds with `audio_out`
3. Use pre-recorded PCM files as test audio

### With Teams (Dev Environment)

1. Use ngrok to expose your gateway publicly
2. Register a test bot in Azure Bot Service
3. Configure calling webhook to your ngrok URL
4. Make test calls from Teams desktop/mobile

### Audio Quality Verification

1. Send known audio (speech sample) through pipeline
2. Record returned TTS audio
3. Verify conversation makes sense (STT understood, TTS is audible)
