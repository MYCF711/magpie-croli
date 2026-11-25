import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

const execute = promisify(execFile)
export const DESKTOP_MODEL_IDS = Object.freeze([
  "DeepSeek-V4.1-Flash", "gpt-6.1-sol", "gpt-5.6-sol", "gpt-5.6-luna", "claude-opus-5.5", "claude-sonnet-5",
])

function environmentValue(text, key) {
  return text.match(new RegExp(`(?:^| )${key}=([^ ]*)`))?.[1] || ""
}

export function proxyFromEnvironment(text) {
  const token = environmentValue(text, "CROLI_FREE_CODEX_KEY")
  if (!/^[a-f0-9]{64}$/.test(token)) return null
  const start = text.indexOf(" CODEX_CONFIG=")
  if (start < 0) return null
  const rest = text.slice(start + " CODEX_CONFIG=".length)
  let depth = 0
  let quoted = false
  let escaped = false
  let length = 0
  for (const character of rest) {
    length++
    if (escaped) { escaped = false; continue }
    if (character === "\\" && quoted) { escaped = true; continue }
    if (character === '"') { quoted = !quoted; continue }
    if (quoted) continue
    if (character === "{") depth++
    if (character === "}" && --depth === 0) break
  }
  try {
    const config = JSON.parse(rest.slice(0, length))
    const provider = config.model_providers?.[config.model_provider || "croli"]
    if (provider?.env_key !== "CROLI_FREE_CODEX_KEY") return null
    const baseURL = provider.base_url
    if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/r\/[a-f0-9]{16}\/v1$/.test(baseURL)) return null
    if (Number(new URL(baseURL).port) > 65535) return null
    return { baseURL, token }
  } catch {
    return null
  }
}

export async function discoverDesktopProxy(auth, {
  authFile = join(homedir(), "Library", "Application Support", "Croli", "auth.json"),
  run = execute,
  platform = process.platform,
} = {}) {
  const uid = auth?.metadata?.userId || auth?.uid
  if (platform !== "darwin" || !uid || auth?.type === "api") return null
  try {
    const document = JSON.parse(await readFile(authFile, "utf8"))
    const localUid = JSON.parse(Buffer.from(document.access_token.split(".")[1], "base64url")).sub
    if (localUid !== uid) return null
    const options = { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }
    const { stdout } = await run("/bin/ps", ["-axo", "pid=,ppid=,comm="], options)
    const processes = stdout.split("\n").map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)).filter(Boolean)
      .map(match => ({ pid: Number(match[1]), parent: Number(match[2]), command: match[3] }))
    for (const server of processes.filter(row => /\/Croli\.app\/Contents\/Resources\/bin\/arm64\/croli-server$/.test(row.command))) {
      const result = await run("/bin/ps", ["eww", "-p", String(server.pid), "-o", "command="], options)
      const directory = result.stdout.match(/(?:^| )CROLI_DATA_DIR=(.*?)(?= [A-Z_]+=|$)/)?.[1]
      if (!directory || join(directory, "auth.json") !== authFile) continue
      const descendants = new Set([server.pid])
      for (let remaining = processes.length; remaining > 0; remaining--) {
        const children = processes.filter(row => descendants.has(row.parent) && !descendants.has(row.pid))
        if (!children.length) break
        for (const child of children) descendants.add(child.pid)
      }
      for (const child of processes.filter(row => descendants.has(row.pid) && /\/node$/.test(row.command))) {
        const result = await run("/bin/ps", ["eww", "-p", String(child.pid), "-o", "command="], options)
        const proxy = proxyFromEnvironment(result.stdout)
        if (proxy) return proxy
      }
    }
  } catch {}
  return null
}
