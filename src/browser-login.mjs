// src/browser-login.mjs —— 打开一个受控 Chromium 窗口，让用户正常登录，再从 CDP 取 Cookie
//
// 什么时候用：厂商没有 OAuth 回调、也没有桌面客户端可导入，但网页登录后 Cookie 就是凭据。
// 比「让用户自己 F12 复制 Cookie」可靠：用户只需要在窗口里登录一次。
//
// 设计取舍（来自 WPS 灵犀 0.4.11 的实测实现，MIT；见 NOTICE.md）：
//   · 任意 Chromium 内核浏览器都行（Chrome / Edge / 360 / QQ / Brave / Vivaldi…），
//     不止 Chrome；国产浏览器在 Windows 上很常见，漏了它们这条登录路对用户就不存在。
//   · Windows 的候选顺序：Chrome → 国产 Chromium → Edge 最后（Edge 策略最多、最容易被组织禁用）。
//   · 用一次性 user-data-dir，不碰用户日常浏览器配置；登录态只在本次窗口里。
//   · 退出码不可靠：浏览器可能把调试参数吞掉，所以以「CDP 端口能不能连上」为准。
//
// ⚠ 只读 Cookie，不写浏览器数据；窗口关闭后临时 profile 会被删掉。
// ⚠ 本模块不依赖任何第三方包；Node 22+ 的全局 WebSocket 足够。

