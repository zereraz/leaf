# Leaf Bot

An always-on AI assistant for WhatsApp and Telegram with privacy controls, multi-user support, and extensible architecture.

## Features

### Core Capabilities
- **Multi-Platform Support**: WhatsApp (via Baileys) and Telegram
- **AI-Powered**: Uses Claude/Anthropic for intelligent responses
- **Persistent Sessions**: Remembers conversation history per user
- **Streaming Responses**: Real-time typing indicators and message updates
- **Tool Integration**: Bash, file operations, web search, sub-agents

### Privacy & Security
- **Data Isolation**: Each user's data is isolated from others
- **Group Privacy Controls**:
  - `@mention` required for bot to respond in groups
  - Allowlist/blocklist for group access
  - Per-sender tool restrictions
- **Consent Management**: Cross-user data access requires explicit approval
- **Audit Logging**: Tracks sensitive operations

### Multi-User Architecture
- **Per-User Sessions**: Each WhatsApp user gets isolated conversation history
- **Group Support**: Shared group context while maintaining personal data boundaries
- **Owner Controls**: Configure who can use the bot and what they can access

## Quick Start

### Prerequisites
- Docker and Docker Compose
- WhatsApp account (for WhatsApp transport)
- Anthropic API key

### Configuration

1. **Environment Variables** (`.env`):
```bash
TRANSPORT=whatsapp
WA_OWNER_PHONE=YOUR_PHONE_WITH_COUNTRY_CODE
ANTHROPIC_API_KEY=your_key
ANTHROPIC_BASE_URL=https://api.anthropic.com
SERPER_API_KEY=your_serper_key  # For web search
```

2. **Privacy Configuration** (`privacy.config.ts`):
```typescript
export const privacyConfig = {
  // Group access settings
  groupAccess: {
    policy: "open",                 // "open" | "allowlist" | "disabled"
    mentionMode: "require_in_group", // Must @mention bot to trigger
    botUsername: "yourbotname",      // Your bot's WhatsApp name
  },
  
  // Tool restrictions (optional)
  toolScope: {
    globalDefault: "allow",
    senderScopes: [],  // Per-user tool restrictions
  },
};
```

### Running Locally

```bash
# Build and start
make build
make start

# View logs (scan QR code for WhatsApp)
make logs

# Stop
make stop
```

### Production Deployment

```bash
# Production build
make prod-build
make prod-deploy

# Or with Docker Compose directly:
docker compose -f docker-compose.prod.yml up -d
```

See [DOCKER.md](./DOCKER.md) for detailed Docker documentation.

## Architecture

```
┌─────────────────┐     ┌─────────────┐     ┌─────────────────┐
│   WhatsApp      │────▶│   Bot       │────▶│  AI Agent       │
│   (Baileys)     │     │   Handler   │     │  (Claude)       │
└─────────────────┘     └─────────────┘     └─────────────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        ▼                      ▼                      ▼
┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│ User Data    │      │ Privacy      │      │ Tools        │
│ Store        │      │ Controls     │      │ (bash, etc)  │
└──────────────┘      └──────────────┘      └──────────────┘
```

### Key Components

| Component | Purpose |
|-----------|---------|
| `src/whatsapp.ts` | WhatsApp Web transport using Baileys |
| `src/telegram.ts` | Telegram Bot API transport |
| `src/bot.ts` | Message routing, privacy enforcement |
| `src/agent.ts` | AI session management, tool orchestration |
| `src/privacy/` | Access control, data isolation, consent |
| `src/scheduler.ts` | Proactive scheduled messages |

## Privacy System

### User Identification
Users are identified by:
- **Phone number** (E.164 format, e.g., `19175551234`)
- **Username** (Telegram)
- **Platform ID** (fallback)

### Data Isolation
```
/users/19175551234/          ← User A's data
/users/19175559876/          ← User B's data (inaccessible to A)
```

### Group Conversation Handling
- **Shared Context**: Bot sees full group conversation
- **Personal Boundaries**: User A's private data not accessible to User B
- **@mention Gate**: Bot only responds when mentioned in groups

### Consent Flow (for MCP/Data Sharing)
```
User B: "Show me User A's health data"
Bot: "Requesting consent from User A..."
User A: "approve req_123"
Bot: Shows data to User B
```

## Commands

### Bot Commands
| Command | Description |
|---------|-------------|
| `/reset` | Clear session context |
| `/debug` | Show debug info |
| `/status` | Check bot health |

### Make Targets
| Target | Description |
|--------|-------------|
| `make build` | Build Docker image |
| `make start` | Start bot |
| `make stop` | Stop bot |
| `make logs` | View logs |
| `make clean` | Remove all data |
| `make backup` | Backup volumes |

## Development

### File Structure
```
leaf/
├── src/
│   ├── agent.ts          # AI session management
│   ├── bot.ts            # Message routing & privacy
│   ├── whatsapp.ts       # WhatsApp transport
│   ├── telegram.ts       # Telegram transport
│   ├── scheduler.ts      # Scheduled messages
│   └── privacy/          # Privacy system
│       ├── sender-identity.ts
│       ├── group-access.ts
│       ├── tool-scope.ts
│       ├── user-data-store.ts
│       ├── consent.ts
│       └── tool-wrapper.ts
├── privacy.config.ts     # Privacy configuration
├── docker-compose.yml    # Local deployment
├── docker-compose.prod.yml # Production deployment
├── Dockerfile            # Container image
└── Makefile              # Convenience commands
```

### Adding MCP Tools

To add external MCP tools (e.g., Garmin Health):

```typescript
import { wrapToolWithPrivacy, registerToolGuard, mcpToolGuard } from "./privacy/index.js";

// Register privacy guard
registerToolGuard("garmin_health", mcpToolGuard);

// Wrap tool
const wrappedTool = {
  ...garminTool,
  execute: wrapToolWithPrivacy(
    garminTool.name,
    garminTool.execute,
    () => getCurrentUserIdentity(sessionId)
  )
};
```

See `privacy.example.ts` for full MCP integration example.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TRANSPORT` | Yes | `whatsapp` or `telegram` |
| `WA_OWNER_PHONE` | For WhatsApp | Your phone number with country code |
| `TG_BOT_TOKEN` | For Telegram | Telegram bot token |
| `TG_CHAT_ID` | For Telegram | Your Telegram user ID |
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key |
| `ANTHROPIC_BASE_URL` | No | Custom API endpoint |
| `SERPER_API_KEY` | No | For web search |

## Troubleshooting

### WhatsApp QR Code Not Showing
```bash
make logs
# Look for QR code in output
```

### Bot Not Responding in Groups
Check `privacy.config.ts`:
- `mentionMode` should be `"require_in_group"`
- `botUsername` must match your bot's WhatsApp name

### Data Not Isolating
```bash
# Clear all sessions and restart
make clean
rm -f ~/.pi/agent/sessions/leaf/*.jsonl
make build && make start
```

### Docker Issues
```bash
# Reset everything
docker compose down -v
docker system prune -f
make build && make start
```

## License

MIT

## Credits

Built with:
- [Baileys](https://github.com/WhiskeySockets/Baileys) - WhatsApp Web API
- [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent) - Agent framework
- Claude by Anthropic - AI model
