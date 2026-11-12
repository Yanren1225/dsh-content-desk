/**
 * dsh-content-desk — 底层「通用模型调用层」。
 *
 * 这一层只做通用能力，不含任何文案业务：
 * - 文本：解析任意 DSH 已注册模型（provider/model、裸模型名自动跨 provider 查找、
 *   默认模型链、失败回退、瞬态重试），并通过 ctx.llm 完成一次补全调用。
 * - 生图：发现 DSH 里可用的生图工具（优先 codex_image_generate，也可指定其他工具），
 *   读取其参数能力（支持哪些模型/尺寸/质量）并委托执行，返回图片引用。
 * - 同时向 DSH 暴露 `aiDesk` 服务（ctx.reflect.provide），业务插件或技能可以直接复用。
 *
 * 业务层（copy_review / copy_compare / copy_cover 等）只依赖本文件导出的服务接口。
 *
 * 设计约束（与 DSH 0.2.2-rc.1 契约对齐）：
 * - 只使用 DSH 已注册的 provider，不向宿主注册私有路由（零第三方耦合）。
 * - 取消与超时是硬约束：入口先检查 signal，回退/重试共享同一 deadline。
 * - 只在「同路由、零输出」时对瞬态网络错误重试一次，不换端点、不重复计费。
 */

import { randomUUID } from 'node:crypto'

/** 文本补全默认超时。 */
export const DEFAULT_TEXT_TIMEOUT_MS = 180_000
/** 生图工具默认名（DSH 里通常由 Codex 订阅插件提供）。 */
export const IMAGE_TOOL_NAME = 'codex_image_generate'
/** 本插件注册的工具名：发现生图后端时必须排除，否则 ai_image 会把自己当后端递归调用。 */
const OWN_TOOL_NAMES = new Set(['ai_task', 'ai_models', 'ai_image', 'copy_review', 'copy_compare', 'copy_cover'])

/**
 * 插件可配置项与其默认值。全部可通过 cordis.patch.yml 的 `config` 覆盖。
 * @typedef {object} CopyReviewOptions
 * @property {string} defaultModel 默认模型（空字符串 = 用 DSH 当前默认模型）
 * @property {string} fallbackModel 默认模型失败时的回退模型（空字符串 = 第一个可用模型）
 * @property {number} textTimeoutMs 单次文本补全超时
 * @property {number} compareTimeoutMs 多模型对比时每个模型的超时
 * @property {number} imageTimeoutMs 生图超时
 * @property {number} maxInputChars 输入文案字符上限（按码点计）
 * @property {string} imageToolName 首选的生图工具名
 */

/** 默认配置。 */
export const DEFAULT_OPTIONS = Object.freeze({
  defaultModel: '',
  fallbackModel: '',
  textTimeoutMs: DEFAULT_TEXT_TIMEOUT_MS,
  compareTimeoutMs: 300_000,
  imageTimeoutMs: 300_000,
  maxInputChars: 60_000,
  imageToolName: IMAGE_TOOL_NAME,
})

/**
 * 把插件 config 归一化成完整的 options（未知字段忽略，类型不符回落默认值）。
 * @param {unknown} config cordis 传入的 config
 * @returns {CopyReviewOptions}
 */
export function resolveOptions(config) {
  const input = config !== null && typeof config === 'object' ? config : {}
  const options = { ...DEFAULT_OPTIONS }
  for (const key of Object.keys(DEFAULT_OPTIONS)) {
    const fallback = DEFAULT_OPTIONS[key]
    const value = input[key]
    if (typeof fallback === 'number') {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) options[key] = value
      continue
    }
    if (typeof fallback === 'boolean') {
      if (typeof value === 'boolean') options[key] = value
      continue
    }
    if (typeof value === 'string') options[key] = value.trim()
  }
  return options
}

/**
 * 把错误（含 cause 链与 code）拼成可读诊断文本。
 * @param {unknown} error
 * @returns {string}
 */