import { spawn } from "node:child_process"
import { existsSync, rmSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import { execFileSync } from "node:child_process"
import { OFFICIAL_UA } from "./http.mjs"
import { generatePkce, randomState, startLoopback } from "./oauth-pkce.mjs"

const WIN_EXES = [
  "chrome.exe",
  "360ChromeX.exe",
  "360chrome.exe",
  "360se.exe",
  "QQBrowser.exe",
  "Brave.exe",
  "vivaldi.exe",
  "opera.exe",
  "SogouExplorer.exe",
  "2345Explorer.exe",
  "liebao.exe",
  "Maxthon.exe",
  "UCBrowser.exe",
  "Quark.exe",
  "msedge.exe",
]

/** Windows 注册表 App Paths 查浏览器；查不到返回空串。 */
export function registryAppPath(exe) {
  if (process.platform !== "win32") return ""
  for (const root of ["HKCU", "HKLM"]) {
    for (const tail of [
      `SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
      `SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
    ]) {
      try {
        const out = execFileSync("reg", ["query", `${root}\\${tail}`, "/ve"], { encoding: "utf8", timeout: 5000 })
        const line = out.split("\n").find((l) => /REG_SZ/i.test(l))
        const path = line?.split("REG_SZ")[1]?.trim()
        if (path && existsSync(path)) return path
      } catch {}
    }
  }
  return ""
}

/**
 * 候选浏览器（按优先级）。不做存在性检查，方便测试与排序。
 * @param {{platform?:string, env?:Record<string,string>, lookup?:(exe:string)=>string}} [o]
 * @returns {{name:string, path:string}[]}
 */
export function browserCandidates({ platform = process.platform, env = process.env, lookup = registryAppPath } = {}) {
  const h = env.HOME || env.USERPROFILE || ""
  const local = env.LOCALAPPDATA || ""
  const roaming = env.APPDATA || ""
  const pf = env.PROGRAMFILES || ""
  const pf86 = env["PROGRAMFILES(X86)"] || env["ProgramFiles(x86)"] || ""
  const add = (list, name, path) => {
    if (path) list.push({ name, path })
  }

  if (platform === "win32") {
    const list = []
    for (const exe of WIN_EXES) {
      const fromRegistry = lookup(exe)
      if (fromRegistry) add(list, exe.replace(/\.exe$/i, ""), fromRegistry)
    }
    add(list, "Chrome", join(pf, "Google", "Chrome", "Application", "chrome.exe"))
    add(list, "Chrome", join(pf86, "Google", "Chrome", "Application", "chrome.exe"))
    add(list, "Chrome", join(local, "Google", "Chrome", "Application", "chrome.exe"))
    add(list, "Chromium", join(local, "Chromium", "Application", "chrome.exe"))
    add(list, "Chromium", join(pf, "Chromium", "Application", "chrome.exe"))
    add(list, "360极速浏览器X", join(local, "360ChromeX", "Chrome", "Application", "360ChromeX.exe"))
    add(list, "360浏览器", join(local, "360Chrome", "Chrome", "Application", "360chrome.exe"))
    add(list, "360安全浏览器", join(roaming, "secoresdk", "360se6", "Application", "360se.exe"))
    add(list, "QQ浏览器", join(local, "Tencent", "QQBrowser", "Application", "QQBrowser.exe"))
    add(list, "Brave", join(pf, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"))
    add(list, "Brave", join(local, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"))
    add(list, "Vivaldi", join(local, "Vivaldi", "Application", "vivaldi.exe"))
    add(list, "Opera", join(local, "Programs", "Opera", "opera.exe"))
    add(list, "Opera", join(roaming, "Opera Software", "Opera Stable", "opera.exe"))
    add(list, "搜狗浏览器", join(local, "SogouExplorer", "SogouExplorer.exe"))
    add(list, "2345浏览器", join(local, "2345Explorer", "2345Explorer.exe"))
    add(list, "猎豹浏览器", join(local, "liebao", "liebao.exe"))
    add(list, "Maxthon", join(roaming, "Maxthon3", "Bin", "Maxthon.exe"))
    add(list, "UC浏览器", join(local, "UCBrowser", "Application", "UCBrowser.exe"))
    add(list, "夸克浏览器", join(local, "Quark", "Quark.exe"))
    add(list, "Edge", join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"))
    add(list, "Edge", join(pf, "Microsoft", "Edge", "Application", "msedge.exe"))
    return dedupe(list)
  }

  if (platform === "darwin") {
    return [
      ["Chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
      ["Chromium", "/Applications/Chromium.app/Contents/MacOS/Chromium"],
      ["Brave", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"],
      ["Vivaldi", "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi"],
      ["Edge", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
    ].map(([name, path]) => ({ name, path }))
  }

  return [
    ["Chrome", join(h, ".config/google-chrome/chrome")],
    ["Chromium", join(h, ".config/chromium/chrome")],
    ["Brave", join(h, ".config/BraveSoftware/Brave-Browser/brave")],
    ["Vivaldi", join(h, ".config/vivaldi/vivaldi")],
    ["Edge", join(h, ".config/microsoft-edge/msedge")],
  ].map(([name, path]) => ({ name, path }))
}

function dedupe(list) {
  const seen = new Set()
  return list.filter((x) => {
    const key = x.path.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** 第一个真实存在的候选；没有返回 null。 */
export function findBrowser({ platform = process.platform, env = process.env, exists = existsSync, lookup = registryAppPath } = {}) {
  return browserCandidates({ platform, env, lookup }).find((b) => exists(b.path)) ?? null
}

/** 从 CDP 的 cookie 列表里挑需要的名字；返回 header 字符串与命中的键。 */
export function selectCookies(cookies, names) {
  const want = new Set(names)
  const found = {}
  for (const c of cookies ?? []) {
    if (!c?.name || !want.has(c.name)) continue
    if (typeof c.value !== "string" || c.value === "") continue
    found[c.name] = c.value
  }
  return { header: Object.entries(found).map(([k, v]) => `${k}=${v}`).join("; "), found }
}

function decodeJwt(value) {
  const token = String(value ?? "").trim()
  const parts = token.split(".")
  if (parts.length !== 3 || !parts.every(Boolean)) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"))
    return payload && typeof payload === "object" && !Array.isArray(payload) ? { token, payload } : null
  } catch {
    return null
  }
}

/** 等一个文件出现；超时返回 false，不抛。 */
export async function waitForFile(file, timeoutMs = 30_000, stepMs = 200) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (existsSync(file)) return true
    await new Promise((r) => setTimeout(r, stepMs))
  }
  return false
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

async function getJson(url, timeoutMs = 5000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

function cdpSend(ws, id, method, params = {}) {
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      let msg
      try { msg = JSON.parse(String(event.data)) } catch { return }
      if (msg.id !== id) return
      ws.removeEventListener("message", onMessage)
      if (msg.error) reject(new Error(msg.error.message || "CDP error"))
      else resolve(msg.result)
    }
    ws.addEventListener("message", onMessage)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function cdpCookies(pageWsUrl) {
  const ws = new WebSocket(pageWsUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true })
    ws.addEventListener("error", () => reject(new Error("CDP WebSocket 连不上")), { once: true })
  })
  try {
    await cdpSend(ws, 1, "Network.enable")
    const result = await cdpSend(ws, 2, "Network.getAllCookies")
    return result?.cookies ?? []
  } finally {
    try { ws.close() } catch {}
  }
}

/**
 * 打开受控浏览器，等用户登录，返回需要的 Cookie。
 *
 * @param {object} o
 * @param {{name:string,path:string}} o.browser findBrowser() 的返回值
 * @param {string} o.url 登录页
 * @param {string[]} [o.cookieNames] 必须拿到的 cookie 名
 * @param {number} [o.timeoutMs] 默认 5 分钟
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<{cookie:string, found:Record<string,string>, browser:string}>}
 */
export async function chromiumLogin({ browser, url, cookieNames = [], timeoutMs = 5 * 60_000, signal }) {
  if (!browser?.path) throw new Error("没有可用的 Chromium 浏览器")
  const profile = mkdtempSync(join(tmpdir(), "magpie-login-"))
  const port = await freePort()
  const child = spawn(browser.path, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    url,
  ], { stdio: "ignore", windowsHide: false })

  const cleanup = () => {
    try { child.kill() } catch {}
    try { rmSync(profile, { recursive: true, force: true }) } catch {}
  }
  const deadline = Date.now() + timeoutMs
  try {
    let pageWs = ""
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("登录已取消")
      try {
        const pages = await getJson(`http://127.0.0.1:${port}/json/list`, 1000)
        pageWs = pages.find((p) => p.type === "page" && p.webSocketDebuggerUrl)?.webSocketDebuggerUrl ?? ""
        if (pageWs) break
      } catch {}
      await new Promise((r) => setTimeout(r, 300))
    }
    if (!pageWs) throw new Error("受控浏览器没有打开调试端口（浏览器可能吞掉了 --remote-debugging-port）")

    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("登录已取消")
      const cookies = await cdpCookies(pageWs).catch(() => [])
      const { header, found } = selectCookies(cookies, cookieNames)
      const ok = cookieNames.length === 0 ? header.length > 0 : cookieNames.every((n) => found[n])
      if (ok) return { cookie: header, found, browser: browser.name }
      await new Promise((r) => setTimeout(r, 1000))
    }
    throw new Error(`登录超时：没有拿到 ${cookieNames.join(" / ")}`)
  } finally {
    cleanup()
  }
}

export function buildCroliOAuthUrl({ redirectUri, challenge, state, clientId = "znV4SkcUsY1AektQ" }) {
  const url = new URL("https://clerk.croli.net/oauth/authorize")
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", clientId)
  url.searchParams.set("redirect_uri", redirectUri)
  url.searchParams.set("scope", "profile email offline_access")
  url.searchParams.set("code_challenge", challenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", state)
  return url.toString()
}

export async function exchangeCroliOAuthCode({ code, redirectUri, verifier, clientId = "znV4SkcUsY1AektQ", fetchImpl = fetch }) {
  const response = await fetchImpl("https://clerk.croli.net/oauth/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": OFFICIAL_UA,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(30_000),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data?.error_description || data?.error || `Clerk OAuth token 返回 HTTP ${response.status}`)
  }
  const accessToken = String(data?.access_token ?? "")
  const refreshToken = String(data?.refresh_token ?? "")
  const expiresIn = Number(data?.expires_in)
  if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("Clerk OAuth 响应缺少 access_token 或有效 expires_in")
  }
  return { accessToken, refreshToken, expiresIn }
}

/**
 * 准备一次 Croli 官方桌面同款 OAuth：本机 loopback 回调 + PKCE S256。
 * 浏览器由 magpie 用系统默认程序打开（authorize 返回 opened:false），
 * 因此会沿用用户 Edge/Chrome 里已有的 Croli、Google、GitHub 登录态。
 */
export async function beginCroliOAuth({ timeoutMs = 5 * 60_000, signal } = {}) {
  const { verifier, challenge } = generatePkce()
  const state = randomState()
  const loopback = await startLoopback({
    state,
    path: "/callback",
    timeoutMs,
    signal,
    successHtml: "<!doctype html><meta charset=\"utf-8\"><title>Croli</title><h2>登录回调已收到</h2><p>可以关闭此页面并返回 Magpie。</p>",
    failureHtml: "<!doctype html><meta charset=\"utf-8\"><title>Croli</title><h2>登录未完成</h2><p>请回到 Magpie 查看错误后重新登录。</p>",
  })
  return {
    url: buildCroliOAuthUrl({ redirectUri: loopback.redirectUri, challenge, state }),
    redirectUri: loopback.redirectUri,
    async complete({ fetchImpl = fetch } = {}) {
      try {
        const callback = await loopback.wait()
        const token = await exchangeCroliOAuthCode({
          code: callback.code,
          redirectUri: loopback.redirectUri,
          verifier,
          fetchImpl,
        })
        const decoded = decodeJwt(token.accessToken)
        return { ...token, payload: decoded?.payload ?? {} }
      } finally {
        loopback.close()
      }
    },
    close: () => loopback.close(),
  }
}

const CROLI_INVITE_URL_RE = /^https:\/\/www\.croli\.net\/invite\/\?code=[A-Za-z0-9_-]{4,128}$/

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch])
}

function inviteGuideHtml({ inviteUrl, oauthUrl, note }) {
  return [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>用邀请链接注册 Croli · Magpie</title></head>',
    '<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;line-height:1.7">',
    "<h2>用邀请链接注册 Croli</h2>",
    `<p>${escapeHtml(note)}</p>`,
    "<ol>",
    `<li><a href="${escapeHtml(inviteUrl)}" target="_blank" rel="noopener noreferrer">打开 Croli 邀请页并登录 / 注册</a>（新标签页打开）<br>仅新注册账号有效，邀请由官方页面在登录后记录；已有账号请回 Magpie 改用「用浏览器登录」。</li>`,
    "<li>邀请页显示登录成功后，回到本页点下面的按钮，再点「允许」。</li>",
    "</ol>",
    `<p><a href="${escapeHtml(oauthUrl)}">继续：授权并导入到 Magpie</a></p>`,
    "<p>本页由 Magpie 插件在本机临时提供，超时前请勿关闭。</p>",
    "</body></html>",
  ].join("")
}

/** 本机引导页：只有两个链接、不执行脚本；Host 必须是 127.0.0.1:<port>，只收 GET。 */
async function listenInviteGuide({ inviteUrl, oauthUrl, note, timeoutMs, signal }) {
  let server
  let port = 0
  let timer = null
  const close = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    signal?.removeEventListener("abort", close)
    try {
      server?.close()
    } catch {}
    try {
      server?.closeIdleConnections?.()
    } catch {}
  }
  const reply = (response, status, text, type = "text/html; charset=utf-8") => {
    if (response.writableEnded) return
    response.writeHead(status, {
      "content-type": type,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      connection: "close",
    })
    response.end(text)
  }
  server = createServer((request, response) => {
    if (request.method !== "GET") return reply(response, 405, "Method not allowed", "text/plain; charset=utf-8")
    if (request.headers.host !== `127.0.0.1:${port}`) return reply(response, 404, "Not found", "text/plain; charset=utf-8")
    if (new URL(request.url ?? "/", "http://127.0.0.1").pathname !== "/") return reply(response, 404, "Not found", "text/plain; charset=utf-8")
    reply(response, 200, inviteGuideHtml({ inviteUrl, oauthUrl, note }))
  })
  await new Promise((resolve, reject) => {
    let listening = false
    server.on("error", (error) => {
      if (!listening) reject(error)
      else close()
    })
    server.listen(0, "127.0.0.1", () => {
      listening = true
      resolve()
    })
  })
  port = server.address().port
  if (signal?.aborted) {
    close()
  } else {
    signal?.addEventListener("abort", close, { once: true })
    timer = setTimeout(close, timeoutMs)
    timer.unref?.()
  }
  return { url: `http://127.0.0.1:${port}/`, port, close }
}

/**
 * 邀请注册的浏览器登录：引导页 → 官方邀请页登录（邀请由官方页面自己记录）→ OAuth 授权 → 换令牌。
 * 引导页交给 magpie 用系统默认浏览器打开；令牌链路复用 beginCroliOAuth。
 */
export async function beginCroliInviteOAuth({ inviteUrl, note = "", timeoutMs = 10 * 60_000, signal } = {}) {
  const target = String(inviteUrl ?? "")
  if (!CROLI_INVITE_URL_RE.test(target)) throw new Error("邀请链接不是 Croli 官方邀请地址")
  const flow = await beginCroliOAuth({ timeoutMs, signal })
  let guide
  try {
    guide = await listenInviteGuide({ inviteUrl: target, oauthUrl: flow.url, note, timeoutMs, signal })
  } catch (error) {
    flow.close()
    throw error
  }
  return {
    url: guide.url,
    port: guide.port,
    inviteUrl: target,
    redirectUri: flow.redirectUri,
    close: () => {
      guide.close()
      flow.close()
    },
    async complete(options) {
      try {
        return await flow.complete(options)
      } finally {
        guide.close()
      }
    },
  }
}

export const _internal = { WIN_EXES, freePort, cdpCookies }
