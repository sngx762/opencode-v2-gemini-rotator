# Gemini Key Rotator for OpenCode V2

English | [Русский](./README.md)

**Maintained by: Sabirjanov Abdurahmon**

A server-side OpenCode V2 plugin that rotates a pool of Gemini API keys. On HTTP 429, HTTP 503, recognized quota errors, or a recognized invalid key, it updates the key state and uses OpenCode's retry mechanism to select another available key. The implementation adapts the V1 rotator's behavior to the V2 API.

**Tested:** The maintainer confirms real-world testing on OpenCode 2.2.0 with Google API keys from six accounts, including successful key switching after actual HTTP 429 and 503 errors. Compatibility with other V2 versions is not guaranteed.

The automated E2E tests in this repository are separate: they use a **local Gemini API mock and fake keys**, not live accounts.

The implementation is [`index.ts`](./index.ts). It exports `Plugin.define({ id, effect })` and explicitly registers `http.request`, `http.response`, and `retry` through `ctx.session.hook`. It does not patch `globalThis.fetch` or wrap a V1 plugin.

## 1. Installation

The following commands are for Linux, macOS, and other POSIX shells. Extract the archive, then run:

```bash
cd opencode-gemini-rotator-v2
CONFIG_ROOT="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
mkdir -p "$CONFIG_ROOT/plugins/gemini-rotator"
cp index.ts LICENSE "$CONFIG_ROOT/plugins/gemini-rotator/"
```

The default location is `~/.config/opencode/plugins/gemini-rotator/index.ts`. OpenCode V2 automatically discovers plugins in this directory. No separate `npm install` or build step is required for normal use: OpenCode loads the single source file. Distribute the accompanying `LICENSE` file with the code to retain the MIT notices.

For a project-local installation, put `index.ts` and `LICENSE` in `.opencode/plugins/gemini-rotator/`. Do not load multiple copies of this plugin. If an older V1 rotator is installed, remove its entry from `plugin`/`plugins` and remove the old automatically discovered files without changing unrelated plugins.

Check your OpenCode version:

```bash
opencode --version
```

## 2. Keys and Google provider activation

The rotator needs a key pool, and the **Google provider must also be activated** in OpenCode. Setting `GEMINI_API_KEYS` alone may not activate the provider.

For a standalone run from the current shell:

```bash
# Replace these placeholders with your own keys; avoid exposing them in shell history.
export GEMINI_API_KEYS='YOUR_GOOGLE_KEY_1,YOUR_GOOGLE_KEY_2,YOUR_GOOGLE_KEY_3,YOUR_GOOGLE_KEY_4,YOUR_GOOGLE_KEY_5,YOUR_GOOGLE_KEY_6'
# The provider credential is usually the first key in the pool.
export GOOGLE_GENERATIVE_AI_API_KEY='YOUR_GOOGLE_KEY_1'

# --standalone starts a private server with this shell's environment.
opencode run --standalone --model google/gemini-3.7-flash "Say hello"
```

The six keys above are an example, not a limit. Configure **1 to 256 keys** separated by commas. Empty entries and duplicates are removed. Google applies rate limits per project rather than per API key, so several keys belonging to the same project generally do not increase its quota.