export function describeError(error) {
  const parts = []
  let current = error
  for (let depth = 0; current !== null && current !== undefined && depth < 4; depth += 1) {
    const message =
      typeof current === 'string' ? current : typeof current.message === 'string' ? current.message : ''
    if (message !== '' && !parts.includes(message)) parts.push(message)
    if (
      typeof current === 'object' &&
      current !== null &&
      typeof current.code === 'string' &&
      current.code !== '' &&
      !parts.includes(current.code)
    ) {
      parts.push(current.code)
    }
    current = typeof current === 'object' && current !== null ? current.cause : undefined
  }
  return parts.length > 0 ? parts.join(' → ') : String(error)
}

/** 带稳定错误码的模型调用错误（供重试分类与取消判定使用）。 */
export class LlmCallError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'LlmCallError'
    if (typeof options.code === 'string' && options.code !== '') this.code = options.code
  }
}

/** 用户取消时抛出的错误（code 固定，便于上层识别）。 */
export function canceledError() {
  return new LlmCallError('模型调用已取消', { code: 'CANCELED' })
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
export function isCanceledError(error) {
  return typeof error === 'object' && error !== null && error.code === 'CANCELED'
}

/**
 * 请求被取消时立即抛错，不做任何新的模型调用。
 * @param {AbortSignal | undefined} signal
 */
function throwIfCanceled(signal) {
  if (signal?.aborted === true) throw canceledError()
}

// ---------------------------------------------------------------------------
// 模型路由解析
// ---------------------------------------------------------------------------

/**
 * 解析显式 "provider/model"；裸模型名或空值返回 null，交给通用解析。
 * @param {unknown} value
 * @returns {{ provider: string, model: string } | null}
 */
export function parseExplicitRoute(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === '') return null
  const slash = raw.indexOf('/')
  if (slash <= 0 || slash >= raw.length - 1) return null
  return { provider: raw.slice(0, slash), model: raw.slice(slash + 1) }
}

/**
 * 工具卡片展示用的模型标签（同步、不查目录）。
 * @param {unknown} value
 * @param {string} [fallback] 未指定模型时显示的文案
 * @returns {string}
 */
export function routeLabel(value, fallback = '') {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === '') return fallback
  const explicit = parseExplicitRoute(raw)
  return explicit === null ? raw : `${explicit.provider}/${explicit.model}`
}

/**
 * 汇总 DSH 已注册 provider 的全部模型（单个 provider 目录读取失败时跳过）。
 * @param {object} ctx
 * @returns {Promise<Array<{ provider: string, model: string }>>}
 */
export async function listRegisteredModels(ctx) {
  const entries = []
  let providers = []
  try {
    providers = ctx.llm.listProviders()
  } catch {
    return entries
  }
  for (const provider of providers) {
    try {
      const models = await ctx.llm.listModels(provider.id)
      for (const model of models) {
        if (typeof model?.id === 'string' && model.id !== '') entries.push({ provider: provider.id, model: model.id })
      }
    } catch {
      // 目录读取失败的 provider 跳过：不影响其他 provider 的解析
    }
  }
  return entries
}

/**
 * 把模型参数解析成 provider/model，不绑定特定 provider：
 * - 显式 provider/model 原样采用；
 * - 裸模型名在全部已注册 provider 中查找；
 * - 省略时：配置的默认模型 > DSH 当前默认模型 > 第一个可用模型。
 * @param {object} ctx
 * @param {unknown} value
 * @param {CopyReviewOptions} [options]
 * @returns {Promise<{ provider: string, model: string }>}
 */
