import { strict as assert } from "node:assert"
import { test } from "node:test"
import { readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import plugin from "../index.js"

type Handler = (event: any) => Effect.Effect<void>
type Event = { sessionID: string; agent: string; model: { providerID: string; id: string }; kind: string; request: Request }

async function harness(options: Record<string, unknown> = {}) {
  const hooks = new Map<string, Handler>()
  const ctx = {
    options,
    session: {
      hook(name: string, callback: Handler) {
        hooks.set(name, callback)
        return Effect.succeed({ dispose: Effect.void })
      },
    },
  } as unknown as Parameters<typeof plugin.effect>[0]
  await Effect.runPromise(Effect.scoped(plugin.effect(ctx)))
  return {
    hooks,
    async request(event: Event, signal?: AbortSignal) {
      await Effect.runPromise(hooks.get("http.request")!(event), { signal })
    },
    async response(event: Event, response: Response) {
      await Effect.runPromise(hooks.get("http.response")!({ ...event, response }))
    },
    async retry(event: Event, status: number, initial: { retry: false } | { retry: true; delay: number } = { retry: false }) {
      const next = {
        sessionID: event.sessionID, agent: event.agent, model: event.model,
        error: { type: "provider.rate-limit", message: "test", status },
        attempt: 2, decision: initial,
      }
      await Effect.runPromise(hooks.get("retry")!(next))
      return next.decision
    },
  }
}

function req(key?: string, options: { url?: string; sessionID?: string; kind?: string; body?: string } = {}): Event {
  const headers: Record<string, string> = { "content-type": "application/json", "x-custom": "preserved" }
  if (key) headers["x-goog-api-key"] = key
  return {
    sessionID: options.sessionID ?? "session-1",
    agent: "build",
    model: { providerID: "google", id: "gemini-test" },
    kind: options.kind ?? "primary",
    request: new Request(options.url ?? "https://generativelanguage.googleapis.com/v1beta/models/demo:streamGenerateContent?alt=sse", {
      method: "POST", headers, body: options.body ?? '{"contents":["hello"]}',
    }),
  }
}

function error(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

const keyOf = (event: Event) => event.request.headers.get("x-goog-api-key")

test("exports a V2 effect definition and registers only native V2 session hooks", async () => {
  assert.equal(plugin.id, "gemini-key-rotator")
  assert.equal(typeof plugin.effect, "function")
  const h = await harness({ keys: ["alpha", "beta"] })
  assert.deepEqual([...h.hooks.keys()], ["http.request", "http.response", "retry"])
})

test("429 rotates and the retry goes out with the second key, preserving body and headers", async () => {
  const h = await harness({ keys: ["alpha", "beta"] })
  const a = req("alpha", { body: '{"contents":[{"text":"hi"}]}' })
  await h.request(a)
  assert.equal(keyOf(a), "alpha")
  const response = error(429, { error: { message: "Quota exceeded" } })
  await h.response(a, response)
  assert.match(await response.text(), /Quota exceeded/) // original body was not consumed
  assert.deepEqual(await h.retry(a, 429), { retry: true, delay: 0 })
  const b = req("alpha", { body: '{"contents":[{"text":"hi"}]}' })
  await h.request(b)
  assert.equal(keyOf(b), "beta")
  assert.equal(b.request.headers.get("x-custom"), "preserved")
  assert.equal(await b.request.text(), '{"contents":[{"text":"hi"}]}')
})

test("GEMINI_API_KEYS accepts six keys and rotates through the full pool", async () => {
  const old = process.env.GEMINI_API_KEYS
  const keys = ["key-1", "key-2", "key-3", "key-4", "key-5", "key-6"]
  process.env.GEMINI_API_KEYS = keys.join(",")
  try {
    const h = await harness()
    for (const [index, expected] of keys.entries()) {
      const event = req(keys[0])
      await h.request(event)
      assert.equal(keyOf(event), expected)
      if (index < keys.length - 1) {
        await h.response(event, error(429, {}))
        assert.deepEqual(await h.retry(event, 429), { retry: true, delay: 0 })
      }
    }
  } finally {
    if (old === undefined) delete process.env.GEMINI_API_KEYS
    else process.env.GEMINI_API_KEYS = old
  }
})

test("configured pools allow 256 distinct keys and reject a 257th", async () => {
  const keys = Array.from({ length: 256 }, (_, index) => `key-${index + 1}`)
  const h = await harness({ keys })
  const event = req(keys[0])
  await h.request(event)
  assert.equal(keyOf(event), keys[0])
  await assert.rejects(harness({ keys: [...keys, "key-257"] }), /At most 256 keys/)
})

test("all 503 responses rotate, even when the body is not JSON", async () => {
  const h = await harness({ keys: ["alpha", "beta"] })
  const a = req("alpha")
  await h.request(a)
  await h.response(a, error(503, "unavailable"))
  assert.deepEqual(await h.retry(a, 503), { retry: true, delay: 0 })
  const b = req("alpha")
  await h.request(b)
  assert.equal(keyOf(b), "beta")
})

test("unrelated HTTP status and unrelated hosts remain untouched", async () => {
  const h = await harness({ keys: ["alpha", "beta"] })
  const outside = req("original", { url: "https://example.com/v1?key=original" })
  const before = outside.request
  await h.request(outside)
  assert.equal(outside.request, before)
  assert.equal(keyOf(outside), "original")
  const a = req("alpha")
  await h.request(a)
  await h.response(a, error(500, "server error"))
  const prior = { retry: true as const, delay: 876 }
  assert.deepEqual(await h.retry(a, 500, prior), prior)
  const b = req("alpha")
  await h.request(b)
  assert.equal(keyOf(b), "alpha")
})

test("only the exact HTTPS Google endpoint receives configured credentials", async () => {
  const h = await harness({ keys: ["secret-one", "secret-two"] })
  for (const url of [
    "http://generativelanguage.googleapis.com/v1",
    "https://generativelanguage.googleapis.com.evil.example/v1",
    "https://generativelanguage.googleapis.com:8443/v1",
    "https://aiplatform.googleapis.com/v1",
  ]) {
    const e = req("incoming", { url })
    await h.request(e)
    assert.equal(keyOf(e), "incoming")
  }
})

test("a quota 403 rotates; unrelated 403 stays untouched", async () => {
  const normal = await harness({ keys: ["alpha", "beta"] })
  const a = req("alpha")
  await normal.request(a)
  await normal.response(a, error(403, { error: { message: "Permission denied", status: "PERMISSION_DENIED" } }))
  assert.deepEqual(await normal.retry(a, 403), { retry: false })
  const b = req("alpha")
  await normal.request(b)
  assert.equal(keyOf(b), "alpha")

  const quota = await harness({ keys: ["alpha", "beta"] })
  const c = req("alpha")
  await quota.request(c)
  await quota.response(c, error(403, { error: { message: "quota exceeded", status: "RESOURCE_EXHAUSTED" } }))
  assert.deepEqual(await quota.retry(c, 403), { retry: true, delay: 0 })
  const d = req("alpha")
  await quota.request(d)
  assert.equal(keyOf(d), "beta")
})

test("invalid API keys are excluded and the last invalid key returns the original failure", async () => {
  const h = await harness({ keys: ["alpha", "beta"] })
  const invalid = { error: { message: "API key not valid", details: [{ reason: "API_KEY_INVALID" }] } }
  const a = req("alpha")
  await h.request(a)
  await h.response(a, error(400, invalid))
  assert.deepEqual(await h.retry(a, 400), { retry: true, delay: 0 })
  const b = req("alpha")
  await h.request(b)
  assert.equal(keyOf(b), "beta")
  await h.response(b, error(400, invalid))
  assert.deepEqual(await h.retry(b, 400, { retry: true, delay: 123 }), { retry: false })
  await assert.rejects(h.request(req("alpha")), /All available Gemini keys are invalid/)
})

test("all keys cooling: native retry gets the earliest wait and later requests do not skip cooldown", async () => {
  const h = await harness({ keys: ["alpha", "beta"] })
  const a = req("alpha")
  await h.request(a)
  await h.response(a, error(429, {}, { "retry-after": "0.30" }))
  const b = req("alpha")
  await h.request(b)
  assert.equal(keyOf(b), "beta")
  await h.response(b, error(503, {}, { "retry-after": "0.60" }))
  const decision = await h.retry(b, 503)
  assert.equal(decision.retry, true)
  if (!decision.retry) throw new Error("expected retry")
  assert.ok(decision.delay > 100 && decision.delay <= 300, `got ${decision.delay}`)
  const start = Date.now()
  const c = req("alpha")
  await h.request(c)
  assert.ok(Date.now() - start >= 100)
  assert.equal(keyOf(c), "alpha")
})

test("cooldown wait in an Effect hook is interruptible", async () => {
  const h = await harness({ keys: ["alpha"] })
  const a = req("alpha")
  await h.request(a)
  await h.response(a, error(429, {}, { "retry-after": "5" }))
  const controller = new AbortController()
  const waiting = h.request(req("alpha"), controller.signal)
  const timer = setTimeout(() => controller.abort(), 25)
  try { await assert.rejects(waiting) } finally { clearTimeout(timer) }
})

test("Retry-After HTTP-date and Google RetryInfo are used, with bounded delays", async () => {
  const h = await harness({ keys: ["alpha"] })
  const a = req("alpha")
  await h.request(a)
  const date = new Date(Date.now() + 8_000).toUTCString()
  await h.response(a, error(429, {}, { "retry-after": date }))
  const first = await h.retry(a, 429)
  assert.equal(first.retry, true)
  if (!first.retry) throw new Error("expected retry")
  assert.ok(first.delay > 5_000 && first.delay <= 8_000)

  const h2 = await harness({ keys: ["alpha"] })
  const b = req("alpha")
  await h2.request(b)
  await h2.response(b, error(429, { error: { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "3.5s" }] } }))
  const second = await h2.retry(b, 429)
  assert.equal(second.retry, true)
  if (!second.retry) throw new Error("expected retry")
  assert.ok(second.delay > 3_000 && second.delay <= 3_500)
})

