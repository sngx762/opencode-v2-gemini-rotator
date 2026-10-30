# OpenCode Gemini Rotator V2

[English] | [Русский](README.ru.md)

**Maintained by: Sabirjanov Abdurahmon**

`opencode-v2-gemini-rotator` is a native OpenCode V2 server plugin that provides automatic Google Gemini API key rotation and smart rate-limit fallback. When encountering HTTP 429 (Rate Limit / Quota Exceeded), HTTP 503 (Service Unavailable), quota errors, or invalid keys, it temporarily excludes the active key, selects the next available key from your pool, and triggers OpenCode's native retry pipeline.

Tested and validated on **OpenCode 2.2.0** with a multi-key pool of Google Gemini API keys.

---

## What It Handles

The plugin intercepts responses from `https://generativelanguage.googleapis.com` and automatically classifies error responses to determine rotation policy:

| Status Code / Error | Category / Detection | Plugin Action | Cooldown Period |
| :--- | :--- | :--- | :--- |
| **HTTP 429** | Rate Limit / Resource Exhausted | Marks key on cooldown; rotates to next key in pool | Extracted from `Retry-After`, `retry-after-ms`, or Google `RetryInfo` (Default: 60s) |
| **HTTP 503** | Service Unavailable / Overloaded | Marks key on cooldown; rotates to next key in pool | Extracted from headers/body (Default: 10s) |
| **HTTP 400 / 403** | Quota Exceeded / Resource Exhausted | Marks key on cooldown; rotates to next key in pool | 10s default or parsed from response delay hints |
| **HTTP 400 / 403** | `API_KEY_INVALID` / "API key not valid" | Marks key as **permanently invalid** for current process session | Until plugin or server process reload |
| **Other 4xx / 5xx** | Generic Client/Server Errors | Passed through to OpenCode standard error handling | No key rotation forced |

---

## Who Is This For / Who Is This NOT For

### ✅ Who Is This For
- **Developers using OpenCode V2** with Google Gemini models (`google/gemini-2.5-flash`, `google/gemini-2.5-pro`, `google/gemini-3.7-flash`, etc.).
- Users running into **429 Rate Limit / Quota Exceeded** errors on free-tier or pay-as-you-go Gemini API accounts.
- AI coding agent workflows requiring uninterrupted long-running generation tasks using multiple Google API keys (pool size 1 to 256 keys).
- Developers who want a clean, single-file plugin without `npm install`, build steps, or monkey-patching `globalThis.fetch`.

### ❌ Who Is This NOT For
- **OpenCode V1 Users:** This plugin uses OpenCode V2 Server Plugin APIs (`Plugin.define`, `ctx.session.hook`, Effect runtime) and is incompatible with OpenCode V1.
- **Google Vertex AI / Custom Proxies:** For security and key safety, this plugin exclusively targets the exact origin `https://generativelanguage.googleapis.com`. Custom `baseURL` and Vertex AI endpoints are ignored.
- **Single Google Cloud Project multi-key pools:** Google applies rate limits at the GCP Project level. Using multiple keys generated from the exact same GCP project will not increase your project quota. Use keys across different GCP projects.
- **Users expecting TUI status bars / toast UI popups:** OpenCode V2 plugin API handles backend request hooks. Debug logs are accessible via environment variable (`OPENCODE_GEMINI_DEBUG=1`).

---

## Quick Start & Installation

### Option A: Global Single-File Installation (Recommended)

In POSIX shell (Linux / macOS):

```bash
CONFIG_ROOT="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
mkdir -p "$CONFIG_ROOT/plugins/gemini-rotator"
cp index.ts LICENSE "$CONFIG_ROOT/plugins/gemini-rotator/"
```

OpenCode V2 automatically discovers plugins inside `~/.config/opencode/plugins/gemini-rotator/index.ts`. No `npm install` or compilation step is required.

### Option B: Project-Level Installation

Place `index.ts` and `LICENSE` in `.opencode/plugins/gemini-rotator/` within your project root directory.

---

## Key Configuration

Set your pool of Gemini API keys via the `GEMINI_API_KEYS` environment variable (comma-separated, supporting 1 to 256 keys):

```bash
export GEMINI_API_KEYS='YOUR_GOOGLE_KEY_1,YOUR_GOOGLE_KEY_2,YOUR_GOOGLE_KEY_3'
export GOOGLE_GENERATIVE_AI_API_KEY='YOUR_GOOGLE_KEY_1' # Primary provider key

# Run standalone CLI
opencode run --standalone --model google/gemini-2.5-flash "Write a hello world function"
```

### Managed Background Service

If using `opencode service`:

```bash
opencode service set env GEMINI_API_KEYS "$GEMINI_API_KEYS"
opencode service set env GOOGLE_GENERATIVE_AI_API_KEY "$GOOGLE_GENERATIVE_AI_API_KEY"
opencode service start
```

### JSON Options Configuration (`opencode.json`)

Alternative setup placing source in custom location:

```json
{
  "plugins": [
    {
      "package": "./custom/gemini-rotator",
      "options": {
        "keys": [
          "YOUR_GOOGLE_KEY_1",
          "YOUR_GOOGLE_KEY_2",
          "YOUR_GOOGLE_KEY_3"
        ],
        "logFile": "/tmp/gemini-rotator-debug.log"
      }
    }
  ]
}
```

---

## Debugging

To observe rotation events in real-time, enable debug logging:

```bash
export OPENCODE_GEMINI_DEBUG=1
opencode run --standalone --model google/gemini-2.5-flash "Say hello"
tail -f "${TMPDIR:-/tmp}/gemini-rotator-debug.log"
```

The log records active key indices, HTTP error status codes, and cooldown durations without logging key secrets, request URLs, or payloads.

---

## Documentation & Machine Readable Specs

- **Full HTML Documentation:** [OpenCode Gemini Rotator V2 Docs](https://sngx762.github.io/opencode-v2-gemini-rotator/)
- **Machine Readability (LLMs):** [llms.txt](./llms.txt) | [llms-full.txt](./llms-full.txt)
- **Russian Guide:** [README.ru.md](./README.ru.md)

---

## License

MIT License. See [LICENSE](./LICENSE) for details.