export async function resolveRoute(ctx, value, options = DEFAULT_OPTIONS) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw !== '') {
    const explicit = parseExplicitRoute(raw)
    if (explicit !== null) return explicit
    const registered = await listRegisteredModels(ctx)
    const match = registered.find((entry) => entry.model === raw)
    if (match !== undefined) return match
    throw new LlmCallError(
      `模型 "${raw}" 未在 DSH 注册（裸模型名只在已注册目录里查找）。可用 ai_models 查看可用模型，或写成 provider/model。`,
      { code: 'UNKNOWN_MODEL' },
    )
  }
  const configured = typeof options.defaultModel === 'string' ? options.defaultModel.trim() : ''
  if (configured !== '') {
    const configuredRoute = await resolveRoute(ctx, configured, { ...options, defaultModel: '' })
    return configuredRoute
  }
  const registered = await listRegisteredModels(ctx)
  try {
    const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.()
    if (selection !== undefined && typeof selection.provider === 'string' && typeof selection.model === 'string') {
      // 信任用户在 DSH 里选的默认模型（即使目录读取失败、它没出现在 listModels 里）
      return { provider: selection.provider, model: selection.model }
    }
  } catch {
    // 读不到 DSH 默认模型时忽略
  }
  if (registered.length > 0) return registered[0]
  throw new LlmCallError('没有可用的文本模型：请确认 DSH 里已配置至少一个 provider（可用 ai_models 查看）。', {
    code: 'NO_ADAPTER',
  })
}

/**
 * 挑一个可用的回退模型（优先配置的回退模型，其次第一个可用模型）。
 * @param {object} ctx
 * @param {{ provider: string, model: string } | undefined} exclude
 * @param {CopyReviewOptions} [options]
 * @returns {Promise<{ provider: string, model: string } | undefined>}
 */
export async function resolveFallbackRoute(ctx, exclude, options = DEFAULT_OPTIONS) {
  const registered = await listRegisteredModels(ctx)
  const candidates = registered.filter(
    (entry) => exclude === undefined || entry.provider !== exclude.provider || entry.model !== exclude.model,
  )
  const preferred = typeof options.fallbackModel === 'string' ? options.fallbackModel.trim() : ''
  return (preferred === '' ? undefined : candidates.find((entry) => entry.model === preferred)) ?? candidates[0]
}

// ---------------------------------------------------------------------------
// 文本补全
// ---------------------------------------------------------------------------

/**
 * 读取一次模型调用的完整文本；超时与失败都抛出中文错误。
 * 上游偶发瞬态错误（连接超时/重置/空响应）时，在同一条路由上重试一次。
 * @param {object} ctx
 * @param {object} input
 * @param {{ provider: string, model: string }} input.route
 * @param {string} input.system
 * @param {string} input.userText
 * @param {AbortSignal | undefined} input.signal
 * @param {number} input.timeoutMs 本次调用的剩余预算
 * @param {string | undefined} input.sessionId
 * @param {number | undefined} input.maxTokens
 * @param {number | undefined} input.temperature
 * @returns {Promise<{ text: string, finishKind: string, usage: object | undefined }>}
 */
