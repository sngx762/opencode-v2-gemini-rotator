/*
 * Gemini Key Rotator for OpenCode V2.
 * Maintainer: Sabirjanov Abdurahmon.
 * SPDX-License-Identifier: MIT
 * Copyright and license notices: see the accompanying LICENSE file.
 * Targeted and tested against OpenCode 2.2.0 / @opencode/plugin 2.2.0.
 */
import { Plugin } from "@opencode/plugin/effect"
import type { SessionHttpResponse, SessionRetry } from "@opencode/plugin/effect/session"
import { Duration, Effect } from "effect"
import { appendFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const GEMINI_ORIGIN = "https://generativelanguage.googleapis.com"
const MAX_CONFIGURED_KEYS = 256
const MAX_TRACKED_KEYS = 512
const MAX_ERROR_BYTES = 64 * 1024
const ERROR_READ_TIMEOUT_MS = 1_500
const FAILURE_TTL_MS = 2 * 60_000
const MAX_FAILURES = 512
const MIN_COOLDOWN_MS = 250
const MAX_COOLDOWN_MS = 24 * 60 * 60_000

type KeyState = { invalid: boolean; availableAt: number }
type RequestMeta = { candidates: string[] }
type Failure = { at: number; candidates: string[] }
type Classification = { kind: "invalid" } | { kind: "cooldown"; ms: number }

/** Normalize OAuth values so `ya29.x` and `Bearer ya29.x` share one state. */
function normalizeKey(value: string): string | undefined {
  let key = value.trim()
  if (!key) return undefined
  if (/^bearer\s+/i.test(key)) key = `Bearer ${key.replace(/^bearer\s+/i, "")}`
  else if (key.startsWith("ya29.")) key = `Bearer ${key}`
  const secret = key.startsWith("Bearer ") ? key.slice(7) : key
  // Reject CR/LF, whitespace, non-ASCII and unreasonably large header values.
  if (!secret || secret.length > 8_192 || !/^[\x21-\x7e]+$/.test(secret)) return undefined
  return key
}

function uniqueKeys(values: string[]): string[] {
  const keys: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed) continue
    const key = normalizeKey(trimmed)
    if (!key) throw new Error("[gemini-rotator] Invalid key format in plugin configuration")
    if (!keys.includes(key)) keys.push(key)
  }
  if (keys.length > MAX_CONFIGURED_KEYS) {
    throw new Error(`[gemini-rotator] At most ${MAX_CONFIGURED_KEYS} keys are supported`)
  }
  return keys
}

function configuredKeys(options: Readonly<Record<string, unknown>>): string[] {
  const raw = options.keys === undefined ? process.env.GEMINI_API_KEYS : options.keys
  if (raw === undefined) return []
  if (typeof raw === "string") return uniqueKeys(raw.split(","))
  if (Array.isArray(raw) && raw.every((entry) => typeof entry === "string")) {
    return uniqueKeys(raw as string[])
  }
  throw new Error("[gemini-rotator] options.keys must be a string or an array of strings")
}

function logger(options: Readonly<Record<string, unknown>>): (message: string) => void {
  if (options.logFile !== undefined && typeof options.logFile !== "string") {
    throw new Error("[gemini-rotator] options.logFile must be a path string")
  }
  const path = (options.logFile as string | undefined) ||
    (process.env.OPENCODE_GEMINI_DEBUG === "1" ? join(tmpdir(), "gemini-rotator-debug.log") : undefined)
  if (!path) return () => {}
  return (message) => {
    // Never write response bodies, URLs, headers, keys, or exception text.
    void appendFile(path, `[${new Date().toISOString()}] ${message}\n`, { mode: 0o600 }).catch(() => {})
  }
}

function geminiURL(request: Request): URL | undefined {
  try {
    const url = new URL(request.url)
    // Do not send Google credentials to proxies, custom gateways, Vertex, or other hosts.
    return url.origin === GEMINI_ORIGIN ? url : undefined
  } catch {
    return undefined
  }
}

function providedCredentials(request: Request, url: URL): string[] {
  const auth = request.headers.get("authorization")
  const supplied = request.headers.get("x-goog-api-key") || url.searchParams.get("key") ||
    (auth && /^bearer\s+/i.test(auth) ? auth : "")
  if (!supplied) return []
  // The V1 plugin accepted a comma-separated list in an incoming credential.
  return supplied.split(",").map(normalizeKey).filter((key): key is string => key !== undefined)
}

class KeyPool {
  private readonly states = new Map<string, KeyState>()
  private readonly protectedKeys: Set<string>

  constructor(readonly configured: string[]) {
    this.protectedKeys = new Set(configured)
    for (const key of configured) this.state(key)
  }