test("native incoming key is an extra candidate; request key is removed from query", async () => {
  const h = await harness({ keys: ["alpha", "beta"] })
  const url = "https://generativelanguage.googleapis.com/v1/models/demo?key=native-key&alt=sse"
  const a = req(undefined, { url, body: '{"contents":["secret prompt"]}' })
  await h.request(a)
  assert.equal(keyOf(a), "alpha")
  assert.equal(new URL(a.request.url).searchParams.has("key"), false)
  assert.equal(new URL(a.request.url).searchParams.get("alt"), "sse")
  assert.equal(await a.request.clone().text(), '{"contents":["secret prompt"]}')
  await h.response(a, error(429, {}))
  const b = req(undefined, { url })
  await h.request(b)
  assert.equal(keyOf(b), "beta")
  await h.response(b, error(429, {}))
  const c = req(undefined, { url })
  await h.request(c)
  assert.equal(keyOf(c), "native-key")
})

test("Bearer and ya29 credentials are normalized and sent only in Authorization", async () => {
  const h = await harness({ keys: ["ya29.token-one", "Bearer other-token"] })
  const a = req("unused")
  await h.request(a)
  assert.equal(a.request.headers.get("authorization"), "Bearer ya29.token-one")
  assert.equal(a.request.headers.has("x-goog-api-key"), false)
  await h.response(a, error(429, {}))
  const b = req("unused")
  await h.request(b)
  assert.equal(b.request.headers.get("authorization"), "Bearer other-token")
  assert.equal(b.request.headers.has("x-goog-api-key"), false)
})

