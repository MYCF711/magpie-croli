# Croli 免费模型 Croli Free Models for magpie

**兼容 Croli 0.0.19 的本机设备代理，保留旧版 API Key 直通，0 条注入提示词。**

把 Croli 网关变成 magpie 里的原生 OpenAI 兼容供应商。新版免费模型使用官方客户端的本机设备代理，旧版独立 Key 仍保留直通路径；插件不启动客户端或 Agent，不添加提示词。

⚠ **Croli 0.0.18+ 免费模型不再只凭旧 `csk_` Key 放行。** 当前桌面兼容仅支持 macOS Apple Silicon：需要导入同一个 Croli 账号，保持 Croli 与至少一个使用免费模型的 Codex 会话运行。客户端关闭、账号不同或只有手填 Key 时，不会冒用桌面授权。桌面导入不再依赖旧 relay 接口，也不兑换官方客户端的一次性 refresh token；官方客户端负责维持登录。若官方客户端自身提示无法验证登录，先在客户端重新登录；插件不能替代官方登录。

```text
6 个新版桌面模型文本实测通过
1 个官方本机代理负责设备签名
0 个插件启动的客户端或 Agent
0 条附加 system / developer / instructions
```

---

## 功能

- **双路径** —— 已导入的同账号优先复用官方桌面设备代理；无桌面授权时保留原生 `csk_...` 直通。
- **桌面模型目录** —— 新版代理列出实测可用的 DeepSeek、GPT 和 Claude，移除已无通道的旧 Luna 与 Grok。
- **提示词零注入** —— 不添加 Croli 客户端提示词，也不增删调用方的 system、messages、tools 或 schema。
- **流式原样返回** —— SSE 交给 magpie 转发，支持 `[DONE]`、Token usage、思考内容与工具调用。
- **图片输入** —— 四个模型均通过同一测试图识别验证。
- **错误正确分流** —— 登录失效、模型错误、限流、超时和上游不可用分别处理。
- **真实额度可选** —— 一次性导入时显示积分和每日试用额度；纯 API Key 模式不伪造额度读数。
- **自动签到与任务** —— 置顶开关控制每日签到和每日首聊，只有真实对话完成后才上报。
- **自动邀请链接** —— 置顶开关控制官方邀请链接展示；只缓存邀请码，不缓存或展示 token。
- **安全续期** —— 桌面模式复用官方客户端维护的登录，不争用一次性 refresh token；旧直通模式保留 Clerk 续期。

---

## 模型

**新版桌面模式** —— 2026-11-25 文本实测通过 `DeepSeek-V4.1-Flash`、`gpt-6.1-sol`、`gpt-5.6-sol`、`gpt-5.6-luna`、`claude-opus-5.5`、`claude-sonnet-5`。`gpt-6-luna` 与 `grok-4.6` 返回无可用通道。实际上游可能经 OpenRouter、OpenCode 或 Magpie 中转；模型别名不保证等于最终上游标识。

以下是旧版直通路径保留的历史能力记录，不代表新版图片能力已重新验证：

| 发行商 | 模型 ID | 上下文 | 最大输出 | 文本 / 图片 |
|---|---|---:|---:|---|
| DeepSeek | `DeepSeek-V4.1-Flash` | 1,048,576 | 384,000 | ✓ / ✓ |
| OpenAI | `gpt-6-luna` | 1,050,000 | 128,000 | ✓ / ✓ |
| Anthropic | `claude-opus-5.5` | 1,000,000 | 128,000 | ✓ / ✓ |
| xAI | `grok-4.6` | 500,000 | 450,000 | ✓ / ✓ |

声明 `low / medium / high` 思考档；调用方也可以直接传原生 `reasoning_effort`。试用额度用完后可能消耗 Croli 积分，因此插件不会把这些模型误标成永久免费。

---

## 签到 / 每日任务 / 邀请