Choose a model available to your account using `opencode models` or `/models`. The example uses `google/gemini-3.7-flash`. **As of October 27, 2026**, Google marks Gemini 3.7 Flash as deprecated and automatically routes its API requests to Gemini 3.8 Flash [1](https://ai.google.dev/gemini-api/docs/models/gemini-3.7-flash). If 3.7 is missing from your OpenCode catalog, select an available model such as `google/gemini-3.8-flash`.

Instead of setting `GOOGLE_GENERATIVE_AI_API_KEY`, you can connect Google through `/connect` and select a model with `/models`. Use the **Gemini API / Google** provider: Vertex and custom gateways are outside this plugin's scope.

### Background service

Exporting a variable in a shell does not update an already running server. For the managed service, set the variables and restart it:

```bash
# Set the two shell variables shown above first.
opencode service set env GEMINI_API_KEYS "$GEMINI_API_KEYS"
opencode service set env GOOGLE_GENERATIVE_AI_API_KEY "$GOOGLE_GENERATIVE_AI_API_KEY"
opencode service start

opencode run --model google/gemini-3.7-flash "Say hello"
```

If Google is already connected through `/connect`, setting the provider credential through the service may not be necessary. `service set env` stores a value in service configuration and stops the running service; run `service start` after making all changes. Use `opencode service restart` after changing plugin files. `--standalone` and `opencode serve` use their own process environments and do not automatically inherit managed-service variables.

**Secrets:** Environment values and commands can appear in shell history, service configuration, or process listings. Do not share `opencode service get env` output or commit real keys. Use a secure storage method appropriate to your system. Configuration and keys are read when the plugin loads; restart the relevant server after changing its environment.

## Alternative: configure a plugin directory with options

Use this approach **instead of**, not in addition to, automatic discovery. Place the source outside `plugins/`:

```bash
CONFIG_ROOT="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
mkdir -p "$CONFIG_ROOT/custom/gemini-rotator"
cp index.ts LICENSE "$CONFIG_ROOT/custom/gemini-rotator/"
```

Add an entry to the `plugins` array in your existing `$CONFIG_ROOT/opencode.json` without overwriting other settings:

```json
{
  "plugins": [
    {
      "package": "./custom/gemini-rotator",
      "options": {
        "keys": [
          "YOUR_GOOGLE_KEY_1", "YOUR_GOOGLE_KEY_2", "YOUR_GOOGLE_KEY_3",
          "YOUR_GOOGLE_KEY_4", "YOUR_GOOGLE_KEY_5", "YOUR_GOOGLE_KEY_6"
        ],
        "logFile": "/tmp/gemini-rotator-custom.log"
      }
    }
  ]
}
```

`package` points to a **directory**, not directly to `index.ts`. Relative paths are resolved from the configuration file. `keys` can also be a comma-separated string. An explicitly supplied `options.keys`, even an empty array, takes precedence over `GEMINI_API_KEYS`. `logFile` is optional. Anyone who can read the JSON file can read keys stored there: restrict file permissions and keep secrets out of version control. Google provider activation is still required.

## How it works

1. For requests to the exact origin `https://generativelanguage.googleapis.com`, the first available configured key is selected. A single incoming `x-goog-api-key`, `?key=`, or Bearer credential is appended if not already present. As in V1, a comma-separated incoming credential specifies its own request pool. Empty entries and duplicates are removed; there is a limit of 256 candidates.
2. API keys are sent in `x-goog-api-key`; `ya29.*` and `Bearer ...` credentials use `Authorization`. The `?key=` query parameter is removed. Configured credentials are not inserted for other origins.
3. HTTP **429**, any HTTP **503**, and recognized quota errors in **400/403** place a key on cooldown. The plugin considers `retry-after-ms`, `Retry-After`, Google `RetryInfo.retryDelay`, and suitable hints in the error message. The default is 60 seconds for 429 and 10 seconds for other eligible errors, bounded to 250 ms–24 hours.
4. An `API_KEY_INVALID` reason or `API key not valid` message in a 400/403 response invalidates the key until the plugin instance reloads. Unrelated 400/403 errors and other status codes are not classified as rotation triggers.
5. If every valid key is cooling down, the earliest available time is selected. The wait before a new request uses interruptible `Effect.sleep`. If all keys are invalid, a retry is not forced, and a new request fails. Key state is kept in memory and is cleared when the plugin instance reloads.
6. The plugin does not send an extra HTTP request itself: it adjusts OpenCode's native retry decision and substitutes a key on the next attempt.

## Important limitations

- **Retries are finite.** In OpenCode 2.2.0, the main flow allows up to 10 retries after the first attempt; some errors, such as timeouts, have a lower limit. A request can still fail after the retry budget is exhausted or after output has started. Long waits can also exceed a surrounding timeout. This differs from V1's internal infinite retry loop.
- V2's `retry` event does not carry the original HTTP request ID. The plugin correlates failures on a best-effort basis using session, agent, model, status, and an expiry time. Concurrent requests in the same session can be correlated incorrectly. `title` and `generate` use a separate retry path: their 429/503 responses affect the key pool, but forced retries for 400/403 are not available in every path.
- Only the exact HTTPS Gemini API origin is supported. Custom `baseURL` values, Vertex AI, and third-party gateways are intentionally excluded to avoid sending configured keys to another host. A standard HTTPS CONNECT proxy that preserves the original URL is supported.
- Google [rate limits are per project](https://ai.google.dev/gemini-api/docs/rate-limits), not per API key. Check the limits and terms of the projects you use.
- The V1 TUI sidebar, toast notifications, and status JSON are **not included**. Use the optional debug log to observe rotations.
- Wait interruption is covered by an Effect unit test; end-to-end cancellation from the real OpenCode UI has not been tested separately.

## Debugging

For a standalone run:

```bash
export OPENCODE_GEMINI_DEBUG=1
opencode run --standalone --model google/gemini-3.7-flash "Say hello"
tail -f "${TMPDIR:-/tmp}/gemini-rotator-debug.log"
```

The log is written to the server process's `os.tmpdir()`, which may be different on your system. For the managed service, set `OPENCODE_GEMINI_DEBUG` using `opencode service set env`, then run `opencode service start`. Alternatively, specify an absolute `options.logFile` path. The log includes a key's position in the pool and HTTP status, but not key values, URLs, request or response bodies, or exception text. A new file is created with mode `0600`; existing permissions are not changed. Logging failures do not abort requests.

If rotation does not appear, check that OpenCode V2 is in use, the plugin is not loaded twice, Google is activated, the **server** has the environment variables, and the endpoint has not been redirected to another host. A healthy first key will not rotate until a qualifying error occurs.

## Testing and development

No test files or `npm install` are required for ordinary use. For development, install Node.js (22.19+ recommended for dependencies) and npm:

```bash
npm ci
npm test
npm run typecheck
```

The optional black-box test starts a real OpenCode binary, creates a temporary certificate using `openssl`, and runs a local TLS CONNECT proxy. It simulates Gemini responses without real API keys. It requires OpenSSL with `-addext` support and OpenCode 2.2.0 in PATH:

```bash
npm run test:e2e
# Or specify the CLI path:
npm run test:e2e -- /absolute/path/to/opencode
# More diagnostics:
E2E_DEBUG=1 npm run test:e2e
```

E2E scenarios cover 429/503, quota-related 403, invalid-key 400, all keys on cooldown, all keys invalid, and automatic discovery of `index.ts`. Unit tests additionally cover a six-key `GEMINI_API_KEYS` pool and the 256-key limit.

## Documentation and license

- OpenCode documentation: [V1-to-V2 migration](https://opencode.ai/v2/docs/build/plugins/migrate-v1/), [server hooks](https://opencode.ai/v2/docs/build/plugins/server/), [plugin loading](https://opencode.ai/v2/docs/plugins/), and [service environment](https://opencode.ai/v2/docs/network/).
- License: MIT. Keep [`LICENSE`](./LICENSE), including its existing copyright and permission notices, with redistributed copies of the code.
