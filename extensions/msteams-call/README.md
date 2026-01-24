# MS Teams Voice Call Plugin

Voice calling via Microsoft Teams for Clawdbot.

## Overview

This plugin enables inbound and outbound voice calls through Microsoft Teams. It works in conjunction with a C# media gateway that handles the Teams-side media processing.

## Architecture

```
Teams User <-> Teams Cloud <-> C# Gateway <-> Clawdbot (this plugin)
                              (Azure)         (your server)
```

## Prerequisites

1. A deployed C# media gateway on Azure Windows Server
2. Azure Bot with calling permissions
3. OpenAI API key for TTS/STT

## Installation

```bash
clawdbot plugins install @clawdbot/msteams-call
```

## Configuration

```json5
{
  plugins: {
    entries: {
      "msteams-call": {
        enabled: true,
        config: {
          bridge: {
            secret: "shared-secret-min-16-chars"
          },
          serve: {
            port: 3335
          }
        }
      }
    }
  }
}
```

## Documentation

See the full documentation at:
- [MS Teams Voice Call Plugin](https://docs.clawd.bot/plugins/msteams-call)
- [C# Gateway Implementation](https://docs.clawd.bot/plugins/msteams-call/csharp-gateway)

## Development

```bash
# Run tests
pnpm test extensions/msteams-call

# Build
pnpm build
```

## License

MIT
