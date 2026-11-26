// 受控浏览器登录：候选排序、pickCookie、等文件。真启动浏览器不在单测里跑。
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const { browserCandidates, findBrowser, selectCookies, waitForFile, buildCroliOAuthUrl, exchangeCroliOAuthCode, beginCroliOAuth, beginCroliInviteOAuth } = await import("../src/browser-login.mjs")

function jwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".")
}

test("Windows 候选：注册表命中优先，Chrome 在 Edge 前，国产浏览器在列", () => {
  const env = {
    LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local",
    APPDATA: "C:\\Users\\x\\AppData\\Roaming",
    PROGRAMFILES: "C:\\Program Files",
    "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
  }
  const lookup = (exe) => (exe === "360ChromeX.exe" ? "C:\\360\\360ChromeX.exe" : "")
  const list = browserCandidates({ platform: "win32", env, lookup })
  const names = list.map((b) => b.name)
  assert.equal(list[0].path, "C:\\360\\360ChromeX.exe", "注册表命中的 360 极速应排最前")
  assert.ok(names.indexOf("Chrome") < names.indexOf("Edge"), "Chrome 在 Edge 之前")
  assert.ok(names.some((n) => n.includes("QQ")), "QQ 浏览器在候选里")
  assert.ok(list.every((b) => b.path), "候选不应有空路径")
})

test("findBrowser 只返回真实存在的候选；找不到返回 null", () => {
  const env = { PROGRAMFILES: "C:\\PF", LOCALAPPDATA: "C:\\L" }
  const chrome = join("C:\\PF", "Google", "Chrome", "Application", "chrome.exe")
  const found = findBrowser({
    platform: "win32",
    env,
    lookup: () => "",
    exists: (p) => p === chrome,
  })
  assert.equal(found.name, "Chrome")
  assert.equal(findBrowser({ platform: "win32", env, lookup: () => "", exists: () => false }), null)
})

test("selectCookies 只取需要的名字，忽略空值，拼成 Cookie header", () => {
  const cookies = [
    { name: "sid", value: "abc" },
    { name: "uid", value: "42" },
    { name: "other", value: "no" },
    { name: "empty", value: "" },
  ]
  assert.deepEqual(selectCookies(cookies, ["sid", "uid", "empty"]), {
    header: "sid=abc; uid=42",
    found: { sid: "abc", uid: "42" },
  })
  assert.deepEqual(selectCookies(null, ["sid"]), { header: "", found: {} })
})

test("waitForFile：文件出现返回 true，超时返回 false", async () => {
  const dir = mkdtempSync(join(tmpdir(), "magpie-browser-"))
  const file = join(dir, "ready")
  const pending = waitForFile(file, 500, 20)
  setTimeout(() => writeFileSync(file, "1"), 50)
  assert.equal(await pending, true)
  assert.equal(await waitForFile(join(dir, "missing"), 30, 10), false)
})

test("buildCroliOAuthUrl 使用官方桌面客户端的 PKCE 参数", () => {
  const url = new URL(buildCroliOAuthUrl({
    redirectUri: "http://127.0.0.1:4321/callback",
    challenge: "challenge",
    state: "state",
  }))
  assert.equal(url.origin + url.pathname, "https://clerk.croli.net/oauth/authorize")
  assert.equal(url.searchParams.get("client_id"), "znV4SkcUsY1AektQ")
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:4321/callback")
  assert.equal(url.searchParams.get("scope"), "profile email offline_access")
  assert.equal(url.searchParams.get("code_challenge_method"), "S256")
})

test("exchangeCroliOAuthCode 提交 authorization_code 和 code_verifier", async () => {
  let captured
  const token = await exchangeCroliOAuthCode({
    code: "code",
    redirectUri: "http://127.0.0.1:4321/callback",
    verifier: "verifier",
    fetchImpl: async (url, init) => {
      captured = { url, init }
      return new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
  })
  assert.equal(captured.url, "https://clerk.croli.net/oauth/token")
  assert.equal(captured.init.method, "POST")
  assert.match(captured.init.headers["user-agent"], /^Mozilla\/5\.0/)
  const form = new URLSearchParams(captured.init.body)
  assert.equal(form.get("grant_type"), "authorization_code")
  assert.equal(form.get("client_id"), "znV4SkcUsY1AektQ")
  assert.equal(form.get("code"), "code")
  assert.equal(form.get("code_verifier"), "verifier")
  assert.equal(token.accessToken, "access")
  assert.equal(token.refreshToken, "refresh")
  assert.equal(token.expiresIn, 3600)
})

test("beginCroliOAuth：本地 HTTP 回调先收到 code，complete() 再换 Clerk token", async () => {
  const flow = await beginCroliOAuth({ timeoutMs: 5_000 })
  try {
    const authUrl = new URL(flow.url)
    assert.equal(authUrl.origin + authUrl.pathname, "https://clerk.croli.net/oauth/authorize")
    const redirectUri = authUrl.searchParams.get("redirect_uri")
    assert.equal(redirectUri, flow.redirectUri)
    assert.match(redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/)

    const accessToken = jwt({ sub: "user_1", iss: "https://clerk.croli.net", email: "zey@example.com", exp: 4_000_000_000 })
    const seen = []
    const complete = flow.complete({
      fetchImpl: async (url, init) => {
        seen.push(String(url))
        const form = new URLSearchParams(init.body)
        assert.equal(form.get("grant_type"), "authorization_code")
        assert.equal(form.get("code"), "callback-code")
        assert.equal(form.get("redirect_uri"), redirectUri)
        assert.ok((form.get("code_verifier") ?? "").length >= 43)
        return new Response(JSON.stringify({
          access_token: accessToken,
          refresh_token: "refresh_1",
          expires_in: 3600,
        }), { status: 200, headers: { "content-type": "application/json" } })
      },
    })

    const state = authUrl.searchParams.get("state")
    const response = await fetch(`${redirectUri}?code=callback-code&state=${encodeURIComponent(state)}`)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /登录回调已收到/)

    const token = await complete
    assert.equal(token.accessToken, accessToken)
    assert.equal(token.refreshToken, "refresh_1")
    assert.equal(token.expiresIn, 3600)
    assert.equal(token.payload.sub, "user_1")
    assert.deepEqual(seen, ["https://clerk.croli.net/oauth/token"])
  } finally {
    flow.close()
  }
})

