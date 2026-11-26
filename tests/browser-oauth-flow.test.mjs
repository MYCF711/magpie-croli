// 浏览器 OAuth 登录契约：magpie 打开默认浏览器，loopback 收回调，再换网关 Key。
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { CroliAuthPlugin } from "../index.mjs"
import { ensureInvite } from "../src/croli-account.mjs"

function jwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".")
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

test("浏览器登录返回 opened:false，并由 loopback 回调完成账号导入", async () => {
  const accessToken = jwt({
    sub: "user_test",
    iss: "https://clerk.croli.net",
    email: "zey@example.com",
    exp: 4_000_000_000,
  })
  const calls = []
  const fetchImpl = async (url, init) => {
    const href = String(url)
    calls.push(href)
    if (href === "https://clerk.croli.net/oauth/token") {
      const form = new URLSearchParams(init.body)
      assert.equal(form.get("grant_type"), "authorization_code")
      assert.equal(form.get("client_id"), "znV4SkcUsY1AektQ")
      assert.equal(form.get("code"), "oauth-code")
      assert.ok((form.get("code_verifier") ?? "").length >= 43)
      return json({ access_token: accessToken, refresh_token: "refresh_test", expires_in: 3600 })
    }
    if (href === "https://api.croli.net/relay/api/relay/search") {
      assert.equal(init.headers.authorization, `Bearer ${accessToken}`)
      return json({
        resources: [{
          sk: "csk_test_key",
          url: "https://ds.croli.net/v1",
          models: ["DeepSeek-V4.1-Flash", "gpt-6-luna", "claude-opus-5.5"],
        }],
      })
    }
    throw new Error(`测试未预期的请求：${href}`)
  }

  const plugin = await CroliAuthPlugin({}, { fetchImpl })
  const flow = await plugin.auth.methods[3].authorize()
  assert.equal(flow.opened, false, "浏览器应由 magpie 打开，避免再起临时 profile")
  assert.equal(flow.method, "auto")
  assert.match(flow.instructions, /默认浏览器/)

  const authUrl = new URL(flow.url)
  assert.equal(authUrl.origin + authUrl.pathname, "https://clerk.croli.net/oauth/authorize")
  assert.equal(authUrl.searchParams.get("client_id"), "znV4SkcUsY1AektQ")
  assert.equal(authUrl.searchParams.get("scope"), "profile email offline_access")
  assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256")
  const redirectUri = authUrl.searchParams.get("redirect_uri")
  assert.match(redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/)

  let pending
  try {
    pending = flow.callback()
    const response = await fetch(`${redirectUri}?code=oauth-code&state=${encodeURIComponent(authUrl.searchParams.get("state"))}`)
    assert.equal(response.status, 200)

    const result = await pending
    assert.equal(result.type, "success")
    assert.equal(result.access, "csk_test_key")
    assert.equal(result.refresh, "refresh_test")
    assert.equal(result.uid, "user_test")
    assert.equal(result.accountId, "zey@example.com")
    assert.equal(result.metadata.userId, "user_test")
    assert.equal(result.metadata.croliAccessToken, accessToken)
    assert.equal(result.metadata.loginMethod, "browser-oauth")
    assert.ok(result.expires > Date.now())
    assert.deepEqual(calls, [
      "https://clerk.croli.net/oauth/token",
      "https://api.croli.net/relay/api/relay/search",
    ])
  } finally {
    flow.close()
    if (pending) await pending.catch(() => {})
  }
})

