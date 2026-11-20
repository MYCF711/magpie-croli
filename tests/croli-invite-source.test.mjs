import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { CroliAuthPlugin } from "../index.mjs"
import {
  ensureInvite,
  parseCroliInviteInput,
  resolveCroliInviteSource,
  writeReservedCroliInvite,
} from "../src/croli-account.mjs"

const json = (data) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } })
const fakeJwt = (sub) => `e30.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.sig`
const account = (uid) => ({ type: "oauth", access: `csk_${uid}`, uid, metadata: { userId: uid, croliAccessToken: fakeJwt(uid) } })

async function seedInvites() {
  const cacheDir = await mkdtemp(join(tmpdir(), "croli-invite-cache-"))
  const configDir = await mkdtemp(join(tmpdir(), "croli-invite-config-"))
  for (const [uid, code, at] of [["user_A", "Preferred123", 1000], ["user_B", "Latest123", 2000]]) {
    await ensureInvite(account(uid), {
      cacheDir,
      now: () => at,
      fetchImpl: async (url) => String(url).includes("/v1/invite/code")
        ? json({ inviteCode: code, inviterRewardCredits: 2500, inviteeRewardCredits: 3000 })
        : json({ completedCount: 0, totalRewardCredits: 0 }),
    })
  }
  await writeFile(join(configDir, "logins.json"), JSON.stringify([{ agent: "plugin:croli", home: "croli", first: true }]))
  await writeFile(join(configDir, "plugin-auth.json"), JSON.stringify({ croli: { metadata: { userId: "user_A" } } }))
  return { cacheDir, configDir }
}

test("邀请输入只接受官方链接或码，拒绝外部 URL 与凭据", () => {
  assert.equal(parseCroliInviteInput("Abc_123").url, "https://www.croli.net/invite/?code=Abc_123")
  assert.equal(parseCroliInviteInput("https://www.croli.net/invite/?code=Abc_123").code, "Abc_123")
  assert.equal(parseCroliInviteInput("").automatic, true)
  assert.equal(parseCroliInviteInput("1").automatic, true)
  assert.equal(parseCroliInviteInput("https://attacker.invalid/?code=Abc_123").ok, false)
  assert.equal(parseCroliInviteInput("csk_secret").ok, false)
  assert.equal(parseCroliInviteInput("eyJabc.def.ghi").ok, false)
})

test("默认首选账号，关闭时最近账号，预留码不被自动覆盖", async () => {
  const { cacheDir, configDir } = await seedInvites()
  try {
    const preferred = resolveCroliInviteSource({ preferFirst: true, cacheDir, configDir })
    assert.equal(preferred.kind, "preferred")
    assert.equal(preferred.code, "Preferred123")
    const latest = resolveCroliInviteSource({ preferFirst: false, cacheDir, configDir })
    assert.equal(latest.kind, "latest")
    assert.equal(latest.code, "Latest123")

    writeReservedCroliInvite("Reserved123", { cacheDir, now: () => 3000 })
    resolveCroliInviteSource({ preferFirst: true, cacheDir, configDir })
    resolveCroliInviteSource({ preferFirst: false, cacheDir, configDir })
    const reservedFile = JSON.parse(await readFile(join(cacheDir, "croli-invite.json"), "utf8"))
    assert.equal(reservedFile.code, "Reserved123")
    assert.equal(reservedFile.source, "chosen")

    const fallback = resolveCroliInviteSource({ preferFirst: true, preferredUid: "missing", cacheDir, configDir })
    assert.equal(fallback.kind, "reserved")
    assert.equal(fallback.code, "Reserved123")
  } finally {
    await rm(cacheDir, { recursive: true, force: true })
    await rm(configDir, { recursive: true, force: true })
  }
})

test("注册登录按宿主形状默认使用首选账号链接，authorize 零网络", async () => {
  const { cacheDir, configDir } = await seedInvites()
  try {
    const plugin = await CroliAuthPlugin({}, { inviteCacheDir: cacheDir, magpieConfigDir: configDir })
    const method = plugin.auth.methods[1]
    assert.equal(method.prompts.length, 1)
    assert.equal((await method.ask({})).key, "invite")
    assert.equal(await method.ask({ invite: "" }), null)
    const result = await method.authorize(undefined)
    assert.equal(result.url, "https://www.croli.net/invite/?code=Preferred123")
    assert.match(result.instructions, /仅新注册账号有效/)
    assert.equal(result.opened, true)
    assert.equal(typeof result.callback, "function")
  } finally {
    await rm(cacheDir, { recursive: true, force: true })
    await rm(configDir, { recursive: true, force: true })
  }
})

test("手动邀请码被记住，非法输入不会进入注册链接", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "croli-manual-invite-"))
  try {
    const plugin = await CroliAuthPlugin({}, { inviteCacheDir: cacheDir })
    const method = plugin.auth.methods[1]
    await method.ask({})
    assert.equal(await method.ask({ invite: "Manual123" }), null)
    const result = await method.authorize(undefined)
    assert.equal(result.url, "https://www.croli.net/invite/?code=Manual123")
    assert.equal(JSON.parse(await readFile(join(cacheDir, "croli-invite.json"), "utf8")).code, "Manual123")

    const invalidPlugin = await CroliAuthPlugin({}, { inviteCacheDir: cacheDir })
    const invalidMethod = invalidPlugin.auth.methods[1]
    const retry = await invalidMethod.ask({ invite: "https://attacker.invalid/?code=bad" })
    assert.match(retry.message, /官方 https 邀请地址/)
  } finally {
    await rm(cacheDir, { recursive: true, force: true })
  }
})
