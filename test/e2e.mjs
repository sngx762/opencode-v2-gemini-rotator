// Optional black-box test against a real OpenCode binary. No real API keys or
// external traffic are used: a local CONNECT proxy simulates the Google API.
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import tls from "node:tls"
import { fileURLToPath } from "node:url"

const binary = process.argv[2] ?? "opencode"
const pluginDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const root = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-rotator-e2e-"))
const keyPath = path.join(root, "fake.key")
const certPath = path.join(root, "fake.crt")
let proxy
let connections = new Set()

function runOpenCode(args, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = "", stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`OpenCode timed out\nstdout: ${stdout}\nstderr: ${stderr}`)) }, 25_000)
    child.once("error", (err) => { clearTimeout(timer); reject(err) })
    child.once("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}

try {
  const cert = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes",
    "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=generativelanguage.googleapis.com",
    "-addext", "subjectAltName=DNS:generativelanguage.googleapis.com", "-addext", "basicConstraints=critical,CA:TRUE"],
    { stdio: "ignore" })
  if (cert.status !== 0) throw new Error("The E2E test requires openssl with -addext support")
  const secureContext = tls.createSecureContext({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) })
  let scenario = "429"
  let calls = []
  const seen = new Set()

  const provider = http.createServer((req, res) => {
    const key = req.headers["x-goog-api-key"] || req.headers.authorization || ""
    req.resume()
    req.on("end", () => {
      calls.push(key)
      if (process.env.E2E_DEBUG === "1") console.log("mock request", scenario, key, req.url)
      const tag = `${scenario}:${key}`
      const fail = scenario === "both-once" ? !seen.has(tag) : scenario === "all-invalid" ? true : key === "fake-key-1"
      seen.add(tag)
      if (fail) {
        const status = scenario === "both-once" ? 429 : scenario === "all-invalid" ? 400 : Number(scenario)
        const error = status === 400
          ? { code: 400, status: "INVALID_ARGUMENT", message: "API key not valid.", details: [{ reason: "API_KEY_INVALID" }] }
          : { code: status, status: status === 503 ? "UNAVAILABLE" : "RESOURCE_EXHAUSTED", message: "Synthetic error" }
        res.writeHead(status, { "content-type": "application/json", "retry-after": "1" })
        res.end(JSON.stringify({ error }))
        return
      }
      if (key !== "fake-key-2" && !(scenario === "both-once" && key === "fake-key-1")) {
        res.writeHead(401).end()
        return
      }
      const event = { candidates: [{ content: { role: "model", parts: [{ text: "ROTATION_OK" }] }, finishReason: "STOP", index: 0 }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3, totalTokenCount: 7 }, modelVersion: "gemini-2.5-flash" }
      if ((req.url || "").includes("streamGenerateContent")) {
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.end(`data: ${JSON.stringify(event)}\n\n`)
      } else {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify(event))
      }
    })
  })

  proxy = http.createServer((_req, res) => res.writeHead(502).end())
  proxy.on("connect", (req, socket, head) => {
    connections.add(socket)
    socket.once("close", () => connections.delete(socket))
    socket.on("error", () => {})
    if (process.env.E2E_DEBUG === "1") console.log("CONNECT", req.url)
    if (req.url !== "generativelanguage.googleapis.com:443") {
      socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n")
      return
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
    if (head.length) socket.unshift(head)
    const wrapped = new tls.TLSSocket(socket, { isServer: true, secureContext })
    wrapped.on("error", () => {})
    provider.emit("connection", wrapped)
  })
  proxy.listen(0, "127.0.0.1")
  await once(proxy, "listening")
  const address = proxy.address()
  if (!address || typeof address === "string") throw new Error("Could not start test proxy")
  const proxyURL = `http://127.0.0.1:${address.port}`
  const project = path.join(root, "project")
  const home = path.join(root, "home")
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(home, { recursive: true })
  const logFile = path.join(root, "rotator.log")
  fs.writeFileSync(path.join(project, "opencode.json"), JSON.stringify({ plugins: [{
    package: pluginDir,
    options: { keys: ["fake-key-1", "fake-key-2"], logFile },
  }] }))
  const env = { ...process.env, HOME: home, PWD: project,
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"),
    GOOGLE_GENERATIVE_AI_API_KEY: "fake-key-1", GEMINI_API_KEYS: "", OPENCODE_GEMINI_DEBUG: "0",
    HTTPS_PROXY: proxyURL, HTTP_PROXY: proxyURL, https_proxy: proxyURL, http_proxy: proxyURL,
    NO_PROXY: "localhost,127.0.0.1,::1", no_proxy: "localhost,127.0.0.1,::1", NODE_EXTRA_CA_CERTS: certPath }

  for (const current of ["429", "503", "403", "400", "both-once", "all-invalid"]) {
    scenario = current
    calls = []
    seen.clear()
    fs.writeFileSync(logFile, "")
    const flags = process.env.E2E_DEBUG === "1" ? ["--print-logs", "--log-level", "info"] : []
    const result = await runOpenCode(["--standalone", ...flags, "run", "--model", "google/gemini-2.5-flash",
      "--title", `rotator-${current}`, "Say ROTATION_OK"], env, project)
    const log = fs.readFileSync(logFile, "utf8")
    if (current === "all-invalid") {
      assert.notEqual(result.code, 0, "invalid keys must fail")
      assert.match(log, /retry: all keys invalid/)
    } else {
      assert.equal(result.code, 0, `${current}: ${result.stderr}`)
      assert.match(result.stdout, /ROTATION_OK/)
    }
    const expected = current === "both-once" ? ["fake-key-1", "fake-key-2", "fake-key-1"] : ["fake-key-1", "fake-key-2"]
    assert.deepEqual(calls, expected, `${current}: ${JSON.stringify(calls)}`)
    if (current === "both-once") {
      assert.equal(calls[2], "fake-key-1")
      assert.match(log, /retry: wait [1-9]\d*ms/)
    }
    console.log(`PASS real OpenCode: ${current}`)
  }

  // Exercise auto-discovery of a directory containing only index.ts,
  // with no package.json, node_modules or explicit config.
  fs.rmSync(path.join(project, "opencode.json"))
  const autoDir = path.join(env.XDG_CONFIG_HOME, "opencode", "plugins", "gemini-rotator")
  fs.mkdirSync(autoDir, { recursive: true })
  fs.copyFileSync(path.join(pluginDir, "index.ts"), path.join(autoDir, "index.ts"))
  env.GEMINI_API_KEYS = "fake-key-1,fake-key-2"
  scenario = "429"
  calls = []
  seen.clear()
  const flags = process.env.E2E_DEBUG === "1" ? ["--print-logs", "--log-level", "info"] : []
  const auto = await runOpenCode(["--standalone", ...flags, "run", "--model", "google/gemini-2.5-flash",
    "--title", "rotator-auto", "Say ROTATION_OK"], env, project)
  assert.equal(auto.code, 0, `auto-discovery: ${auto.stderr}`)
  assert.match(auto.stdout, /ROTATION_OK/)
  assert.deepEqual(calls, ["fake-key-1", "fake-key-2"])
  console.log("PASS real OpenCode: auto-discovery with index.ts only")
} finally {
  for (const socket of connections) socket.destroy()
  if (proxy) await new Promise((resolve) => proxy.close(resolve))
  fs.rmSync(root, { force: true, recursive: true })
}
