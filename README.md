# AI Web Automation

AI Web Automation is an automation platform and MCP (Model Context Protocol) server designed to let AI agents (such as OMP, Claude Code, Codex, or custom clients) control web-based AI platforms directly through persistent browser sessions without API keys.

The core browser automation is provider-agnostic, multi-process safe, and runs independently from MCP or client orchestrators.

## Key Features

- Provider-Agnostic Core: Browser engine and lifecycle abstractions are decoupled from specific AI platforms.
- Multi-Process Safety: Uses filesystem-backed cross-process profile locking to prevent concurrent mutations when multiple MCP sessions or CLI processes access the same profile.
- Persistent Dedicated Profiles: Each provider uses an isolated Chrome user data directory, preserving session credentials across restarts while keeping personal browsing data untouched.
- Bounded-Wait and Job Semantics: MCP tools return results within bounded client timeouts or yield job IDs for polling via ai_web_wait, protecting against transport timeouts and duplicate submissions.
- Strict Idempotency: Request IDs and generation state guards prevent double-submission during agent reconnection or automated retries.
- Production-Grade Logging: JSON logs directed to stderr and disk; stdout remains reserved exclusively for MCP JSON-RPC.

## Architecture

```text
Agent / MCP Client (OMP, Claude Code, Codex)
                    |
                    v
             MCP Server (stdio)
                    |
                    v
          Application / Job Layer
                    |
                    v
            Provider Adapters
  (ChatGPT Web, Gemini Web, Claude Web, ...)
                    |
                    v
               Browser Core
   (Playwright CDP, process lock, safety)
                    |
                    v
    Chrome Instance (detached, 1 profile / provider)
```

### Process and State Model

- Runtime directories default to `~/.ai-web/` (configurable via `AI_WEB_HOME`).
- Directory structure:
  - `profiles/<provider>/`: Dedicated Chrome user-data-dir (chmod 700).
  - `state/<provider>.json`: Active Chrome metadata (pid, port, CDP WebSocket endpoint).
  - `locks/<provider>.lock`: Cross-process advisory lock with stale PID reclaim.
  - `breaker/<provider>.json`: Persistent circuit breaker state.
  - `jobs/`: Persistent job records.
  - `logs/`: Application logs and failure snapshots.

## Supported Providers

- ChatGPT Web (MVP)
- Gemini Web (Planned)
- Claude Web (Planned)
- Media generation providers (Image/Video, Planned)

## Requirements

- Node.js >= 22 (Node.js 24 LTS recommended)
- Google Chrome or Chromium installed on the host system (Chrome >= 136 supported via dedicated user-data-dir)

## Getting Started

### Installation

```bash
git clone https://github.com/thiendt1608/web-automation-mcp.git
cd web-automation-mcp
npm install
npm run build
```

### CLI Usage

```bash
# Verify environment and Chrome installation
npm run build && node dist/cli/index.js doctor

# Authenticate provider profile
node dist/cli/index.js login chatgpt

# Check system and provider status
node dist/cli/index.js status
```

### MCP Integration

Configure the server in your MCP client configuration (e.g. `.omp/mcp.json` or equivalent agent configuration):

```json
{
  "mcpServers": {
    "ai-web": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/web-automation-mcp/dist/mcp/server.js"],
      "timeout": 60000
    }
  }
}
```

### Available MCP Tools (MVP)

- `ai_web_status`: Inspect provider status, browser connectivity, and active jobs.
- `ai_web_list_providers`: List registered providers and their supported capabilities.
- `ai_web_new_conversation`: Create a clean conversation session.
- `ai_web_chat`: Send a prompt with bounded wait (returns final text or job_id).
- `ai_web_wait`: Long-poll pending jobs until completion or timeout.
- `ai_web_get_response`: Fetch the latest response from an existing conversation.
- `ai_web_select_model`: Switch active model on the web platform.

## Development

```bash
# Type check
npm run typecheck

# Run test suite
npm test

# Run end-to-end tests (requires authenticated browser profile)
npm run test:e2e
```

## Security and Disclaimer

- Terms of Service: Automated web interaction may be subject to the Terms of Service of each target platform. Use personal dedicated testing accounts and observe rate limits. Users are responsible for their usage compliance.
- CDP Exposure: Remote debugging endpoints bind to local loopback (127.0.0.1) on dynamic ports. Do not expose debugging ports over untrusted networks.
- Credential Safety: Authentication is performed manually within the isolated browser instance. The system does not store or export user credentials.

## License

MIT