test("beginCroliOAuth：state 不匹配的请求不会结束登录，正确 state 仍能完成", async () => {
  const flow = await beginCroliOAuth({ timeoutMs: 5_000 })
  try {
    const authUrl = new URL(flow.url)
    const redirectUri = authUrl.searchParams.get("redirect_uri")
    const state = authUrl.searchParams.get("state")
    const complete = flow.complete({
      fetchImpl: async () => new Response(JSON.stringify({
        access_token: jwt({ sub: "user_2", iss: "https://clerk.croli.net" }),
        refresh_token: "refresh_2",
        expires_in: 60,
      }), { status: 200, headers: { "content-type": "application/json" } }),
    })

    let settled = false
    complete.then(() => (settled = true), () => (settled = true))
    const wrong = await fetch(`${redirectUri}?code=evil&state=wrong`)
    assert.equal(wrong.status, 400)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(settled, false, "错误 state 不应结束登录")

    const right = await fetch(`${redirectUri}?code=ok&state=${encodeURIComponent(state)}`)
    assert.equal(right.status, 200)
    assert.equal((await complete).payload.sub, "user_2")
  } finally {
    flow.close()
  }
})

test("beginCroliInviteOAuth：引导页只给官方邀请链接和授权链接，回调仍走 loopback", async () => {
  const inviteUrl = "https://www.croli.net/invite/?code=InviteABC"
  const flow = await beginCroliInviteOAuth({ inviteUrl, note: "邀请由官方页面记录。", timeoutMs: 5_000 })
  try {
    assert.match(flow.url, /^http:\/\/127\.0\.0\.1:\d+\/$/)
    assert.equal(flow.inviteUrl, inviteUrl)
    const page = await fetch(flow.url)
    assert.equal(page.status, 200)
    assert.match(page.headers.get("content-security-policy"), /default-src 'none'/)
    const html = await page.text()
    assert.ok(html.includes(inviteUrl))
    assert.ok(html.includes("https://clerk.croli.net/oauth/authorize?"))
    assert.ok(html.includes("邀请由官方页面记录。"))
    assert.doesNotMatch(html, /<script/i)

    const missing = await fetch(`http://127.0.0.1:${flow.port}/nope`)
    assert.equal(missing.status, 404)
    const posted = await fetch(flow.url, { method: "POST" })
    assert.equal(posted.status, 405)

    const authUrl = new URL(html.match(/href="(https:\/\/clerk\.croli\.net\/oauth\/authorize\?[^"]+)"/)[1].replaceAll("&amp;", "&"))
    assert.equal(authUrl.searchParams.get("redirect_uri"), flow.redirectUri)
    const complete = flow.complete({
      fetchImpl: async () => new Response(JSON.stringify({
        access_token: jwt({ sub: "user_invite", iss: "https://clerk.croli.net" }),
        refresh_token: "refresh_invite",
        expires_in: 60,
      }), { status: 200, headers: { "content-type": "application/json" } }),
    })
    const callback = await fetch(`${flow.redirectUri}?code=invite-code&state=${encodeURIComponent(authUrl.searchParams.get("state"))}`)
    assert.equal(callback.status, 200)
    assert.equal((await complete).payload.sub, "user_invite")
  } finally {
    flow.close()
  }
})

test("beginCroliInviteOAuth：只接受 Croli 官方邀请地址，外部 origin 与凭据一律拒绝", async () => {
  for (const inviteUrl of [
    "https://attacker.invalid/invite/?code=InviteABC",
    "http://www.croli.net/invite/?code=InviteABC",
    "https://www.croli.net/invite/?code=",
    "https://www.croli.net/invite/?code=eyJabc.def.ghi",
    "https://www.croli.net/",
    "",
  ]) {
    await assert.rejects(() => beginCroliInviteOAuth({ inviteUrl }), /官方邀请地址/)
  }
})