async function callModel(ctx, input) {
  throwIfCanceled(input.signal)
  const { route, system, userText, signal, timeoutMs, sessionId, maxTokens, temperature } = input
  const controller = new AbortController()
  let timedOut = false
  let canceled = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const forwardAbort = () => {
    canceled = true
    controller.abort()
  }
  if (signal?.aborted === true) {
    clearTimeout(timer)
    throw canceledError()
  }
  signal?.addEventListener('abort', forwardAbort, { once: true })

  let deltas = []
  let blockText = ''
  let failure
  let finishKind = 'stop'
  let usage
  let attempt = 0

  // RequestUserInput 形状：辅助调用不带 id/source，避免伪造 durable Message
  const messages = [{ role: 'user', content: [{ type: 'text', text: userText }] }]
  const requestOptions = {
    provider: route.provider,
    model: route.model,
    system,
    messages,
    signal: controller.signal,
  }
  if (typeof maxTokens === 'number' && maxTokens > 0) requestOptions.maxTokens = maxTokens
  if (typeof temperature === 'number') requestOptions.temperature = temperature
  if (typeof sessionId === 'string' && sessionId !== '') requestOptions.sessionId = sessionId

  /** 一次完整的流式尝试（可被瞬态重试复用）。 */
  const streamOnce = async () => {
    deltas = []
    blockText = ''
    failure = undefined
    finishKind = 'stop'
    usage = undefined
    for await (const chunk of ctx.llm.stream(requestOptions)) {
      if (chunk === null || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        deltas.push(chunk.text)
      } else if (chunk.type === 'block-end' && chunk.block?.type === 'text') {
        blockText += chunk.block.text ?? ''
      } else if (chunk.type === 'usage' && chunk.usage !== undefined) {
        usage = chunk.usage
      } else if (chunk.type === 'finish') {
        if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
          failure = chunk.reason.failure ?? chunk.reason
        } else if (typeof chunk.reason?.kind === 'string') {
          finishKind = chunk.reason.kind
        }
      }
    }
  }

  /**
   * 是否值得做一次「同路由、无输出」的瞬态重试：连接超时/重置等网络抖动。
   * 只在还没有任何文本产出时重试，避免重复计费与重复输出半截内容。
   * @param {unknown} error 抛出的错误，或 finish 失败原因
   * @returns {boolean}
   */
  const isTransientNoOutput = (error) => {
    if (deltas.length > 0 || blockText !== '') return false
    const detail = describeError(error)
    return /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|fetch failed|network error|TRANSPORT/i.test(detail)
  }

  try {
    // 最多两次：首次瞬态失败 → 等 250ms 重试一次；仍失败则按原错误抛出。
    for (;;) {
      attempt += 1
      try {
        await streamOnce()
      } catch (error) {
        if (canceled || signal?.aborted === true || isCanceledError(error)) throw canceledError()
        if (timedOut) {
          throw new LlmCallError(
            `模型 ${route.provider}/${route.model} 调用超时（${timeoutMs}ms）：${describeError(error)}`,
            { code: 'TIMEOUT', cause: error },
          )
        }
        if (attempt === 1 && isTransientNoOutput(error)) {
          ctx.logger?.debug?.(`content-desk: 瞬态网络错误，重试一次 ${route.provider}/${route.model}：${describeError(error).slice(0, 160)}`)
          await new Promise((resolve) => setTimeout(resolve, 250))
          throwIfCanceled(signal)
          continue
        }
        const detail = error instanceof Error ? error.message : String(error)
        throw new LlmCallError(`调用模型 ${route.provider}/${route.model} 失败：${detail}`, {
          code: typeof error === 'object' && error !== null && typeof error.code === 'string' ? error.code : undefined,
          cause: error,
        })
      }

      if (failure === undefined) {
        const text = (deltas.join('') || blockText).trim()
        if (text !== '') break
        const emptyCode = finishKind === 'max-tokens' ? 'MAX_TOKENS' : 'EMPTY_RESPONSE'
        // 上游偶发返回空文本（没有错误分片）：重试一次；但「max-tokens 截断导致空」不重试，那是预算问题。
        if (attempt === 1 && emptyCode === 'EMPTY_RESPONSE') {
          ctx.logger?.debug?.(`content-desk: 上游返回空文本，重试一次 ${route.provider}/${route.model}`)
          await new Promise((resolve) => setTimeout(resolve, 250))
          throwIfCanceled(signal)
          continue
        }
        throw new LlmCallError(`模型 ${route.provider}/${route.model} 没有返回任何文本内容`, { code: emptyCode })
      }
      if (canceled || signal?.aborted === true) throw canceledError()
      if (timedOut) {
        const message = typeof failure?.message === 'string' && failure.message !== '' ? failure.message : '未知错误'
        throw new LlmCallError(`模型 ${route.provider}/${route.model} 调用超时（${timeoutMs}ms）：${message}`, {
          code: 'TIMEOUT',
        })
      }
      const failureCode = typeof failure?.code === 'string' && failure.code !== '' ? failure.code : undefined
      if (failureCode === 'ABORTED') throw canceledError()
      if (attempt === 1 && isTransientNoOutput(failure)) {
        ctx.logger?.debug?.(`content-desk: 瞬态错误，重试一次 ${route.provider}/${route.model}：${describeError(failure).slice(0, 160)}`)
        await new Promise((resolve) => setTimeout(resolve, 250))
        throwIfCanceled(signal)
        continue
      }
      const message = typeof failure?.message === 'string' && failure.message !== '' ? failure.message : '未知错误'
      throw new LlmCallError(`模型 ${route.provider}/${route.model} 返回失败${failureCode === undefined ? '' : `（${failureCode}）`}：${message}`, {
        code: failureCode,
      })
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forwardAbort)
  }

  return { text: (deltas.join('') || blockText).trim(), finishKind, usage }
}