test("empty pool passes requests through; env and inline string options are parsed", async () => {
  const old = process.env.GEMINI_API_KEYS
  delete process.env.GEMINI_API_KEYS
  try {
    const empty = await harness()
    const a = req()
    const before = a.request
    await empty.request(a)
    assert.equal(a.request, before)
    process.env.GEMINI_API_KEYS = " env-one, env-two ,, "
    const fromEnv = await harness()
    const b = req()
    await fromEnv.request(b)
    assert.equal(keyOf(b), "env-one")
    const inline = await harness({ keys: " inline-one , inline-two " })
    const c = req()
    await inline.request(c)
    assert.equal(keyOf(c), "inline-one")
    const explicitlyEmpty = await harness({ keys: [] })
    const d = req()
    await explicitlyEmpty.request(d)
    assert.equal(keyOf(d), null)
  } finally {
    if (old === undefined) delete process.env.GEMINI_API_KEYS
    else process.env.GEMINI_API_KEYS = old
  }
})

test("parallel sessions share cooldowns; retry hints cannot cross session IDs", async () => {
  const h = await harness({ keys: ["alpha", "beta"] })
  const a = req("alpha", { sessionID: "A" })
  const b = req("alpha", { sessionID: "B" })
  await Promise.all([h.request(a), h.request(b)])
  assert.equal(keyOf(a), "alpha")
  assert.equal(keyOf(b), "alpha")
  await Promise.all([h.response(a, error(429, {})), h.response(b, error(429, {}))])
  const other = req("alpha", { sessionID: "C" })
  const unchanged = { retry: true as const, delay: 3_456 }
  assert.deepEqual(await h.retry(other, 429, unchanged), unchanged)
  const c = req("alpha", { sessionID: "C" })
  await h.request(c)
  assert.equal(keyOf(c), "beta")
})

