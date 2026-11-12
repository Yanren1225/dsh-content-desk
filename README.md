# 文案与模型工坊 · dsh-content-desk

[![ci](https://github.com/Yanren1225/dsh-content-desk/actions/workflows/ci.yml/badge.svg)](https://github.com/Yanren1225/dsh-content-desk/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/dsh-content-desk?logo=npm&logoColor=white)](https://www.npmjs.com/package/dsh-content-desk)
[![npm downloads](https://img.shields.io/npm/dm/dsh-content-desk)](https://www.npmjs.com/package/dsh-content-desk)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933?logo=node.js&logoColor=white)](#兼容性)
[![DSH](https://img.shields.io/badge/DSH-0.2.x-4F7CFF)](https://github.com/deepseek-ai/deepseek-harness)

> 在 DeepSeek Harness 里用**任何已注册的模型**审核、润色、改写文案，多模型横向对比；
> 装生图后端后，还能把文案变成封面/配图。
> 包名：`dsh-content-desk` ｜ 版本：`0.1.0` ｜ 兼容：DSH `0.2.x`

*Copywriting toolkit for DeepSeek Harness: review / polish / rewrite copy with any registered model, compare 2–4 models side by side, and turn copy into cover images when an image backend is installed. No extra API keys, no provider lock-in, no runtime dependencies.*

---

## 它是什么

一个 DSH（DeepSeek Harness）插件，把「模型调用」和「文案工作流」装进 6 个工具：

- **不绑定 provider**：模型来自你 DSH 里已配置的 provider，写 `provider/model` 或裸模型名都行，省略时用 DSH 当前默认模型；
- **不需要额外 API key**：文本走 `ctx.llm`，复用 DSH 的路由与鉴权；
- **生图可插拔**：复用 DSH 里已安装的**生图工具**，装什么用什么；没有也不影响文本能力；
- **零运行期依赖**：只用 Node 内置模块。

典型用法：发稿前审一遍文案、同一篇稿子交给几个模型对比、给公众号/小红书文章配一张头图。

## 特性

| 工具 | 做什么 |
| --- | --- |
| `ai_task` | 通用模型调用：翻译、摘要、改写、结构化提取、生成提示词……支持 `system` / `max_tokens` / `temperature` |
| `ai_models` | 列出当前 DSH 可用的文本模型（provider × 模型）与已发现的生图后端（模型/尺寸/质量/背景） |
| `ai_image` | 按提示词出图：可指定后端与模型、尺寸/质量/背景，图片直接显示在对话里 |
| `copy_review` | 文案审核：错别字、病句、事实与逻辑问题、广告法与平台合规风险，并给可直接使用的修改稿 |
| `copy_compare` | 同一份文案并行交给 2–4 个模型评审，分栏对比后择优 |
| `copy_cover` | 文案或画面描述 → 封面/配图：先用模型把文案变成专业生图提示词，再交给生图后端；`only_prompt` 可先只看提示词 |

`copy_review` 支持四种任务：

| `task` | 输出 |
| --- | --- |
| `review_and_polish`（默认） | 总评 + 问题清单 + 完整修改稿 + 需确认 |
| `review` | 总评 + 问题清单 + 关键改写建议（不改全文） |
| `polish` | 总评 + 完整修改稿 + 主要改动 |
| `variants` | 总评 + 问题清单 + A/B/C 三版改写 + 推荐 |

## 安装

前置：DSH `0.2.x`（已在 `0.2.2-rc.1` 验证）。

```powershell
# 方式一：插件管理器（推荐）
#   action = install_bundle
#   target = <本仓库绝对路径>                （本地目录）
#   target = dsh-content-desk@0.1.0         （已发布到 npm 后可用）

# 方式二：命令行（本地目录 / git 仓库）
dsh plugin --profile desktop add <本仓库绝对路径>
dsh plugin --profile desktop add github:Yanren1225/dsh-content-desk#v0.1.0
```

安装后**新开一个对话**（已在运行的会话不会热更新工具清单），让模型调用一次 `ai_models` 确认工具就绪。

文本能力开箱即用。生图需要 DSH 里已经装了一个**生图后端**（见下节），本插件自身不带出图模型。

## 生图后端（可选）

生图不是在插件里跑模型，而是**复用 DSH 里已安装的生图工具**：

- 插件会自动发现这类工具，`ai_models` 会列出当前发现了哪些后端、各支持哪些模型/尺寸/质量；
- 有后端时，`ai_image` 和 `copy_cover` 可以出图；也可以让模型先用 `only_prompt` 只出提示词，对齐方向后再出图；
- 没有后端时，6 个工具照常加载，文本能力完全不受影响，只是调用生图工具时会提示先安装一个后端；
- 常见选择是 Codex 订阅插件（`dsh-codex-subscription`，提供 `codex_image_generate`）；装好并按它的说明登录即可，
  插件不需要额外的生图 key 或配置。

想固定用某个后端时，可以设 `config.imageToolName`；只有一个候选时会自动选中，多个候选时用 `backend` 参数指定。

## 快速开始

先让模型看一眼环境：

```
ai_models
```

然后按需使用（自然语言即可，模型会自己选工具）：

```
帮我用 copy_review 审一下这段文案，平台是小红书，目标读者 25-35 岁女性：
「限时特惠！全网最低价，100% 有效，最后 3 小时！」
```

```
用 copy_compare 把这段文案交给 claude-haiku-5-5、glm-5.3、gpt-5.6-luna 三家审一遍，我看看分歧。
```

```
用 copy_cover 给这篇文章配一张公众号头图，风格：极简几何，先只出提示词给我看。
```

## 模型怎么选

- `model` 可写 `provider/model`（如 `opencode-go/glm-5.3`），也可以只写裸模型名（在 DSH 已注册目录里自动查找）。
- **省略 `model`**：`config.defaultModel` → DSH 当前默认模型 → 第一个可用模型。
- 显式指定模型失败时**不会**静默换成别的模型；未指定模型时失败才会自动回退到 `config.fallbackModel`（默认空 = 第一个可用模型），并在结果里注明原因。
- 裸名查不到会**直接报错**并提示用 `ai_models` 查看，不会瞎猜一个 provider。

### 重试与回退

- 上游偶发**瞬态**错误（`ETIMEDOUT` / `ECONNRESET` / `TRANSPORT` / 空响应）时，**同一路由**重试一次（250ms 后），不换 provider；已有输出则不重试，避免重复计费。
- 显式写 `provider/model` 时**只调这一个路由**，不会改道到别处。
- 未指定模型时，默认模型失败才会回退到 `fallbackModel`，并在 `note` 里说明原因。

### 取消、超时与截断

- 每次调用有**整体预算**（`timeoutMs`），重试与回退共享这一个 deadline；用户取消后不再发起任何新调用。
- 输出命中模型 `max_tokens` 上限时，结果里会提示「可能被截断」；不传 `max_tokens` 就用模型自己的默认上限。
- 推理模型（glm-5.3、deepseek-v4.1-flash 等）如果手工传 `max_tokens`，建议 **≥1024**——思考过程会占用输出预算。

## 配置

全部可调项写在插件行的 `config` 里（profile 的 `cordis.patch.yml`），省略即用默认值：

```yaml
- id: content-desk
  name: dsh-content-desk
  config:
    defaultModel: ''                 # 空 = 用 DSH 当前默认模型
    fallbackModel: ''                # 空 = 回退时选第一个可用模型
    textTimeoutMs: 180000            # 单次文本调用总预算
    compareTimeoutMs: 300000         # copy_compare 每个模型的预算
    imageTimeoutMs: 300000           # 生图预算
    maxInputChars: 60000             # 文案字符上限（按码点计，emoji 算 1 个）
    imageToolName: codex_image_generate
```

## 给开发者：`aiDesk` 服务

插件激活后会 `ctx.reflect.provide('aiDesk', ...)`，其他插件/技能可以直接复用：

```js
const aiDesk = ctx.get('aiDesk')

// 文本：任意模型，自动路由解析 / 回退 / 瞬态重试
const { text, provider, model, note, truncated, usage } = await aiDesk.complete({
  model: 'opencode-go/glm-5.3',   // 可省略
  system: '你是一位资深编辑',
  prompt: '……',
  maxTokens: 4096,                // 可省略 → 模型默认
  timeoutMs: 120000,
  signal,                         // AbortSignal
})

const routes = await aiDesk.listTextModels()          // [{ provider, model }]
const backends = aiDesk.listImageBackends(exec)       // [{ name, models, sizes, qualities, backgrounds, … }]

const image = await aiDesk.generateImage({
  prompt: '……',
  backend: 'codex_image_generate', // 可省略
  model: 'gpt-image-2.5-flare',    // 可省略
  size: '1536x1024',
  exec,                            // 或 { agent, signal }；生图通常需要会话上下文
})
```

## 常见问题

**装了但看不到工具？**
工具清单在会话启动时确定，**新开一个对话**即可；确认插件已启用（插件管理页的 `content-desk` 一行不是 failed）。

**生图提示「没有可用的生图工具」？**
插件复用 DSH 里已安装的生图后端，自身不带出图能力。安装一个生图插件（如 Codex 订阅）后重试；`ai_models` 能看到当前发现了哪些后端与模型。

**某个模型名报「未在 DSH 注册」？**
插件不内置私有路由，只使用 DSH 里已注册的模型。用 `ai_models` 看当前有哪些；也可以写 `provider/model` 指定精确路由，
或在 DSH 的模型配置里补上这个模型。

**回复被截断？**
检查是不是传了小 `max_tokens`；结果里的 `note` 会提示截断。长文改写/多版本建议 ≥2048。

**某个模型偶发失败？**
`opencode-go` 上游偶尔抖动（`ETIMEDOUT`/空响应），插件会自动同路由重试一次；`note` 里会写明回退/重试原因。

**会不会很贵？**
`copy_compare` 是 2–4 个模型并行，按模型数计费；`copy_cover` 是「一次文本设计 + 一次生图」。先用 `only_prompt` 对齐方向再出图更省。插件不经过 DSH 会话日志，因此用量不出现在会话统计里，以 provider 账单为准。

## 兼容性

- DSH `0.2.x`（`0.2.2-rc.1` 已验证；`engines.dsh` 与 `compatibility.json` 已声明）。0.1.x 宿主上能加载，但生图后端发现会退化。
- Node `^22.19.0 || >=24.0.0`。
- 无运行期 npm 依赖。

## 开发与测试

```powershell
npm test        # node --test test/*.test.mjs（29 个用例）
```

覆盖：路由解析、`max_tokens` 透传与截断提示、瞬态重试、取消与总预算、工具输出契约、
生图后端发现（含排除插件自身工具、条件注册）、提示词定界与解析。

代码结构：

```
index.js         工具装配（6 个工具的参数/输出/渲染）
lib/core.js      通用模型层：任意文本模型补全、生图后端发现与调用、aiDesk 服务
lib/prompts.js   文案业务提示词与输入组装
test/            单元测试
locale/          插件显示名/描述的本地化
```

## 已知限制

- 文案审核质量取决于所选模型；事实性强的文案建议传 `background` 资料，并在「需确认」处复核。
- 插件内部的模型调用不写入会话日志，因此不会出现在 DSH 的会话用量/费用统计里；`usage` 随结果返回，未做界面展示。
- 生图由 DSH 里已安装的后端工具执行，不经过 DSH 的工具审批/超时策略链；需要审批时请在上层工作流里约束。
- 辅助调用使用 DSH 的 `RequestUserInput` 形状，但没有声明 `purpose`（纯 JS 插件无法做 TS 模块增强）。
- 兼容范围为 DSH 0.2.x；跨大版本升级前建议先用 `ai_models` + 一次 `ai_task` 冒烟。

## License

[MIT](LICENSE) © yanren