// ---------------------------------------------------------------------------
// 生图后端发现与调用
// ---------------------------------------------------------------------------

/**
 * 读取生图工具的参数定义：兼容 DSH 的扁平参数 DSL 与标准 JSON Schema 包装。
 * @param {object} definition
 * @returns {Record<string, object>}
 */
function imageToolParameters(definition) {
  const parameters = definition?.parameters
  if (parameters === null || parameters === undefined || typeof parameters !== 'object') return {}
  if (
    parameters.type === 'object' &&
    parameters.properties !== null &&
    parameters.properties !== undefined &&
    typeof parameters.properties === 'object'
  ) {
    return parameters.properties
  }
  return parameters
}

/**
 * 读一个参数声明的枚举值与描述。
 * @param {Record<string, object>} properties
 * @param {string} name
 * @returns {{ values: string[], description: string }}
 */
function parameterInfo(properties, name) {
  const spec = properties?.[name]
  if (spec === null || spec === undefined || typeof spec !== 'object') return { values: [], description: '' }
  const values = Array.isArray(spec.enum) ? spec.enum.filter((value) => typeof value === 'string') : []
  const description = typeof spec.description === 'string' ? spec.description : ''
  return { values, description }
}

/**
 * 判断一个工具定义像不像「生图」工具。
 * 主判据是输出声明了 image 结构且入参有 prompt；名称只作为没有 output 声明时的兜底，
 * 避免 render_markdown / create_xxx 这类工具被误判成生图后端。
 * @param {object} definition
 * @returns {boolean}
 */
function looksLikeImageTool(definition) {
  const name = typeof definition?.name === 'string' ? definition.name : ''
  if (name === '' || typeof definition.execute !== 'function') return false
  const properties = imageToolParameters(definition)
  if (properties.prompt === undefined) return false
  const outputProperties = definition?.output?.schema?.properties
  const imageSpec = outputProperties?.image
  if (imageSpec !== undefined && imageSpec !== null && typeof imageSpec === 'object') return true
  return /image|img|picture|photo/i.test(name)
}

/**
 * 规整工具执行上下文：业务工具会传入真实 exec；外部服务调用者可只给 agent/signal。
 * @param {object | undefined} input
 * @returns {object}
 */
function normalizeToolExec(input) {
  if (
    input !== null &&
    input !== undefined &&
    typeof input === 'object' &&
    typeof input.callId === 'string' &&
    input.agent !== undefined
  ) {
    return input
  }
  const signal = input?.signal ?? new AbortController().signal
  const callId = `ai-desk-${randomUUID()}`
  return {
    callId,
    rootCallId: callId,
    name: 'aiDesk',
    arguments: {},
    agent: input?.agent,
    toolSet: input?.toolSet,
    signal,
    deferContext() {},
    concludeTurn() {},
  }
}

/**
 * 列出 DSH 当前可用的生图工具及其参数能力（模型/尺寸/质量等）。
 * @param {object} ctx
 * @param {object | undefined} exec 工具执行上下文（按 agent 视角解析工具）
 * @param {{ mode?: 'list' | 'execute', imageToolName?: string }} [config]
 *   mode='execute' 时只返回当前步骤真正可执行的工具（尊重 when 与 toolSet）；
 *   mode='list' 用于能力展示，包含条件注册。
 * @returns {Array<object>}
 */