test("title responses do not create a misleading primary retry correlation", async () => {
  const h = await harness({ keys: ["alpha", "beta"] })
  const title = req("alpha", { kind: "title" })
  await h.request(title)
  await h.response(title, error(429, {}))
  const primary = req("alpha", { kind: "primary" })
  const original = { retry: true as const, delay: 777 }
  assert.deepEqual(await h.retry(primary, 429, original), original)
  await h.request(primary)
  assert.equal(keyOf(primary), "beta")
})

test("same-origin Request replacement by another plugin still attributes a known key", async () => {
  const h = await harness({ keys: ["alpha", "beta"] })
  const a = req("alpha")
  await h.request(a)
  a.request = new Request(a.request)
  await h.response(a, error(429, {}))
  assert.deepEqual(await h.retry(a, 429), { retry: true, delay: 0 })
  const b = req("alpha")
  await h.request(b)
  assert.equal(keyOf(b), "beta")
})

test("logs never contain key values, response bodies or prompt bodies", async () => {
  const file = join(tmpdir(), `gemini-rotator-test-${process.pid}-${Date.now()}.log`)
  const secret = "THIS_IS_A_SECRET_KEY_123456789"
  const prompt = "SECRET_PROMPT_CONTENT"
  try {
    const h = await harness({ keys: [secret, "another-key"], logFile: file })
    const a = req(secret, { body: prompt })
    await h.request(a)
    await h.response(a, error(429, { error: { message: `${secret} ${prompt}` } }))
    await h.retry(a, 429)
    // Logging is best effort, asynchronous.
    await new Promise((resolve) => setTimeout(resolve, 80))
    const text = await readFile(file, "utf8")
    assert.ok(text.includes("HTTP 429"))
    assert.ok(!text.includes(secret))
    assert.ok(!text.includes(prompt))
  } finally {
    await rm(file, { force: true })
  }
})

test("malformed config fails without exposing the supplied credential", async () => {
  await assert.rejects(harness({ keys: ["bad\nsecret"] }), /Invalid key format/)
  await assert.rejects(harness({ keys: 42 }), /options.keys/)
})