  state(key: string): KeyState {
    const existing = this.states.get(key)
    if (existing) {
      // LRU order for bounded tracking of dynamically observed credentials.
      this.states.delete(key)
      this.states.set(key, existing)
      return existing
    }
    if (this.states.size >= MAX_TRACKED_KEYS) {
      const evict = [...this.states.keys()].find((item) => !this.protectedKeys.has(item))
      if (evict !== undefined) this.states.delete(evict)
    }
    const created: KeyState = { invalid: false, availableAt: 0 }
    this.states.set(key, created)
    return created
  }

  knows(key: string): boolean {
    return this.states.has(key)
  }

  candidates(request: Request, url: URL): string[] {
    const supplied = providedCredentials(request, url)
    // Match V1: an incoming comma-separated credential supplies its own pool.
    const raw = request.headers.get("x-goog-api-key") || url.searchParams.get("key") ||
      request.headers.get("authorization") || ""
    const candidates = raw.includes(",") ? supplied : [...this.configured, ...supplied]
    return [...new Set(candidates)].slice(0, MAX_CONFIGURED_KEYS)
  }

  choice(candidates: string[], now = Date.now()): { key: string; wait: number } | undefined {
    let earliest: { key: string; wait: number } | undefined
    for (const key of candidates) {
      const state = this.state(key)
      if (state.invalid) continue
      const wait = Math.max(0, state.availableAt - now)
      if (wait === 0) return { key, wait: 0 }
      if (!earliest || wait < earliest.wait) earliest = { key, wait }
    }
    return earliest
  }
}

function sendWithKey(event: { request: Request }, url: URL, key: string): void {
  // Request URL is immutable. Rebuild only when removing a query-string key;
  // Request copies method, body, headers, and signal to the new request.
  if (url.searchParams.has("key")) {
    url.searchParams.delete("key")
    event.request = new Request(url.toString(), event.request)
  }
  if (key.startsWith("Bearer ")) {
    event.request.headers.set("authorization", key)
    event.request.headers.delete("x-goog-api-key")
  } else {
    event.request.headers.set("x-goog-api-key", key)
    event.request.headers.delete("authorization")
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Read a bounded clone, leaving the response OpenCode will consume untouched. */
async function readErrorJSON(response: Response, signal: AbortSignal): Promise<unknown> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancel = () => { if (reader) void reader.cancel().catch(() => {}) }
  try {
    const clone = response.clone()
    if (!clone.body) return undefined
    reader = clone.body.getReader()
    signal.addEventListener("abort", cancel, { once: true })
    if (signal.aborted) return undefined
    timer = setTimeout(cancel, ERROR_READ_TIMEOUT_MS)
    const decoder = new TextDecoder()
    let text = ""
    let bytes = 0
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > MAX_ERROR_BYTES) return undefined
      text += decoder.decode(part.value, { stream: true })
    }
    text += decoder.decode()
    return JSON.parse(text)
  } catch {
    return undefined
  } finally {
    if (timer) clearTimeout(timer)
    signal.removeEventListener("abort", cancel)
    cancel() // Do not await cancellation of one branch of a tee'd stream.
  }
}

function parseDuration(value: string): number | undefined {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/i)
  if (!match) return undefined
  const scale: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }
  const ms = Number(match[1]) * scale[match[2].toLowerCase()]
  return Number.isFinite(ms) ? ms : undefined
}

function retryAfter(headers: Headers, error: Record<string, unknown> | undefined): number | undefined {
  const millis = headers.get("retry-after-ms")
  if (millis && /^\d+(?:\.\d+)?$/.test(millis.trim())) return Number(millis)
  const header = headers.get("retry-after")?.trim()
  if (header) {
    if (/^\d+(?:\.\d+)?$/.test(header)) return Number(header) * 1_000
    const date = Date.parse(header)
    if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  }
  const details = Array.isArray(error?.details) ? error.details : []
  for (const detail of details) {
    const entry = record(detail)
    if (typeof entry?.retryDelay === "string") {
      const ms = parseDuration(entry.retryDelay)
      if (ms !== undefined) return ms
    }
  }
  const message = typeof error?.message === "string" ? error.message : ""
  const match = message.match(/(?:reset\s+after|retry\s+(?:in|after))\s+(\d+(?:\.\d+)?\s*(?:ms|s|m|h))\b/i)
  return match ? parseDuration(match[1]) : undefined
}

function classify(response: Response, data: unknown): Classification | undefined {
  const status = response.status
  if (![400, 403, 429, 503].includes(status)) return undefined
  const error = record(record(data)?.error)
  const message = typeof error?.message === "string" ? error.message.toLowerCase() : ""
  const errorStatus = typeof error?.status === "string" ? error.status.toLowerCase() : ""
  const details = Array.isArray(error?.details) ? error.details : []
  const reasons = details.map((detail) => record(detail)?.reason)
    .filter((reason): reason is string => typeof reason === "string")
    .map((reason) => reason.toLowerCase())

  if ((status === 400 || status === 403) &&
      (message.includes("api key not valid") || reasons.some((reason) => reason.includes("api_key_invalid")))) {
    return { kind: "invalid" }
  }
  const quota = message.includes("quota") || message.includes("rate limit") ||
    reasons.some((reason) => reason.includes("rate_limit") || reason.includes("quota_exceeded")) ||
    errorStatus === "resource_exhausted" || errorStatus === "unavailable"
  // Unlike V1, every 503 rotates, including a non-JSON UNAVAILABLE response.
  if (status !== 429 && status !== 503 && !quota) return undefined
  const suggested = retryAfter(response.headers, error)
  const fallback = status === 429 ? 60_000 : 10_000
  const ms = Number.isFinite(suggested) ? suggested! : fallback
  return { kind: "cooldown", ms: Math.min(MAX_COOLDOWN_MS, Math.max(MIN_COOLDOWN_MS, Math.ceil(ms))) }
}