- **每日签到**：每天 100 积分，连续签到另有奖励；由 Magpie 按北京时间调用，重复执行保持幂等。
- **每日首次对话**：每天 200 积分，非流式确认 choices 或 SSE 完整结束后才上报。
- **一次性导入会话**：首次导入本地会话 100 积分，只读取状态，不伪造导入。
- **邀请链接**：每个 Croli 账号一个稳定官方链接，可重复分享；插件只用 `rotate:false` 读取或首次生成，不自动轮换。
- **首选邀请源**：默认把 Magpie 首选账号排在下拉第一项，可选最新账号、指定账号或手动邀请码，并记住选择。关闭开关时自动使用最近首次见到的账号；手动预留码不被自动覆盖。

「首选账号作为邀请源」「自动签到与每日任务」「回传 Token 用量」都显示完整说明，暂位于模型下方，避开 Magpie 置顶容器与页头 `.top` 的 46px 限高冲突。账户功能需要一次性导入的 Clerk 凭证；纯 API Key 聊天不受影响。

---

## 安装

源码与版本 Release 托管于 [MYCF711/magpie-croli](https://github.com/MYCF711/magpie-croli)，未发布 npm 包。

```bash
magpie plugin add github:MYCF711/magpie-croli
```

然后三选一：

1. **一次性导入**：在 Croli 供应商卡片选择「从本机 Croli 登录态导入 API Key」。新版桌面代理在每次请求前核对本机账号并发现临时代理；保存的仅是桌面模式标记，临时代理凭据不落盘。没有可用代理时才尝试旧账号接口。
2. **邀请注册**：选择「使用邀请链接注册并导入」，在 `inviteSource` 下拉中选择最新账号、指定账号或手动邀请码；默认首选账号并记住选择，仅新注册账号有效。
3. **手动粘贴**：选择「Croli 网关 API Key」，粘贴 `csk_...`。

也可使用命令行进入登录流程：

```bash
magpie plugin login croli
```

验证安装：

```bash
magpie plugin list
curl http://127.0.0.1:3425/v1/models
```

---

## 常见问题

**运行时还需要打开 Croli 吗？** 新版设备代理模式需要，并且至少保留一个免费 Codex 会话；旧版独立 Key 直通不需要。插件不会替你启动客户端或新建会话。

**会不会把官方客户端的系统提示词带给模型？** 插件只复用 HTTP 代理，不通过 Agent 发起对话，不添加或改写调用方的提示词；本机代理完成上游鉴权。

**会不会删除 DSH 或其他调用方的 system prompt？** 不会。零注入不等于删除调用方上下文，原有 messages 和 tools 会原样保留。

**为什么看不到积分、签到和邀请？** 这些账户接口使用另一套 Clerk JWT。纯 API Key 不读取这些信息；若官方接口返回 `unauthenticated`，即使桌面聊天可用，也不代表积分会话有效。插件会明确提示，不编造余额。

**邀请链接会泄露 token 吗？** 不会。链接只包含可公开分享的邀请码；JWT、refresh token 和网关 Key 不会进入链接、邀请缓存或验证报告。

**Key 失效怎么办？** 桌面模式请先确认官方客户端已登录、同账号的免费 Codex 会话正在运行；缺失代理时返回可重试 503，不把桌面标记发送到公网。旧直通模式的网关 Key 被吊销或轮换时，重新导入或更换即可。

**这是官方直连吗？** 不是。它是 Croli 网关的独立客户端，网关还会连接上游服务商。

---

## 参考源

| 来源 | 用在哪 |
|---|---|
| [MYCF711/magpie-plugin-scaffold](https://github.com/MYCF711/magpie-plugin-scaffold)（MIT） | 仓库结构、九钩子、通用模块、检查器与测试契约 |
| [Croli 0.0.17](https://www.croli.net/) 本地解包与接口实测 | 网关地址、四个可用模型、鉴权与上游证据 |
| [DeepSeek Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) | DeepSeek 版本与输出上限交叉核对 |
| [OpenCode Console Models](https://opencode.ai/docs/console/models/) / [OpenRouter Models](https://openrouter.ai/api/v1/models) | 模型 ID、上下文与能力交叉核对 |

实现与验证细节见 [`docs/internals.md`](./docs/internals.md)。

---

> 更新记录：[`CHANGELOG.md`](./CHANGELOG.md)

## 许可

MIT。
