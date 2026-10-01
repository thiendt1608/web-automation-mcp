# AI Web Automation — Implementation Plan

> Revision 2 (2026-10-01). Thay đổi chính so với bản đầu: xem §0.

## 0. Thay đổi so với bản đầu & lý do

| # | Vấn đề ở bản đầu | Sửa thành | Bằng chứng |
|---|---|---|---|
| 1 | `ai_web_chat` block tới khi ChatGPT trả lời xong | Tool có **bounded wait**: chờ tối đa `wait_seconds`, quá hạn trả `job_id` + `ai_web_wait`. Job tối thiểu kéo vào MVP | OMP MCP request timeout mặc định **30s**, cancellation chỉ local (không gửi `notifications/cancelled`), không thấy cơ chế progress reset timeout — [mcp-protocol-transports.md](https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-protocol-transports.md), [mcp-server-tool-authoring.md](https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-server-tool-authoring.md). Model thinking thường trả lời > 30s |
| 2 | Không có idempotency | `request_id` do agent gửi + chặn gửi lại khi đang generate; **không bao giờ auto-retry sau khi đã submit** | OMP tự reconnect + retry 1 lần khi tool call gặp lỗi connection retriable — [mcp-runtime-lifecycle.md](https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-runtime-lifecycle.md) → nguy cơ gửi prompt 2 lần |
| 3 | `session-lock` hiểu ngầm là in-process | **Cross-process lock** trên filesystem | Stdio MCP: mỗi OMP session / mỗi agent client spawn 1 server process riêng, tất cả cùng đụng 1 Chrome profile |
| 4 | Port CDP cố định `9222`, state 1 port | `--remote-debugging-port=0` + đọc `DevToolsActivePort` trong user-data-dir; state **per profile** | 1 provider = 1 profile = 1 Chrome process ⇒ nhiều port, tránh đụng port |
| 5 | Không nhắc Chrome ≥136 | Bắt buộc `--user-data-dir` không phải mặc định (plan đã dùng profile riêng, giờ ghi rõ là **bắt buộc**, không chỉ là khuyến nghị) | [Chrome blog: remote debugging changes](https://developer.chrome.com/blog/remote-debugging-port) |
| 6 | Node.js 20+ | **Node.js 24 LTS** | Node 20 EOL 2026-04-30 ([endoflife.date](https://endoflife.date/nodejs)) |
| 7 | `@modelcontextprotocol/sdk` | **MCP TS SDK v2** (`@modelcontextprotocol/server`, `zod/v4`) | v2 là stable line, implement spec 2026-07-28 — [ts.sdk docs](https://ts.sdk.modelcontextprotocol.io/v2/) |
| 8 | Cây thư mục sai: `providers/`, `mcp/` nằm trong `core/`; MCP config trỏ `dist/mcp/server.js` không khớp | Sửa cây; tách `core/`, `app/`, `providers/`, `mcp/`, `cli/` | — |
| 9 | Tool names MVP lệch nhau (`chatgpt_web_ask` vs `ai_web_chat`) | Chỉ dùng `ai_web_*` | — |
| 10 | Không có mục rủi ro ToS / account | Thêm §17 Risks | [OpenAI Terms of Use](https://openai.com/policies/terms-of-use/) cấm "automatically or programmatically extract data or Output" |
| 11 | Log chưa nói kênh | Log ra **stderr/file**, NEVER stdout | Stdio MCP dùng stdout làm kênh JSON-RPC |
| 12 | Response extraction mơ hồ | Định nghĩa completion detection + output Markdown | — |

---

## 1. Mục tiêu dự án

Xây dựng một nền tảng **AI Web Automation** cho phép agent (đặc biệt là OMP, nhưng không khóa vào OMP) điều khiển các nền tảng AI chạy trên web thông qua browser automation.

Mục tiêu dài hạn:

```text
Agent
  │
  │ MCP
  ▼
AI Web Automation Server
  │
  ├── ChatGPT Web
  ├── Gemini Web
  ├── Claude Web
  ├── Image-generation platforms
  ├── Video-generation platforms
  └── Other AI Web platforms
        │
        ▼
   Playwright + CDP
        │
        ▼
Persistent Chrome / Chromium profiles (1 profile / provider)
```

Dự án không nên được thiết kế như một `chatgpt-mcp` riêng lẻ. Browser automation core phải độc lập với từng provider và độc lập với OMP.

---

## 2. Nguyên tắc kiến trúc

### 2.1. Browser Core là lớp nền

Browser Core chịu trách nhiệm:

- Launch / attach browser (per profile).
- Kết nối CDP.
- Persistent browser profile.
- Browser context / page lifecycle.
- Navigation.
- Locator / DOM interaction.
- Upload / download.
- Network event handling.
- Screenshot / artifact capture.
- Timeout / cancellation.
- **Cross-process** profile lock.

Không đưa logic đặc thù ChatGPT/Gemini vào Browser Core.

### 2.2. Provider Adapter là abstraction cho từng AI Web

```text
Provider
├── authentication check
├── capabilities
├── navigation
├── conversation
├── generation + completion detection
├── file handling
├── result extraction
├── provider-specific selectors
└── provider-specific error detection (rate limit, verification, banner)
```

### 2.3. MCP là API boundary

```text
OMP / Codex / Claude Code / Other Agent
                    │
                    ▼
                   MCP (stdio)
                    │
                    ▼
          AI Web Automation Core
```

Không để OMP-specific code đi sâu xuống browser/provider layer.

### 2.4. Process model

Stdio MCP ⇒ **mỗi client session spawn một server process riêng**. Hệ quả bắt buộc phải thiết kế từ đầu:

```text
OMP session A ── stdio ── server process A ─┐
OMP session B ── stdio ── server process B ─┼── cùng Chrome profile "chatgpt" (CDP)
ai-web CLI   ─────────── process C ─────────┘
```

- Chrome process sống độc lập với server process (spawn detached). Server exit ⇒ chỉ `disconnect()`, không kill Chrome.
- Mọi state dùng chung (browser state, lock, breaker, job records) nằm trên filesystem dưới `~/.ai-web/` (override bằng `AI_WEB_HOME`).
- Lock theo profile là **cross-process** (lock file chứa `pid`, `startedAt`; reclaim khi pid đã chết). In-process mutex chỉ là lớp phụ.
- **Daemon mode** (một process giữ browser + job queue, MCP Streamable HTTP trên `127.0.0.1` hoặc stdio shim) **chưa làm trong MVP**, nhưng là điều kiện tiên quyết trước video generation (job dài hàng phút–giờ không thể phụ thuộc vào vòng đời một OMP session). Core phải viết sao cho chạy được trong cả hai mode: không dùng global singleton gắn với stdio transport.

### 2.5. OMP integration là lớp bổ sung

Ban đầu chỉ cần MCP integration. Sau này có thể thêm OMP extension mỏng (`/ai-web status|login|reset`, TUI rendering, notifications). Extension không chứa browser automation core.

---

## 3. Phạm vi MVP (v0.1)

Provider đầu tiên: **ChatGPT Web**.

MCP tools MVP (chi tiết §Phase 4):

```text
ai_web_status
ai_web_list_providers
ai_web_new_conversation
ai_web_chat            (bounded wait, trả result hoặc job_id)
ai_web_wait            (bounded long-poll theo job_id)
ai_web_get_response    (đọc lại response mới nhất của conversation)
ai_web_select_model
```

Browser behavior:

- Chrome/Chromium/Edge với **dedicated persistent profile** (bắt buộc; Chrome ≥136 bỏ qua remote debugging trên default user-data-dir).
- `playwright-core` + `connectOverCDP`.
- Headed mặc định. Headless không hỗ trợ chính thức trong MVP (login phải headed; headless dễ dính challenge — [INFERENCE], reference repo cũng mặc định `HEADLESS=false`).
- Login thủ công một lần.
- Reconnect vào browser đang chạy; không mở browser mới cho mỗi request.
- Không dùng OpenAI API key.

Mục tiêu MVP:

```text
OMP → MCP (stdio) → AI Web Server → Playwright → CDP → Chrome → ChatGPT Web → Markdown response
```

### Không làm trong MVP

- Multi-provider.
- Image / video generation.
- Parallel jobs (trong cùng provider).
- Daemon mode.
- Complex history search.
- CAPTCHA solving, anti-bot bypass, stealth features.
- Automatic account rotation.
- Tự động login bằng credential.
- MCP Tasks (spec 2025-11-25 experimental, sau đó tách thành extension; OMP chưa document hỗ trợ) — dùng job tools tự định nghĩa thay thế.

---

## 4. Giai đoạn triển khai

# Phase 0 — Project bootstrap

### Công việc

- Single package TypeScript (monorepo chỉ khi có OMP extension package).
- **Node.js 24 LTS** khuyến nghị; `engines.node >= 22` (22 còn maintenance tới 2027-04; máy dev đang chạy 22.16, dùng `Promise.withResolvers` nên cần ≥22).
- TypeScript, ESM.
- `playwright-core` (không dùng `playwright` full — không cần tải browser bundled).
- MCP TS SDK v2: `@modelcontextprotocol/server` (+ `/stdio`), `zod` (import `zod/v4`).
- ESLint + formatter (hoặc Biome).
- Test: `vitest` hoặc `node:test`.
- Logging: `pino` ghi **stderr / file**, NEVER stdout.

### Cấu trúc

```text
ai-web-automation/
├── package.json
├── tsconfig.json
├── README.md
├── .gitignore              # loại profiles/, state/, artifacts/
│
├── src/
│   ├── core/                       # provider-agnostic
│   │   ├── browser/
│   │   │   ├── browser-manager.ts  # launch/connect/disconnect/terminate per profile
│   │   │   ├── chrome-launcher.ts  # tìm executable, spawn detached, đọc DevToolsActivePort
│   │   │   ├── browser-state.ts    # ~/.ai-web/state/<profile>.json
│   │   │   ├── page-manager.ts
│   │   │   └── interaction.ts      # click/fill/insertText/waitFor... + timeout/abort
│   │   ├── lock/
│   │   │   └── profile-lock.ts     # cross-process lock + stale reclaim
│   │   ├── safety/
│   │   │   ├── throttle.ts         # min interval per action class
│   │   │   └── circuit-breaker.ts  # persisted trên disk
│   │   ├── config.ts
│   │   ├── logger.ts
│   │   └── errors.ts               # error taxonomy + code + retryable
│   │
│   ├── app/                        # orchestration, không biết DOM
│   │   ├── job/
│   │   │   ├── job-manager.ts
│   │   │   └── job-store.ts        # persisted JSON/SQLite
│   │   └── artifact/               # từ v0.2
│   │       ├── artifact-manager.ts
│   │       ├── download-manager.ts
│   │       └── upload-manager.ts
│   │
│   ├── providers/
│   │   ├── provider.ts             # AIWebProvider interface
│   │   ├── capabilities.ts
│   │   ├── registry.ts
│   │   └── chatgpt/
│   │       ├── chatgpt-provider.ts
│   │       ├── selectors.ts        # mỗi target có nhiều candidate theo thứ tự ưu tiên
│   │       ├── conversation.ts
│   │       ├── completion.ts       # detect generation done
│   │       ├── extract.ts          # DOM → Markdown
│   │       ├── models.ts
│   │       └── page-signals.ts     # rate-limit / verification / max-length banner
│   │
│   ├── mcp/
│   │   ├── server.ts               # entry: dist/mcp/server.js
│   │   ├── schemas.ts
│   │   ├── error-mapping.ts
│   │   └── tools/
│   │
│   └── cli/
│       ├── index.ts                # bin: ai-web
│       ├── login.ts
│       ├── status.ts
│       ├── browser.ts
│       └── doctor.ts
│
├── tests/
│   ├── unit/
│   ├── fixtures/                   # HTML snapshot ChatGPT đã scrub dữ liệu
│   ├── integration/
│   └── e2e/
│
└── docs/
    ├── architecture.md
    ├── providers.md
    └── troubleshooting.md
```

Runtime data (ngoài repo):

```text
~/.ai-web/
├── profiles/<provider>/      # Chrome user-data-dir, chmod 700
├── state/<provider>.json     # browser state
├── locks/<provider>.lock
├── breaker/<provider>.json
├── jobs/                     # job records
├── artifacts/
└── logs/
```

---

# Phase 1 — Browser Core

Mục tiêu: browser manager độc lập provider, an toàn khi nhiều process cùng gọi.

## 1.1. Chrome launcher

Input:

```ts
launch({ profile, executablePath?, headless?: false })
```

Behavior:

```text
acquire profile lock
      ↓
đọc state/<profile>.json
      ↓
pid còn sống && CDP endpoint trả /json/version?
      ├── yes → connectOverCDP(wsEndpoint)
      └── no  → dọn state cũ
                → spawn Chrome detached (unref, stdio ignore)
                → poll <userDataDir>/DevToolsActivePort (timeout)
                → connectOverCDP()
                → ghi state
```

Chrome arguments:

```text
--user-data-dir=<~/.ai-web/profiles/<provider>>   # BẮT BUỘC non-default (Chrome ≥136)
--remote-debugging-port=0                         # Chrome tự chọn port, ghi vào DevToolsActivePort
--no-first-run
--no-default-browser-check
```

Ghi chú:

- `--remote-debugging-address` không cần: Chrome hiện bind `127.0.0.1` cho CDP; KHÔNG dùng `0.0.0.0`.
- Không dùng profile Chrome cá nhân của user.
- Nếu Chrome của profile đang chạy **không** có CDP (user tự mở tay), `SingletonLock` sẽ chặn spawn → báo `BROWSER_PROFILE_IN_USE`, không kill hộ.
- Không dùng `chromium.launchPersistentContext` cho browser chạy lâu: browser sẽ chết theo process Node đã launch nó, phá mô hình multi-process.

## 1.2. Persistent browser state (per profile)

```json
{
  "profile": "chatgpt",
  "pid": 12345,
  "port": 53122,
  "wsEndpoint": "ws://127.0.0.1:53122/devtools/browser/...",
  "executable": "/Applications/Google Chrome.app/...",
  "startedAt": "2026-10-01T10:00:00Z"
}
```

API:

```text
connect(profile)
launch(profile)
disconnect()     # không kill Chrome
terminate(profile)
status(profile)
```

## 1.3. Page manager

```ts
getOrCreatePage(provider)   // tìm tab theo origin, tái sử dụng
open(url)
closePage()
```

Provider không biết CDP port.

## 1.4. Interaction wrapper

```text
click()  fill()  insertText()  press()  goto()
waitFor()  waitForResponse()  evaluate()  screenshot()
```

- Mọi hàm nhận `AbortSignal` + timeout.
- `insertText()` dùng CDP `Input.insertText` / `locator.fill` cho prompt dài; không dùng `type()` từng phím cho text dài.
- Retry chỉ cho thao tác **idempotent trước submit** (tìm composer, focus). NEVER retry submit.
- Log mỗi action (§9).

## 1.5. Profile lock

- Lock file `locks/<profile>.lock` tạo bằng `open(O_CREAT|O_EXCL)` (hoặc `proper-lockfile`), nội dung `{pid, startedAt, op}`.
- Stale reclaim: pid không tồn tại ⇒ được chiếm lại. Pid còn sống ⇒ chờ đến timeout rồi trả `SESSION_BUSY`.
- Lock giữ trong suốt một operation có side effect (send, new conversation, select model). Read-only status không cần lock.

---

# Phase 2 — Provider abstraction

```ts
interface AIWebProvider {
  id: string;
  profile: string;

  capabilities(): ProviderCapabilities;

  ensureReady(signal: AbortSignal): Promise<void>;
  checkAuthenticated(signal: AbortSignal): Promise<AuthState>;

  newConversation(opts?: NewConversationOptions): Promise<ConversationRef>;

  // Submit xong là return; không chờ generation.
  submitMessage(conversation: ConversationRef | null, input: MessageInput): Promise<SubmittedTurn>;

  // Chờ tới khi xong hoặc signal abort (bounded wait do caller quyết định).
  waitForCompletion(turn: SubmittedTurn, signal: AbortSignal): Promise<TurnResult>;

  getLatestResponse(conversation: ConversationRef): Promise<TurnResult>;

  detectPageSignals(): Promise<PageSignal[]>; // rate limit, verification, max-length...
}

interface ConversationRef {
  provider: string;
  id: string;   // ChatGPT: uuid trong URL /c/<id>
  url: string;
}

interface ProviderCapabilities {
  chat: boolean;
  imageGeneration: boolean;
  videoGeneration: boolean;
  audioGeneration: boolean;
  fileUpload: boolean;
  fileDownload: boolean;
  modelSelection: boolean;
}
```

Job lifecycle thuộc `app/job`, không thuộc provider. Provider chỉ submit / wait / extract. Không provider nào trả raw Playwright objects lên trên.

---

# Phase 3 — ChatGPT Web provider

Port logic từ reference repo sang kiến trúc mới, không copy nguyên project:

```text
https://github.com/Goudu666/chatgpt-web-mcp   (MIT, JavaScript)
```

Những phần đáng port (đã có sẵn ở reference): cross-process operation lock + stale reclaim, throttle intervals, circuit breaker khi thấy rate-limit text / HTTP 429, auto-rotate conversation khi quá dài / gặp maximum-length banner, network diagnostics đã scrub. Giữ attribution MIT nếu copy code.

## 3.1. Login

```bash
ai-web login chatgpt
```

- Mở Chrome headed với profile riêng, mở `https://chatgpt.com`.
- User login thủ công; CLI poll trạng thái authenticated (UI signal của logged-in, không đọc cookie ra ngoài).
- Không lưu password, không đọc/ghi cookie ra file khác profile.

## 3.2. Conversation

```text
newConversation()
getCurrentConversation()   # parse /c/<id> từ URL
selectConversation(id)     # goto chatgpt.com/c/<id>
```

`conversation_id` trả cho agent = id trong URL. Conversation mới chỉ có id sau khi submit turn đầu ⇒ `ai_web_chat` trả id sau submit.

## 3.3. Send message

```text
acquire profile lock
      ↓
check circuit breaker
      ↓
ensure page + authenticated
      ↓
detectPageSignals()  → rate-limit/verification ⇒ dừng, không submit
      ↓
đang có generation dở? ⇒ SESSION_BUSY (không gửi chồng)
      ↓
ensure composer ready + rỗng (có draft/attachment lạ ⇒ dừng)
      ↓
insert prompt
      ↓
submit  ← điểm không quay lại: từ đây NEVER retry
      ↓
ghi job record (status=running, conversation_id, turn index)
      ↓
waitForCompletion (bounded bởi caller)
      ↓
extract response → Markdown
      ↓
release lock
```

## 3.4. Completion detection

Done khi **đồng thời**:

1. Nút stop generation biến mất / nút send xuất hiện lại.
2. Assistant message cuối không đổi trong `stableMs` (vd 1500ms), theo dõi bằng `MutationObserver` trong page (không poll dày).
3. Không có page signal lỗi (network error, "something went wrong", rate limit).

Timeout tổng (`responseTimeoutMs`, vd 15 phút cho thinking model) ⇒ job `failed` với `GENERATION_TIMEOUT`; không tự gửi lại.

## 3.5. Response extraction

Ưu tiên:

1. DOM của assistant message cuối → Markdown (giữ code block + language, list, table, link). Ưu tiên lấy markdown gốc qua nút "Copy" nếu ổn định hơn DOM → markdown converter.
2. Network response chỉ khi DOM thiếu (vd message bị collapse).
3. Fallback `innerText`.

Mỗi selector có danh sách candidate (`data-testid`, role/aria, text) theo thứ tự; tất cả fail ⇒ `SELECTOR_NOT_FOUND` + lưu HTML snapshot + screenshot vào `logs/` để sửa selector.

## 3.6. Safety / throttling

```text
profile operation lock (cross-process)
min send interval            (vd 5s)
min page interaction interval (vd 1s)
active generation guard
rate-limit / verification detection
circuit breaker (persisted, cần clear thủ công hoặc hết cooldown)
idempotency theo request_id
```

Mục tiêu: agent retry / timeout / reconnect không bao giờ dẫn đến spam ChatGPT Web.

---

# Phase 4 — MCP Server

## 4.1. Nguyên tắc

- Tool trả `structuredContent` + `outputSchema` (OMP giữ structuredContent và thêm JSON text block).
- Không tool nào block quá `wait_seconds` (mặc định **20s**, tối đa cấu hình được) để luôn dưới client timeout (OMP mặc định 30s). Muốn chờ lâu hơn thì user tăng `timeout` trong config và tăng `wait_seconds`, hoặc agent gọi `ai_web_wait` nhiều lần.
- Client abort/timeout **không** cancel generation phía server (OMP không gửi protocol cancel). Job vẫn chạy; agent lấy lại bằng `ai_web_wait`.

## 4.2. MVP tools

### `ai_web_list_providers`

Provider + capabilities.

### `ai_web_status`

```json
{
  "providers": {
    "chatgpt": {
      "browser": "running",
      "authenticated": true,
      "busy": false,
      "circuit_breaker": "closed",
      "active_job_id": null
    }
  }
}
```

### `ai_web_chat`

Input:

```json
{
  "provider": "chatgpt",
  "prompt": "Review this architecture...",
  "conversation_id": "optional; bỏ trống = conversation mới",
  "request_id": "optional; agent tự sinh để dedupe retry",
  "wait_seconds": 20
}
```

Output (xong trong hạn):

```json
{
  "status": "completed",
  "job_id": "j_...",
  "conversation_id": "6650...",
  "response": { "format": "markdown", "text": "..." }
}
```

Output (chưa xong):

```json
{
  "status": "running",
  "job_id": "j_...",
  "conversation_id": "6650...",
  "hint": "Call ai_web_wait with job_id."
}
```

Idempotency: cùng `request_id` trong TTL ⇒ trả job cũ, không submit lại. Provider đang có job running ⇒ `SESSION_BUSY` kèm `active_job_id`.

### `ai_web_wait`

```json
{ "job_id": "j_...", "wait_seconds": 20 }
```

Trả cùng shape như `ai_web_chat`. Job do process khác tạo mà process đó đã chết ⇒ fallback `getLatestResponse(conversation_id)`.

### `ai_web_get_response`

```json
{ "provider": "chatgpt", "conversation_id": "6650..." }
```

Đọc response mới nhất, không submit gì.

### `ai_web_new_conversation`

```json
{ "provider": "chatgpt" }
```

### `ai_web_select_model`

```json
{ "provider": "chatgpt", "model": "..." }
```

Model list đọc động từ UI (không hardcode); model không tồn tại ⇒ `MODEL_NOT_AVAILABLE` kèm danh sách hiện có.

Không expose browser primitive (`click(x,y)`, `type`, `press`) ở MCP level.

---

# Phase 5 — OMP integration

OMP config (`.omp/mcp.json` hoặc `~/.omp/agent/mcp.json`):

```json
{
  "mcpServers": {
    "ai-web": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/ai-web-automation/dist/mcp/server.js"],
      "timeout": 60000
    }
  }
}
```

- `timeout` (ms) override mặc định 30000 của OMP; `OMP_MCP_TIMEOUT_MS` override tất cả. Server phải đảm bảo `wait_seconds` < timeout này.
- Verify bằng `/mcp` trong OMP: server connected, tools hiển thị.

## Sau MVP

OMP extension mỏng (§Phase 12/Milestone 8): `/ai-web login|status|reset|browser`, notifications, custom renderer. Không chứa browser implementation.

---

# Phase 6 — Generic Job System (mở rộng từ job tối thiểu của MVP)

MVP đã có job tối thiểu cho chat (bắt buộc vì bounded wait). Phase này tổng quát hóa cho mọi job type trước khi làm image/video.

```ts
interface Job {
  id: string;
  provider: string;
  type: 'chat' | 'image' | 'video' | string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  requestId?: string;
  conversationId?: string;
  ownerPid: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: { code: string; message: string };
  result?: unknown;
  artifacts?: Artifact[];
}
```

Lifecycle:

```text
queued → running → completed
             ├──→ failed
             └──→ cancelled
```

- Job store persisted (`~/.ai-web/jobs/`), ghi atomic (write temp + rename) hoặc SQLite.
- `ownerPid` chết khi job `running` ⇒ job chuyển `orphaned`-recovery: thử đọc kết quả từ provider; không được thì `failed` với `JOB_OWNER_LOST`.
- MCP tools: `ai_web_job_status`, `ai_web_wait`, `ai_web_cancel` (cancel = bấm stop generation trên UI nếu provider hỗ trợ).

Không để mỗi provider tự tạo một cơ chế job khác nhau.

---

# Phase 7 — Artifact system

```ts
interface Artifact {
  id: string;
  type: 'image' | 'video' | 'audio' | 'file';
  mimeType: string;
  path: string;        // absolute, nằm trong output dir đã cấu hình
  size: number;
  sha256: string;
  filename: string;
  provider: string;
  jobId: string;
}
```

Agent nhận metadata + path, không nhận binary. (Image nhỏ có thể kèm MCP image block thumbnail — tùy chọn, sau.)

---

# Phase 8 — File upload / download

## Upload

```text
agent path → validate (absolute, realpath trong allowlist, size limit) → provider upload (setInputFiles) → AI platform
```

## Download

```text
AI platform → provider trigger → Playwright download event / CDP Browser.setDownloadBehavior → artifact manager → output dir
```

- Path validation dùng `realpath` để chặn symlink/`..` thoát khỏi allowlist.
- Tên file sanitize; không overwrite file đã tồn tại (thêm suffix).

---

# Phase 9 — Daemon mode (điều kiện tiên quyết cho media dài)

- `ai-web daemon`: một process giữ browser connections, job queue per provider, job watcher.
- Transport: MCP Streamable HTTP bind `127.0.0.1` + auth token trong file `0600`; hoặc giữ stdio server làm shim forward sang daemon.
- Stdio in-process mode vẫn giữ cho dev / single session.

---

# Phase 10 — Image generation

Bắt đầu sau khi Job + Artifact + Upload/Download ổn định.

```ts
interface ImageGenerationProvider {
  generateImage(input: ImageGenerationInput): Promise<SubmittedTurn>;
}
```

```json
{
  "prompt": "A futuristic backend engineer workstation",
  "aspect_ratio": "16:9",
  "reference_images": ["/workspace/ref.png"]
}
```

```text
job_id → running → completed → Artifact(image)
```

---

# Phase 11 — Video generation

Video job dài, state phức tạp ⇒ chạy trên daemon mode.

```json
{
  "prompt": "...",
  "duration_seconds": 10,
  "aspect_ratio": "9:16",
  "reference_images": []
}
```

```text
submit → job created → page-watch / poll (giãn cách) → detect complete → download → artifact
```

- Provider tự xử lý cách platform báo completion; MCP layer chỉ thấy job state.
- Phải recover sau browser reload / daemon restart: lưu đủ thông tin (URL generation, id nền tảng) trong job record.

---

# Phase 12 — Multi-provider

Thứ tự:

```text
ChatGPT → Gemini → Claude → Image provider → Video provider
```

Mỗi provider:

```text
<provider>-provider.ts
selectors.ts
capabilities.ts
conversation.ts
completion.ts
extract.ts
page-signals.ts
generation.ts / artifacts.ts (nếu có)
```

Lưu ý Gemini: login Google có thể bị chặn ("This browser or app may not be secure") nếu browser có automation flags. Login flow phải là Chrome thường (spawn bởi launcher, không `--enable-automation`, không Playwright `launch`) — CDP chỉ attach sau khi đã login. Cần verify thực tế khi làm phase này [INFERENCE].

Không copy logic browser session cho từng provider.

---

# 5. Tool design

Ưu tiên semantic tools:

```text
ai_web_chat
ai_web_wait
ai_web_get_response
ai_web_generate_image
ai_web_generate_video
ai_web_upload
ai_web_download
ai_web_job_status
```

Không expose `browser_click`, `browser_fill`, `browser_press`, `browser_eval` cho agent. Low-level chỉ nội bộ hoặc CLI debug/admin.

---

# 6. Session strategy

```text
1 provider ↔ 1 dedicated profile ↔ 1 Chrome process ↔ 1 CDP port (động)
```

```text
~/.ai-web/profiles/
├── chatgpt/
├── gemini/
└── claude/
```

Lợi ích: login state độc lập, cookie isolation, reset từng provider, debug dễ. Chi phí: mỗi provider một Chrome process (RAM) — chấp nhận được.

---

# 7. Concurrency model

MVP: **single-operation per provider profile**, enforced cross-process.

```text
request A → running
request B → SESSION_BUSY (kèm active_job_id), không queue ngầm
```

Lý do reject thay vì queue: queue trong stdio process sẽ mất khi process chết và agent không biết request đã gửi hay chưa.

Daemon mode (Phase 9) mới có queue per provider:

```text
provider A → job 1
provider B → job 2
```

---

# 8. Error handling

| Code | Retryable bởi agent | Ghi chú |
|---|---|---|
| `BROWSER_NOT_FOUND` | no | doctor gợi ý executable |
| `BROWSER_PROFILE_IN_USE` | no | Chrome mở tay không có CDP |
| `BROWSER_CONNECT_FAILED` | yes | |
| `AUTHENTICATION_REQUIRED` | no | chạy `ai-web login <provider>` |
| `HUMAN_VERIFICATION_REQUIRED` | no | captcha/challenge — user xử lý tay, không bypass |
| `RATE_LIMITED` | no | breaker mở |
| `CIRCUIT_OPEN` | no | kèm thời điểm hết cooldown |
| `SESSION_BUSY` | yes (sau `ai_web_wait`) | kèm `active_job_id` |
| `SELECTOR_NOT_FOUND` | no | UI đổi, cần sửa selector |
| `GENERATION_FAILED` | no | lỗi phía platform |
| `GENERATION_TIMEOUT` | no | không tự resend |
| `MODEL_NOT_AVAILABLE` | no | kèm danh sách |
| `JOB_NOT_FOUND` / `JOB_OWNER_LOST` | no | |
| `ARTIFACT_PATH_DENIED` | no | |
| `UNSUPPORTED_CAPABILITY` | no | |

MCP result trả `isError: true` + `structuredContent`:

```json
{
  "error": {
    "code": "AUTHENTICATION_REQUIRED",
    "message": "ChatGPT session is not authenticated. Run: ai-web login chatgpt",
    "retryable": false
  }
}
```

Stack trace chỉ trong log nội bộ.

---

# 9. Observability

Log JSON (pino) ra `~/.ai-web/logs/` + stderr. NEVER stdout (stdio MCP).

Mỗi action:

```text
timestamp, pid, provider, operation, job_id, request_id, status, duration_ms, error_code
```

Khi lỗi: screenshot + HTML snapshot (đã bỏ input value) vào `logs/failures/<job_id>/`.

Không log: cookies, auth headers/tokens, passwords, nội dung prompt/response đầy đủ (chỉ length + hash, trừ khi bật `AI_WEB_LOG_CONTENT=1` để debug).

---

# 10. Security

## Browser profile

- Dedicated profile, thư mục `chmod 700`.
- Không commit / sync profile lên cloud.
- Khuyến nghị dùng tài khoản riêng cho automation, không dùng tài khoản chính có dữ liệu quan trọng.

## CDP exposure

- CDP chỉ ở `127.0.0.1`, nhưng **mọi process local** đều có thể kết nối và đọc cookie của profile — đây chính là vector Chrome ≥136 muốn chặn với default profile. Chấp nhận rủi ro này vì cần reconnect cross-process; giảm thiểu bằng: profile riêng, port động, `ai-web browser stop` khi không dùng.

## File system

Artifact/upload chỉ trong allowlist đã cấu hình, check bằng `realpath`.

## Credentials

Không lưu credential. Login chỉ thủ công trong browser.

---

# 11. Testing strategy

## Unit

- Job state machine + persistence + orphan recovery.
- Idempotency theo `request_id`.
- Profile lock: stale reclaim, contention giữa 2 process thật.
- Circuit breaker / throttle (fake clock).
- Error mapping.
- Path validation (symlink, `..`).
- Bounded wait trả `running` đúng hạn.

## Integration (offline)

- Provider chạy trên **HTML fixtures** (snapshot ChatGPT đã scrub) bằng Chrome thật + `page.setContent`/local server: selector candidates, completion detection (giả lập stop button + streaming mutation), DOM → Markdown.
- MCP: spawn server qua stdio bằng MCP client SDK, provider giả.

## E2E (manual / opt-in)

```text
launch → login state → open ChatGPT → send test prompt → wait → extract → verify conversation_id
```

Chỉ chạy khi `AI_WEB_E2E=1`, không chạy trong CI (rate limit + ToS).

---

# 12. CLI

```bash
ai-web doctor                 # node version, Chrome path/version (≥136 ok), dirs, permissions
ai-web status
ai-web login chatgpt
ai-web browser start chatgpt
ai-web browser stop chatgpt
ai-web browser reset chatgpt  # xóa profile (confirm)
ai-web breaker clear chatgpt
ai-web test chatgpt           # 1 prompt E2E
```

CLI dùng chung core với MCP để tách lỗi: OMP / MCP / Browser / Provider.

---

# 13. Development milestones

## Milestone 1 — Browser Core

- Spawn Chrome detached với profile riêng, đọc `DevToolsActivePort`.
- `connectOverCDP` được; reconnect từ process khác được.
- Server process exit không kill Chrome.
- Profile lock cross-process hoạt động (test 2 process).
- `ai-web status` / `doctor` chạy.

## Milestone 2 — ChatGPT Provider

- Login thủ công, persistence qua restart Chrome.
- New conversation, send prompt, completion detection, extract Markdown.
- Rate-limit detection + circuit breaker.
- Không resend sau submit trong mọi nhánh lỗi.

## Milestone 3 — MCP MVP (v0.1)

- OMP connect được qua `.omp/mcp.json`.
- `ai_web_chat` trả `completed` cho prompt ngắn, `running` + `ai_web_wait` cho prompt dài > 30s.
- Retry cùng `request_id` không gửi 2 lần.
- Hai OMP session gọi đồng thời ⇒ một chạy, một `SESSION_BUSY`.
- Error mapping đúng bảng §8.

## Milestone 4 — Job + Artifact + Files (v0.2)

- Generic job lifecycle, `ai_web_job_status`, `ai_web_cancel`.
- Upload / download artifact với path validation.

## Milestone 5 — Second provider (v0.3)

- Registry, capabilities, profile isolation.
- MCP schema không đổi.
- Browser Core không sửa.

## Milestone 6 — Daemon mode (v0.4)

- Job sống qua OMP session restart.
- Queue per provider.

## Milestone 7 — Image (v0.5)

## Milestone 8 — Video (v0.6)

- Track long-running job, recover sau reload / daemon restart.

## Milestone 9 — OMP Extension

- `/ai-web status|login|reset`, optional TUI rendering.

---

# 14. Thứ tự triển khai

```text
1. Browser Core (+ cross-process lock)
2. ChatGPT Provider
3. Minimal job + bounded wait
4. MCP server
5. OMP integration (config + verify)
   ── MVP v0.1 cut ──
6. Generic job + artifact + upload/download
7. Second provider
8. Daemon mode
9. Image generation
10. Video generation
11. OMP extension
```

Điểm cắt MVP:

```text
OMP → MCP → AI Web Automation → ChatGPT Web → Markdown response (sync hoặc qua job_id)
```

---

# 15. Phân chia trách nhiệm giữa các layer

```text
┌──────────────────────────────────────────┐
│ Agent / OMP                              │
│ Quyết định khi nào cần AI Web            │
└───────────────────────┬──────────────────┘
                        │ MCP
┌───────────────────────▼──────────────────┐
│ MCP Layer                                │
│ schemas + validation + error mapping     │
│ bounded wait                             │
└───────────────────────┬──────────────────┘
┌───────────────────────▼──────────────────┐
│ Application Layer                        │
│ jobs + idempotency + artifacts           │
└───────────────────────┬──────────────────┘
┌───────────────────────▼──────────────────┐
│ Provider Layer                           │
│ ChatGPT / Gemini / Claude / ...          │
└───────────────────────┬──────────────────┘
┌───────────────────────▼──────────────────┐
│ Browser Core                             │
│ Playwright + CDP + profile lock + safety │
└───────────────────────┬──────────────────┘
┌───────────────────────▼──────────────────┐
│ Chrome (detached, 1 process / profile)   │
└──────────────────────────────────────────┘
```

---

# 16. Những thứ không nên làm

- **Provider tự launch Chrome** — mọi provider dùng chung Browser Core.
- **Expose raw browser primitives cho agent** — chỉ semantic tools.
- **Phụ thuộc một selector duy nhất** — candidate list + diagnostics.
- **Concurrency trong một provider khi chưa có daemon** — UI state rất dễ race.
- **Trộn OMP logic vào core** — core chạy được bằng CLI và MCP không cần OMP.
- **Tool call block vô hạn** — luôn bounded wait.
- **Auto-retry sau submit** — nguồn gốc của spam và prompt trùng.
- **In-process lock làm cơ chế duy nhất** — stdio = nhiều process.
- **Ghi log ra stdout** — hỏng stdio MCP.
- **`launchPersistentContext` cho browser dài hạn** — browser chết theo process.

---

# 17. Risks

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| ToS: OpenAI Terms of Use cấm "automatically or programmatically extract data or Output"; các platform khác thường có điều khoản tương tự | Cao — có thể bị khóa tài khoản | Dùng cho mục đích cá nhân, tài khoản riêng, throttle thấp, không bypass anti-bot/captcha; ghi rõ trong README; user tự chịu trách nhiệm |
| UI đổi làm vỡ selector | Cao, thường xuyên | Candidate selectors, fixtures, failure snapshot, `ai-web test` |
| Rate limit / challenge | Trung bình | Breaker persisted, min interval, dừng khi thấy verification |
| Local process đọc cookie qua CDP | Trung bình | §10 CDP exposure |
| Prompt trùng do retry | Trung bình | `request_id`, active generation guard, no resend |
| Job mất khi OMP session đóng (stdio) | Trung bình trong MVP | Job record persisted + `ai_web_get_response`; daemon mode ở v0.4 |
| Google login chặn automation (Gemini) | Trung bình | Login bằng Chrome thường, attach CDP sau |

---

# 18. Chỉ số thành công

### MVP

- Browser start/reconnect ổn định từ nhiều process.
- ChatGPT login persistence qua restart.
- Prompt → Markdown response thành công trong E2E, kể cả response > 30s qua `ai_web_wait`.
- OMP gọi MCP tool được.
- Không có prompt trùng khi agent retry / OMP reconnect.

### Multi-provider

- Thêm provider mới không sửa Browser Core.
- MCP schema không đổi.
- Profile/session provider độc lập.

### Media generation

- Job dài không block server, sống qua OMP session restart (daemon).
- Artifact lưu local, agent nhận path rõ ràng.

---

# 19. Roadmap

```text
v0.1  ChatGPT Web text + minimal job + bounded wait
v0.2  Generic job, artifact, upload/download
v0.3  Second AI provider
v0.4  Daemon mode + per-provider queue
v0.5  Image generation
v0.6  Video generation
v0.7  Concurrent provider sessions, better recovery, richer observability
v1.0  Stable provider SDK, MCP, CLI, OMP extension, documented provider plugin API
```

---

# 20. Kết luận kiến trúc

```text
                    ┌──────────────────────┐
                    │ OMP / Other Agents   │
                    └──────────┬───────────┘
                               │ MCP (stdio → daemon sau v0.4)
                    ┌──────────▼───────────┐
                    │ MCP Server           │
                    └──────────┬───────────┘
                    ┌──────────▼───────────┐
                    │ Application Core     │
                    │ jobs / artifacts     │
                    └──────────┬───────────┘
                    ┌──────────▼───────────┐
                    │ Provider Adapters    │
                    │ ChatGPT / Gemini /   │
                    │ Claude / Image/Video │
                    └──────────┬───────────┘
                    ┌──────────▼───────────┐
                    │ Browser Core         │
                    │ playwright-core + CDP│
                    │ + cross-process lock │
                    └──────────┬───────────┘
                    ┌──────────▼───────────┐
                    │ Chrome per profile   │
                    └──────────────────────┘
```

**Key decisions:** core độc lập, MCP làm boundary, mọi tool bounded wait + job id, state dùng chung qua filesystem vì stdio là multi-process, không bao giờ resend sau submit. OMP extension chỉ là integration layer tùy chọn.

---

## 21. Reference

- `chatgpt-web-mcp`: https://github.com/Goudu666/chatgpt-web-mcp
- Chrome remote debugging changes (Chrome 136): https://developer.chrome.com/blog/remote-debugging-port
- MCP TypeScript SDK v2: https://ts.sdk.modelcontextprotocol.io/v2/
- MCP Tasks (experimental, 2025-11-25): https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks
- Node.js EOL: https://endoflife.date/nodejs
- OpenAI Terms of Use: https://openai.com/policies/terms-of-use/
- OMP repository: https://github.com/can1357/oh-my-pi
- OMP MCP config: https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-config.md
- OMP MCP transports (timeout/cancellation): https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-protocol-transports.md
- OMP MCP runtime lifecycle (reconnect/retry): https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-runtime-lifecycle.md
- OMP MCP server/tool authoring: https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-server-tool-authoring.md
- OMP extensions: https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md
- OMP custom tools: https://github.com/can1357/oh-my-pi/blob/main/docs/custom-tools.md