function listImageTools(ctx, exec, config = {}) {
  const mode = config.mode === 'execute' ? 'execute' : 'list'
  const imageToolName = typeof config.imageToolName === 'string' ? config.imageToolName : IMAGE_TOOL_NAME
  const agent = exec?.agent
  const toolSet = exec?.toolSet
  const tools = []
  const seen = new Set()
  const executableOf = (name) => {
    try {
      const definition = ctx.tools?.executable?.(name, agent, toolSet)
      return definition ?? undefined
    } catch {
      return undefined
    }
  }
  const push = (definition) => {
    if (definition === undefined || definition === null || typeof definition.execute !== 'function') return
    const name = typeof definition.name === 'string' ? definition.name : ''
    if (name === '' || seen.has(name)) return
    // 插件自己的工具不能被当成生图后端（ai_image 的输出也声明了 image，会自递归）
    if (OWN_TOOL_NAMES.has(name)) return
    if (!looksLikeImageTool(definition)) return
    seen.add(name)
    const properties = imageToolParameters(definition)
    const summary =
      typeof definition.description === 'string' && definition.description !== ''
        ? definition.description.split('。')[0].slice(0, 200)
        : name
    tools.push({
      name,
      definition,
      summary,
      models: parameterInfo(properties, 'model').values,
      sizes: parameterInfo(properties, 'size').values,
      qualities: parameterInfo(properties, 'quality').values,
      backgrounds: parameterInfo(properties, 'background').values,
      modelHint: parameterInfo(properties, 'model').description,
    })
  }

  push(executableOf(imageToolName))
  let definitions = []
  try {
    definitions = ctx.tools?.definitions?.(agent, toolSet) ?? []
  } catch {
    definitions = []
  }
  for (const definition of definitions) {
    if (mode === 'execute') {
      const admitted = executableOf(definition?.name)
      if (admitted === undefined) continue
      push(admitted)
    } else {
      push(definition)
    }
  }
  return tools
}

/**
 * 选出生图工具：backend 可强制指定；否则优先 codex_image_generate，
 * 再退到唯一候选（多个候选时报错要求指定）。
 * @returns {object | undefined}
 */
function findImageTool(ctx, exec, preferredName, options) {
  const tools = listImageTools(ctx, exec, { mode: 'execute', imageToolName: options.imageToolName })
  const forcedName = typeof preferredName === 'string' ? preferredName.trim() : ''
  if (forcedName !== '') {
    const forced = tools.find((tool) => tool.name === forcedName)
    if (forced !== undefined) return forced
    throw new LlmCallError(
      `找不到生图工具 "${forcedName}"。当前可用：${tools.map((tool) => tool.name).join('、') || '无'}（可用 ai_models 查看各工具与模型）`,
      { code: 'NO_IMAGE_BACKEND' },
    )
  }
  const preferred = tools.find((tool) => tool.name === options.imageToolName)
  if (preferred !== undefined) return preferred
  if (tools.length === 1) return tools[0]
  if (tools.length > 1) {
    throw new LlmCallError(
      `发现多个生图工具（${tools.map((tool) => tool.name).join('、')}）；请用 backend 参数指定一个（可用 ai_models 查看）。`,
      { code: 'AMBIGUOUS_IMAGE_BACKEND' },
    )
  }
  return undefined
}

/**
 * 校验指定的生图模型是否被目标工具支持（工具未声明枚举时放行）。
 * @param {object} tool
 * @param {unknown} model
 */
function assertImageModel(tool, model) {
  if (typeof model !== 'string' || model === '') return
  if (tool.models.length === 0) return
  if (!tool.models.includes(model)) {
    throw new LlmCallError(
      `生图后端 ${tool.name} 不支持模型 "${model}"。可选：${tool.models.join('、')}（省略 model 则用后端默认模型）`,
      { code: 'UNSUPPORTED_IMAGE_MODEL' },
    )
  }
}