test("邀请注册走引导页 + 官方邀请链接，回调后保存 browser-oauth-invite 账号", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "croli-invite-flow-cache-"))
  const configDir = await mkdtemp(join(tmpdir(), "croli-invite-flow-config-"))
  const accessToken = jwt({
    sub: "user_new",
    iss: "https://clerk.croli.net",
    email: "new@example.com",
    exp: 4_000_000_000,
  })
  const inviterJwt = jwt({ sub: "user_inviter", iss: "https://clerk.croli.net" })
  const calls = []
  const fetchImpl = async (url, init) => {
    const href = String(url)
    calls.push(href)
    if (href.endsWith("/v1/invite/code")) return json({ inviteCode: "InviteABC", inviterRewardCredits: 2500, inviteeRewardCredits: 3000 })
    if (href.includes("/v1/invite/list")) return json({ completedCount: 0, totalRewardCredits: 0 })
    if (href === "https://clerk.croli.net/oauth/token") {
      const form = new URLSearchParams(init.body)
      assert.equal(form.get("grant_type"), "authorization_code")
      assert.equal(form.get("code"), "invite-oauth-code")
      return json({ access_token: accessToken, refresh_token: "refresh_new", expires_in: 3600 })
    }
    if (href === "https://api.croli.net/relay/api/relay/search") {
      assert.equal(init.headers.authorization, `Bearer ${accessToken}`)
      return json({
        resources: [{
          sk: "csk_new_key",
          url: "https://ds.croli.net/v1",
          models: ["DeepSeek-V4.1-Flash", "gpt-6.1-sol", "claude-opus-5.5"],
        }],
      })
    }
    throw new Error(`测试未预期的请求：${href}`)
  }
  try {
    await ensureInvite(
      { type: "oauth", access: "csk_inviter", metadata: { userId: "user_inviter", croliAccessToken: inviterJwt } },
      { cacheDir, now: () => 1000, fetchImpl },
    )
    await writeFile(join(configDir, "logins.json"), JSON.stringify([{ agent: "plugin:croli", home: "croli", first: true }]))
    await writeFile(join(configDir, "plugin-auth.json"), JSON.stringify({
      croli: { type: "oauth", access: "csk_inviter", uid: "user_inviter", metadata: { userId: "user_inviter", croliAccessToken: inviterJwt } },
    }))

    const plugin = await CroliAuthPlugin({}, { inviteCacheDir: cacheDir, magpieConfigDir: configDir, fetchImpl })
    const method = plugin.auth.methods[1]
    assert.equal((await method.ask({})).key, "inviteSource")
    assert.equal(await method.ask({ inviteSource: "user_inviter" }), null)

    const beforeAuthorize = calls.length
    const flow = await method.authorize(undefined)
    assert.equal(calls.length, beforeAuthorize, "authorize 不再出站取码")
    assert.equal(flow.opened, false)
    assert.match(flow.url, /^http:\/\/127\.0\.0\.1:\d+\/$/)

    const html = await (await fetch(flow.url)).text()
    assert.ok(html.includes("https://www.croli.net/invite/?code=InviteABC"))
    const authUrl = new URL(html.match(/href="(https:\/\/clerk\.croli\.net\/oauth\/authorize\?[^"]+)"/)[1].replaceAll("&amp;", "&"))
    const redirectUri = authUrl.searchParams.get("redirect_uri")

    let pending
    try {
      pending = flow.callback()
      const response = await fetch(`${redirectUri}?code=invite-oauth-code&state=${encodeURIComponent(authUrl.searchParams.get("state"))}`)
      assert.equal(response.status, 200)
      const result = await pending
      assert.equal(result.type, "success")
      assert.equal(result.access, "csk_new_key")
      assert.equal(result.uid, "user_new")
      assert.equal(result.metadata.loginMethod, "browser-oauth-invite")
      assert.ok(calls.includes("https://clerk.croli.net/oauth/token"))
      assert.ok(calls.includes("https://api.croli.net/relay/api/relay/search"))
      assert.equal(calls.filter((href) => href.includes("/invite/claim")).length, 0, "插件不替用户提交邀请")
    } finally {
      flow.close()
      if (pending) await pending.catch(() => {})
    }
  } finally {
    await rm(cacheDir, { recursive: true, force: true })
    await rm(configDir, { recursive: true, force: true })
  }
})
