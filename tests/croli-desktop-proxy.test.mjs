import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverDesktopProxy, proxyFromEnvironment } from "../src/croli-desktop-proxy.mjs"
import { BASE, forwardRequest, importDesktopKey, synchronizeDesktopAuth } from "../src/croli.mjs"
import { refreshAccount } from "../src/croli-account.mjs"
import { CroliAuthPlugin } from "../index.mjs"

const token = "a".repeat(64)
const baseURL = "http://127.0.0.1:41000/r/0123456789abcdef/v1"
const auth = { type: "oauth", access: "csk_test", metadata: { userId: "user_test" } }
const environment = (url = baseURL) => `node adapter CODEX_CONFIG=${JSON.stringify({ model_providers: { croli: { base_url: url, env_key: "CROLI_FREE_CODEX_KEY" } } })} CROLI_FREE_CODEX_KEY=${token} HOME=/example`

test("desktop account requests follow official token rotation without borrowing another account", async () => {
  const directory = await mkdtemp(join(tmpdir(), "croli-rotation-test-"))
  try {
    const file = join(directory, "auth.json")
    const session = { ...auth, metadata: { ...auth.metadata, kind: "croli-desktop-proxy", croliAccessToken: "old" } }
    const jwt = ["e30", Buffer.from(JSON.stringify({ sub: "user_test", exp: 2_000_000_000 })).toString("base64url"), "signature"].join(".")
    await writeFile(file, JSON.stringify({ access_token: jwt }))
    assert.equal((await synchronizeDesktopAuth(session, { env: { CROLI_AUTH_FILE: file } })).metadata.croliAccessToken, jwt)
    assert.equal(session.metadata.croliAccessToken, "old")
    const other = { ...session, metadata: { ...session.metadata, userId: "user_other" } }
    assert.equal(await synchronizeDesktopAuth(other, { env: { CROLI_AUTH_FILE: file } }), other)
    assert.equal(await synchronizeDesktopAuth(auth, { env: { CROLI_AUTH_FILE: file } }), auth)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("desktop import and renewal never exchange the official client's rotating refresh token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "croli-session-test-"))
  try {
    const file = join(directory, "auth.json")
    const jwt = ["e30", Buffer.from(JSON.stringify({ sub: "user_test", exp: 2_000_000_000 })).toString("base64url"), "signature"].join(".")
    await writeFile(file, JSON.stringify({ access_token: jwt, refresh_token: "never_exchange" }))
    const fetchImpl = async () => { throw new Error("No account network requests allowed") }
    const desktopProxy = async candidate => candidate.metadata.userId === "user_test" ? { baseURL, token } : null
    const imported = await importDesktopKey({ authFile: file, desktopProxy, fetchImpl })
    assert.equal(imported.key, "croli-desktop-proxy")
    assert.equal(imported.refreshToken, "")
    assert.equal(imported.expiresAt, 0)
    assert.equal(imported.metadata.kind, "croli-desktop-proxy")
    assert.equal(imported.metadata.croliAccessToken, jwt)
    const renewed = await refreshAccount(auth, { env: { CROLI_AUTH_FILE: file }, desktopProxy, fetchImpl })
    assert.equal(renewed.access, "croli-desktop-proxy")
    assert.equal(renewed.refresh, "")
    assert.equal(renewed.expires, 0)
    assert.equal(renewed.metadata.userId, "user_test")
    await assert.rejects(() => refreshAccount({ ...auth, access: imported.key, metadata: imported.metadata }, {
      env: { CROLI_AUTH_FILE: file }, desktopProxy: async () => null, fetchImpl,
    }), error => error.status === 503 && error.signIn === "kept")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("desktop-only credentials never fall back to the remote API or advertise retired models", async () => {
  let called = false
  const desktopAuth = { ...auth, access: "croli-desktop-proxy", metadata: { ...auth.metadata, kind: "croli-desktop-proxy" } }
  const response = await forwardRequest(`${BASE}/chat/completions`, { body: "{}" }, desktopAuth, {
    desktopProxy: async () => null,
    fetchImpl: async () => { called = true; return new Response("unexpected") },
  })
  assert.equal(response.status, 503)
  assert.equal(called, false)
  const plugin = await CroliAuthPlugin({}, { desktopProxy: async () => null })
  assert.equal(Object.keys(await plugin.provider.models({}, { auth: desktopAuth })).length, 6)
})

test("extracts the official loopback proxy without accepting remote or credential-bearing URLs", () => {
  assert.deepEqual(proxyFromEnvironment(environment()), { baseURL, token })
  assert.deepEqual(proxyFromEnvironment(`node CODEX_CONFIG=${JSON.stringify({ model_provider: "magpie", model_providers: { magpie: { base_url: baseURL, env_key: "CROLI_FREE_CODEX_KEY" } } })} CROLI_FREE_CODEX_KEY=${token}`), { baseURL, token })
  for (const url of ["https://attacker.invalid/r/0123456789abcdef/v1", "http://localhost.evil/r/0123456789abcdef/v1", "http://user:pass@127.0.0.1:41000/r/0123456789abcdef/v1", `${baseURL}?key=bad`, `${baseURL}/../other`]) {
    assert.equal(proxyFromEnvironment(environment(url)), null)
  }
  assert.equal(proxyFromEnvironment(environment().replace(token, "invalid")), null)
})

test("discovers only descendants of the official server and requires the same signed-in account", async () => {
  const directory = await mkdtemp(join(tmpdir(), "croli-proxy-test-"))
  try {
    const authFile = join(directory, "auth.json")
    const jwt = ["e30", Buffer.from(JSON.stringify({ sub: "user_test" })).toString("base64url"), "signature"].join(".")
    await writeFile(authFile, JSON.stringify({ access_token: jwt }))
    const processes = "100 1 /Applications/Croli.app/Contents/Resources/bin/arm64/croli-server\n101 100 /usr/local/bin/node\n102 101 /usr/local/bin/node\n200 1 /usr/local/bin/node\n"
    const visited = []
    const run = async (_command, args) => {
      if (args.includes("pid=,ppid=,comm=")) return { stdout: processes }
      const pid = Number(args[args.indexOf("-p") + 1])
      visited.push(pid)
      return { stdout: pid === 100 ? `croli-server CROLI_DATA_DIR=${directory} CROLI_TOKEN=local` : environment() }
    }
    assert.deepEqual(await discoverDesktopProxy(auth, { authFile, run, platform: "darwin" }), { baseURL, token })
    assert.ok(!visited.includes(200))
    visited.length = 0
    assert.equal(await discoverDesktopProxy({ ...auth, metadata: { userId: "another_user" } }, { authFile, run, platform: "darwin" }), null)
    assert.equal(visited.length, 0)
    assert.equal(await discoverDesktopProxy({ type: "api", key: "csk_test" }, { authFile, run, platform: "darwin" }), null)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("desktop transport preserves messages and tools and never forwards gateway or device credentials", async () => {
  const messages = [{ role: "system", content: "Keep this system prompt" }, { role: "user", content: "hello" }]
  const tools = [{ type: "function", function: { name: "read", parameters: { type: "object", additionalProperties: false } } }]
  const response = new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  let captured
  const result = await forwardRequest(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer caller", "x-croli-signature": "untrusted", "x-croli-device-id": "untrusted", "x-croli-device-auth": "untrusted", "x-custom": "kept" },
    body: JSON.stringify({ model: "croli/gpt-6.1-sol", messages, tools, stream: true }),
  }, auth, {
    desktopProxy: async () => ({ baseURL, token }),
    fetchImpl: async (url, init) => { captured = { url, init }; return response },
  })
  assert.equal(result, response)
  assert.equal(captured.url, `${baseURL}/chat/completions`)
  assert.equal(captured.init.headers.authorization, `Bearer ${token}`)
  assert.equal(captured.init.headers["x-croli-signature"], undefined)
  assert.equal(captured.init.headers["x-croli-device-id"], undefined)
  assert.equal(captured.init.headers["x-croli-device-auth"], undefined)
  assert.equal(captured.init.headers["x-custom"], "kept")
  const body = JSON.parse(captured.init.body)
  assert.deepEqual(body.messages, messages)
  assert.deepEqual(body.tools, tools)
  assert.equal(body.model, "gpt-6.1-sol")
})

test("a disconnected desktop proxy returns a retryable error without replaying the POST directly", async () => {
  let calls = 0
  const response = await forwardRequest(`${BASE}/chat/completions`, { method: "POST", body: "{}" }, auth, {
    desktopProxy: async () => ({ baseURL, token }),
    fetchImpl: async () => { calls++; throw new TypeError("connection refused") },
  })
  assert.equal(calls, 1)
  assert.equal(response.status, 503)
  assert.equal((await response.json()).error.code, "upstream_unavailable")
})

test("a non-stream request folds an upstream SSE answer, including tools and usage", async () => {
  const events = [
    { id: "chat_test", model: "upstream", choices: [{ delta: { content: "OK", tool_calls: [{ index: 0, id: "call_test", function: { name: "read", arguments: "{}" } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
  ]
  const stream = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n"
  const response = await forwardRequest(`${BASE}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "gpt-5.6-luna", stream: false }) }, auth, {
    desktopProxy: async () => ({ baseURL, token }),
    fetchImpl: async () => new Response(stream, { headers: { "content-type": "text/event-stream", "content-length": "100" } }),
  })
  assert.match(response.headers.get("content-type"), /application\/json/)
  assert.equal(response.headers.get("content-length"), null)
  const body = await response.json()
  assert.equal(body.choices[0].message.content, "OK")
  assert.equal(body.choices[0].message.tool_calls[0].function.name, "read")
  assert.equal(body.choices[0].finish_reason, "tool_calls")
  assert.equal(body.usage.total_tokens, 12)
})

test("desktop catalog excludes retired channels without querying the unsupported models endpoint", async (context) => {
  context.mock.method(globalThis, "fetch", async () => { throw new Error("The desktop models endpoint is unsupported") })
  const plugin = await CroliAuthPlugin({}, { desktopProxy: async () => ({ baseURL, token }) })
  const models = await plugin.provider.models({}, { auth })
  assert.deepEqual(Object.keys(models), ["DeepSeek-V4.1-Flash", "gpt-6.1-sol", "gpt-5.6-sol", "gpt-5.6-luna", "claude-opus-5.5", "claude-sonnet-5"])
})

test("an incomplete non-stream SSE result cannot become a successful empty response", async () => {
  const response = await forwardRequest(`${BASE}/chat/completions`, { method: "POST", body: '{"stream":false}' }, auth, {
    desktopProxy: async () => ({ baseURL, token }),
    fetchImpl: async () => new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', { headers: { "content-type": "text/event-stream" } }),
  })
  assert.equal(response.status, 504)
})

test("a rotated local proxy token does not expire the upstream account", async () => {
  const response = await forwardRequest(`${BASE}/chat/completions`, { method: "POST", body: "{}" }, auth, {
    desktopProxy: async () => ({ baseURL, token }),
    fetchImpl: async () => new Response("invalid proxy token", { status: 401 }),
  })
  assert.equal(response.status, 503)
  assert.equal(response.headers.get("x-magpie-sign-in"), "kept")
  assert.match((await response.json()).error.message, /Croli/)
})