// ---------------------------------------------------------------------------
// aiDesk 服务
// ---------------------------------------------------------------------------

/**
 * 创建通用模型调用服务 `aiDesk`。业务层通过它完成一次文本/生图调用，
 * 其他插件也可以通过 ctx.get('aiDesk') 复用。
 * @param {object} ctx
 * @param {CopyReviewOptions} [config]
 */
export function createAiDesk(ctx, config = DEFAULT_OPTIONS) {
  const options = { ...DEFAULT_OPTIONS, ...resolveOptions(config) }

  return {
    defaultModel: options.defaultModel,
    options,

    /** 列出所有已注册的文本模型 [{provider, model}]。 */
    listTextModels() {
      return listRegisteredModels(ctx)
    },

    /** 解析模型参数为 {provider, model}（provider/model、裸名跨 provider、默认链）。 */
    resolveRoute(value) {
      return resolveRoute(ctx, value, options)
    },

    /**
     * 做一次文本补全。总耗时受 timeoutMs 约束（含瞬态重试与回退）。
     * @param {{
     *   model?: string,
     *   system?: string,
     *   prompt: string,
     *   maxTokens?: number,
     *   temperature?: number,
     *   timeoutMs?: number,
     *   signal?: AbortSignal,
     *   sessionId?: string,
     *   allowFallback?: boolean,
     * }} input
     * @returns {Promise<{ text: string, provider: string, model: string, note: string, elapsedMs: number, truncated: boolean, usage: object | undefined }>}
     */
    async complete(input = {}) {
      const prompt = typeof input.prompt === 'string' ? input.prompt : ''
      if (prompt.trim() === '') throw new Error('prompt 不能为空')
      const signal = input.signal
      throwIfCanceled(signal)
      const explicit = typeof input.model === 'string' && input.model.trim() !== ''
      const timeoutMs =
        typeof input.timeoutMs === 'number' && input.timeoutMs > 0 ? input.timeoutMs : options.textTimeoutMs
      const deadline = Date.now() + timeoutMs
      const remaining = () => Math.max(0, deadline - Date.now())
      const system = typeof input.system === 'string' ? input.system : ''
      const startedAt = Date.now()
      const request = {
        system,
        userText: prompt,
        signal,
        sessionId: input.sessionId,
        maxTokens: typeof input.maxTokens === 'number' ? input.maxTokens : undefined,
        temperature: typeof input.temperature === 'number' ? input.temperature : undefined,
      }
      let route = await resolveRoute(ctx, input.model, options)

      try {
        const call = await callModel(ctx, { ...request, route, timeoutMs: remaining() })
        return {
          text: call.text,
          provider: route.provider,
          model: route.model,
          note: '',
          elapsedMs: Date.now() - startedAt,
          truncated: call.finishKind === 'max-tokens',
          usage: call.usage,
        }
      } catch (error) {
        if (isCanceledError(error) || signal?.aborted === true) throw canceledError()
        if (explicit || input.allowFallback === false) throw error
        if (remaining() <= 0) throw error
        const fallback = await resolveFallbackRoute(ctx, route, options)
        if (fallback === undefined) throw error
        throwIfCanceled(signal)
        let call
        try {
          call = await callModel(ctx, { ...request, route: fallback, timeoutMs: remaining() })
        } catch (fallbackError) {
          if (isCanceledError(fallbackError) || signal?.aborted === true) throw canceledError()
          const primary = describeError(error).split('→')[0].trim().slice(0, 120)
          const secondary = describeError(fallbackError).split('→')[0].trim().slice(0, 120)
          throw new LlmCallError(`默认模型失败（${primary}）；回退模型也失败（${secondary}）`, {
            cause: fallbackError,
          })
        }
        const primary = describeError(error).split('→')[0].trim().slice(0, 120)
        ctx.logger?.info?.(`content-desk: 默认模型不可用，回退到 ${fallback.provider}/${fallback.model}：${primary}`)
        return {
          text: call.text,
          provider: fallback.provider,
          model: fallback.model,
          note: `默认模型不可用，已自动回退到 ${fallback.provider}/${fallback.model}。原因：${primary}`,
          elapsedMs: Date.now() - startedAt,
          truncated: call.finishKind === 'max-tokens',
          usage: call.usage,
        }
      }
    },

    /**
     * 列出可用的生图后端及其能力。
     * @param {object | undefined} exec 工具执行上下文（或 {agent, signal}）
     */
    listImageBackends(exec) {
      const normalized = normalizeToolExec(exec)
      return listImageTools(ctx, normalized, {
        mode: 'list',
        imageToolName: options.imageToolName,
      }).map(({ definition, ...rest }) => rest)
    },

    /**
     * 生成图片：自动发现/指定生图后端，校验模型后委托执行。
     * @param {{
     *   prompt: string,
     *   backend?: string,
     *   model?: string,
     *   size?: string,
     *   quality?: string,
     *   background?: string,
     *   exec?: object,
     *   agent?: object,
     *   signal?: AbortSignal,
     * }} input
     * @returns {Promise<object>}
     */
    async generateImage(input = {}) {
      const prompt = typeof input.prompt === 'string' ? input.prompt : ''
      if (prompt.trim() === '') throw new Error('prompt 不能为空')
      throwIfCanceled(input.signal)
      const exec = normalizeToolExec(input.exec ?? { agent: input.agent, signal: input.signal })
      const request = { prompt }
      if (typeof input.size === 'string' && input.size !== '') request.size = input.size
      if (typeof input.quality === 'string' && input.quality !== '') request.quality = input.quality
      if (typeof input.background === 'string' && input.background !== '') request.background = input.background
      if (typeof input.model === 'string' && input.model !== '') request.model = input.model

      const found = findImageTool(ctx, exec, input.backend, options)
      if (found === undefined) {
        throw new LlmCallError(
          '生图不可用：DSH 里没有找到可用的生图工具。请先安装一个生图插件（例如 Codex 订阅），' +
            '装好后本插件会自动发现，无需额外配置；也可以用 ai_models 查看当前可用的生图后端与模型。',
          { code: 'NO_IMAGE_BACKEND' },
        )
      }
      assertImageModel(found, request.model)
      ctx.logger?.debug?.(`content-desk: 使用生图后端 ${found.name}`)
      let raw
      try {
        raw = await found.definition.execute(request, exec)
      } catch (error) {
        const detail = describeError(error).slice(0, 600)
        if (/session-owned tool call|requires a session/i.test(detail)) {
          throw new LlmCallError(
            `${detail}（提示：aiDesk.generateImage 需要在会话工具上下文中调用，或显式传入 { agent }。）`,
            { cause: error },
          )
        }
        throw new LlmCallError(`生图工具 ${found.name} 执行失败：${detail}`, { cause: error })
      }
      if (raw === null || typeof raw !== 'object' || raw.image === undefined) {
        throw new LlmCallError(`生图工具 ${found.name} 没有返回图片引用，请稍后重试`, {
          code: 'IMAGE_OUTPUT_MISSING',
        })
      }
      const requestedModel =
        typeof raw.requestedModel === 'string'
          ? raw.requestedModel
          : typeof request.model === 'string'
            ? request.model
            : ''
      const reportedModel = typeof raw.reportedModel === 'string' ? raw.reportedModel : ''
      return {
        image: raw.image,
        backend: found.name,
        // 「生图模型」优先取服务端回报的实际模型，其次才是请求值
        model: reportedModel !== '' ? reportedModel : requestedModel,
        requestedModel,
        size: typeof raw.size === 'string' ? raw.size : '',
        requestedSize: typeof raw.requestedSize === 'string' ? raw.requestedSize : '',
        localPath: typeof raw.localPath === 'string' ? raw.localPath : '',
        raw,
      }
    },
  }
}