function scopeKey(event: Pick<SessionHttpResponse, "sessionID" | "agent" | "model">, status: number): string {
  return JSON.stringify([event.sessionID, event.agent, event.model.providerID, event.model.id, status])
}

export default Plugin.define({
  id: "gemini-key-rotator",
  effect: (ctx) => Effect.gen(function* () {
    const options: Readonly<Record<string, unknown>> = ctx.options ?? {}
    const pool = new KeyPool(configuredKeys(options))
    const log = logger(options)
    const requests = new WeakMap<Request, RequestMeta>()
    const failures = new Map<string, Failure[]>()
    log(`loaded: ${pool.configured.length} configured key(s)`)

    yield* ctx.session.hook("http.request", (event) => Effect.gen(function* () {
      const url = geminiURL(event.request)
      if (!url) return
      const candidates = pool.candidates(event.request, url)
      if (candidates.length === 0) return // Let OpenCode handle missing credentials normally.

      // Effect.sleep is interruptible: stopping the session cancels this wait.
      let selected: { key: string; wait: number } | undefined
      for (;;) {
        selected = pool.choice(candidates)
        if (!selected) {
          return yield* Effect.die(new Error("[gemini-rotator] All available Gemini keys are invalid"))
        }
        if (selected.wait <= 0) break
        yield* Effect.sleep(Duration.millis(selected.wait))
        // Re-evaluate after waking: another request may have extended the cooldown.
      }
      sendWithKey(event, url, selected.key)
      requests.set(event.request, { candidates })
      log(`request: key #${candidates.indexOf(selected.key) + 1}/${candidates.length}`)
    }))

    yield* ctx.session.hook("http.response", (event) => Effect.gen(function* () {
      const url = geminiURL(event.request)
      if (!url || ![400, 403, 429, 503].includes(event.response.status)) return
      const sent = providedCredentials(event.request, url)[0]
      if (!sent) return
      const metadata = requests.get(event.request)
      // Another plugin can replace Request after our request hook; only act on a key we know.
      if (!metadata && !pool.knows(sent)) return
      const candidates = metadata?.candidates ?? [...new Set([...pool.configured, sent])]
      if (!candidates.includes(sent)) return

      const data = yield* Effect.promise((signal) => readErrorJSON(event.response, signal))
      const result = classify(event.response, data)
      if (!result) return
      const state = pool.state(sent)
      if (result.kind === "invalid") state.invalid = true
      else state.availableAt = Math.max(state.availableAt, Date.now() + result.ms)
      log(`response: HTTP ${event.response.status}; key #${candidates.indexOf(sent) + 1}/${candidates.length}; ` +
        (result.kind === "invalid" ? "invalid" : `cooldown ${result.ms}ms`))

      // The retry hook has no request ID or kind. Title/generate calls use their
      // own retry path, so they must not overwrite a primary/compaction failure.
      if (event.kind !== "primary" && event.kind !== "compaction") return
      const now = Date.now()
      for (const [key, values] of failures) {
        const fresh = values.filter((failure) => now - failure.at < FAILURE_TTL_MS)
        if (fresh.length === 0) failures.delete(key)
        else failures.set(key, fresh)
      }
      const key = scopeKey(event, event.response.status)
      const list = failures.get(key) ?? []
      list.push({ at: now, candidates })
      failures.delete(key)
      failures.set(key, list.slice(-4))
      while (failures.size > MAX_FAILURES) {
        const first = failures.keys().next().value
        if (first === undefined) break
        failures.delete(first)
      }
    }))

    yield* ctx.session.hook("retry", (event: SessionRetry) => Effect.sync(() => {
      const status = event.error.status
      if (status === undefined) return
      const key = scopeKey(event, status)
      const list = failures.get(key)
      if (!list?.length) return // Do not alter unrelated provider failures.
      const failure = list.pop()!
      if (list.length === 0) failures.delete(key)
      if (Date.now() - failure.at >= FAILURE_TTL_MS) return
      const next = pool.choice(failure.candidates)
      // All invalid: expose the original provider error rather than retry forever.
      event.decision = next ? { retry: true, delay: next.wait } : { retry: false }
      log(next ? `retry: wait ${Math.ceil(next.wait)}ms` : "retry: all keys invalid")
    }))
  }),
})
