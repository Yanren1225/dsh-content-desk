/**
 * dsh-content-desk — 插件装配层。
 *
 * 分层：
 * - lib/core.js    底层通用能力：任意 DSH 模型文本补全 + 任意生图后端调用，并暴露 aiDesk 服务
 * - lib/prompts.js 文案业务提示词与输入组装（不含调用代码）
 * - index.js       工具装配：通用工具（ai_task / ai_models / ai_image）+ 文案业务工具
 *                  （copy_review / copy_compare / copy_cover）
 *
 * 工具定义遵循 DSH tools.register 的硬性契约：
 * - parameters 必须是标准 JSON Schema（{ type: 'object', properties, required }）
 * - output 必须是 { schema, render }，render 返回 ContentBlock[]
 *
 * 所有可调项可通过 profile 的 cordis.patch.yml 覆盖（见 lib/core.js 的 DEFAULT_OPTIONS）。
 */

import { createAiDesk, routeLabel, describeError, resolveOptions } from './lib/core.js'
import {
  SYSTEM_PROMPT,
  DIRECTOR_SYSTEM,
  TASK,
  TASK_VALUES,
  normalizeTask,
  buildUserPrompt,
  buildDirectorPrompt,
  parseDirectorOutput,
} from './lib/prompts.js'

export const name = 'content-desk'
export const inject = ['tools', 'llm']

const MAX_TASK_PROMPT_CHARS = 120_000

/**
 * 按码点统计字符数（emoji / 中文等价于「1 个字」）。
 * @param {string} text
 * @returns {number}
 */
function codePointLength(text) {
  let count = 0
  for (const _ of text) count += 1
  return count
}

/**
 * 校验输入文案长度。
 * @param {unknown} content
 * @param {object} options 插件配置
 * @returns {string}
 */
function requireContent(content, options) {
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error('content 不能为空：请提供需要处理的文案原文')
  }
  const limit = options.maxInputChars
  const length = codePointLength(content)
  if (length > limit) {
    throw new Error(
      `content 过长（${length} 字，上限 ${limit}）：请分段提交，或先让主模型压缩后再处理`,
    )
  }
  return content
}

/**
 * 把「截断」提示合进 note（不新增输出字段，避免 4 个工具的输出契约连锁改动）。
 * @param {string} note
 * @param {boolean} truncated
 * @returns {string}
 */
function withTruncation(note, truncated) {
  if (truncated !== true) return note
  const warning = '输出达到模型 max_tokens 上限，结果可能被截断；可用 max_tokens 调大后重试'
  return note === '' ? warning : `${note}；${warning}`
}

/**
 * 把图片块和说明拼成工具输出内容块。
 * @param {object} info
 * @param {object | undefined} image
 * @returns {object[]}
 */
function renderImageResult(info, image) {
  const lines = []
  if (info.backend !== undefined && info.backend !== '') lines.push(`生图后端：${info.backend}`)
  if (info.imageModel !== '') {
    const requested = typeof info.requestedModel === 'string' ? info.requestedModel : ''
    lines.push(requested !== '' && requested !== info.imageModel ? `生图模型：${info.imageModel}（请求 ${requested}）` : `生图模型：${info.imageModel}`)
  }
  if (info.size !== '') {
    const requestedSize = typeof info.requestedSize === 'string' ? info.requestedSize : ''
    lines.push(requestedSize !== '' && requestedSize !== info.size ? `图片尺寸：${info.size}（请求 ${requestedSize}）` : `图片尺寸：${info.size}`)
  }
  if (info.copyModel !== '') lines.push(`提示词由：${info.copyModel} 设计`)
  if (info.description !== '') lines.push(`画面说明：${info.description}`)
  lines.push(`提示词：${info.prompt}`)
  if (image === undefined) {
    lines.push('（本次只生成提示词，未调用生图）')
    return [{ type: 'text', text: lines.join('\n') }]
  }
  if (info.localPath !== '') {
    lines.push(`原图 PNG 已保存在 DSH 主机：${info.localPath}（需要放进工作区时请复制这个文件，不要移动）`)
  }
  return [{ type: 'text', text: lines.join('\n') }, { type: 'image', attachment: image }]
}

/**
 * 生图工具的通用参数（不绑定具体后端：只给建议值，实际支持以 ai_models 为准）。
 * @returns {object}
 */
function imageParameterProperties() {
  return {
    backend: {
      type: 'string',
      description: '生图工具名；省略时优先常用的 codex_image_generate，否则自动选唯一可用的后端（ai_models 可查）。',
    },
    model: {
      type: 'string',
      description: '生图模型 id；省略用后端默认模型。可选值见 ai_models 的 imageBackends[].models。',
    },
    size: {
      type: 'string',
      description:
        '画面尺寸，如 auto / 1536x1024（横版）/ 1024x1536（竖版）/ 1024x1024（方图）/ 2048x1152（宽屏）；后端会校验具体取值。',
    },
    quality: { type: 'string', description: '出图质量，如 auto / low / medium / high（部分后端支持 xhigh / max）。' },
    background: { type: 'string', description: '背景：auto / transparent / opaque（视后端支持）。' },
  }
}

/**
 * 生图工具的输出 schema。
 * @returns {object}
 */
function imageOutputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      prompt: { type: 'string', description: '实际用于生图的提示词' },
      description: { type: 'string', description: '画面中文说明' },
      copyModel: { type: 'string', description: '设计提示词的 DSH 模型（未增强时为空）' },
      backend: { type: 'string', description: '实际使用的生图工具名' },
      imageModel: { type: 'string', description: '实际出图模型（优先服务端回报值）' },
      requestedModel: { type: 'string', description: '请求的生图模型' },
      size: { type: 'string', description: '实际图片尺寸' },
      requestedSize: { type: 'string', description: '请求的图片尺寸' },
      localPath: { type: 'string', description: 'PNG 在 DSH 主机上的路径' },
      elapsedMs: { type: 'integer', description: '总耗时（毫秒）' },
      image: {
        type: 'object',
        additionalProperties: true,
        properties: {
          attachmentId: { type: 'string' },
          mediaType: { type: 'string' },
          bytes: { type: 'integer' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          name: { type: 'string' },
        },
      },
    },
    required: [
      'prompt',
      'description',
      'copyModel',
      'backend',
      'imageModel',
      'requestedModel',
      'size',
      'requestedSize',
      'localPath',
      'elapsedMs',
    ],
  }
}

// ---------------------------------------------------------------------------
// 通用工具：调用任意 DSH 模型 / 查看能力 / 生成图片
// ---------------------------------------------------------------------------

/**
 * ai_task：把一段任务交给 DSH 里任意模型执行（业务无关）。
 * @param {object} aiDesk
 * @param {object} options
 */
function aiTaskTool(aiDesk, options) {
  return {
    name: 'ai_task',
    description:
      '通用模型调用：把一段 prompt（可带 system 角色说明）交给 DSH 里注册的任意模型执行，返回文本结果。' +
      '适合审核之外的任意一次性任务：翻译、摘要、改写、结构化提取、生成提示词等。' +
      '不绑定 provider：可写 provider/model，裸模型名会自动解析；省略 model 用 DSH 当前默认模型并自动回退。' +
      'max_tokens 可控制输出上限（省略用模型默认值）。可用模型用 ai_models 查询。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', description: '任务内容（完整、自包含）。' },
        system: { type: 'string', description: '角色/规则说明（可选）。' },
        model: { type: 'string', description: '模型 id 或 provider/model；省略用 DSH 默认模型。' },
        max_tokens: { type: 'integer', description: '输出上限（可选，省略用模型默认值）。' },
        temperature: { type: 'number', description: '采样温度（可选）。' },
      },
      required: ['prompt'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', description: '模型返回的文本' },
          provider: { type: 'string' },
          model: { type: 'string' },
          note: { type: 'string', description: '回退/路由重试/截断提示（正常为空字符串）' },
          elapsedMs: { type: 'integer' },
        },
        required: ['text', 'provider', 'model', 'note', 'elapsedMs'],
      },
      render(_args, value) {
        const noteLine = value.note !== '' ? `提示：${value.note}\n` : ''
        return [{ type: 'text', text: `${noteLine}[${value.provider}/${value.model}]\n\n${value.text}` }]
      },
    },
    timeoutMs: options.textTimeoutMs + 30_000,
    async execute(args, exec) {
      const prompt = typeof args?.prompt === 'string' ? args.prompt : ''
      if (prompt.trim() === '') throw new Error('prompt 不能为空')
      const length = codePointLength(prompt)
      if (length > MAX_TASK_PROMPT_CHARS) {
        throw new Error(`prompt 过长（${length} 字，上限 ${MAX_TASK_PROMPT_CHARS}）：请分段提交`)
      }
      const result = await aiDesk.complete({
        model: args?.model,
        system: typeof args?.system === 'string' ? args.system : '',
        prompt,
        maxTokens: typeof args?.max_tokens === 'number' ? args.max_tokens : undefined,
        temperature: typeof args?.temperature === 'number' ? args.temperature : undefined,
        timeoutMs: options.textTimeoutMs,
        signal: exec?.signal,
        sessionId: exec?.agent?.id,
      })
      return {
        text: result.text,
        provider: result.provider,
        model: result.model,
        note: withTruncation(result.note, result.truncated),
        elapsedMs: result.elapsedMs,
      }
    },
    presentCall() {
      return { card: 'generic', title: '调用模型', kind: 'other' }
    },
  }
}

/**
 * ai_models：列出可用文本模型与生图后端/模型。
 * @param {object} aiDesk
 * @param {object} ctx
 */
function aiModelsTool(aiDesk, ctx) {
  return {
    name: 'ai_models',
    description:
      '列出 DSH 当前可用的能力：文本模型（全部已注册 provider，可给 ai_task / copy_review / copy_compare 挑模型）' +
      '与生图后端（工具名 + 支持的生图模型/尺寸/质量，可给 ai_image / copy_cover 用）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        provider: { type: 'string', description: '只看某个文本 provider（可选）。' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          providers: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                models: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      id: { type: 'string' },
                      name: { type: 'string' },
                      description: { type: 'string' },
                    },
                    required: ['id', 'name', 'description'],
                  },
                },
                error: { type: 'string' },
              },
              required: ['id', 'name', 'models', 'error'],
            },
          },
          imageBackends: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                summary: { type: 'string' },
                models: { type: 'array', items: { type: 'string' } },
                sizes: { type: 'array', items: { type: 'string' } },
                qualities: { type: 'array', items: { type: 'string' } },
                backgrounds: { type: 'array', items: { type: 'string' } },
                modelHint: { type: 'string' },
              },
              required: ['name', 'summary', 'models', 'sizes', 'qualities', 'backgrounds', 'modelHint'],
            },
          },
          summary: { type: 'string' },
        },
        required: ['providers', 'imageBackends', 'summary'],
      },
      render(_args, value) {
        const lines = [`DSH 可用能力 · ${value.summary}`]
        for (const provider of value.providers) {
          lines.push('', `### ${provider.name}（${provider.id}）`)
          if (provider.error !== '') {
            lines.push(`读取失败：${provider.error}`)
            continue
          }
          for (const model of provider.models) {
            const desc = model.description !== '' ? ` — ${model.description}` : ''
            lines.push(`- \`${model.id}\` ${model.name}${desc}`)
          }
        }
        if (value.imageBackends.length > 0) {
          lines.push('', '### 生图后端')
          for (const backend of value.imageBackends) {
            lines.push(`- \`${backend.name}\` ${backend.summary}`)
            if (backend.models.length > 0) lines.push(`  - 模型：${backend.models.join('、')}`)
            if (backend.sizes.length > 0) lines.push(`  - 尺寸：${backend.sizes.join('、')}`)
            if (backend.qualities.length > 0) lines.push(`  - 质量：${backend.qualities.join('、')}`)
            if (backend.backgrounds.length > 0) lines.push(`  - 背景：${backend.backgrounds.join('、')}`)
            if (backend.modelHint !== '') lines.push(`  - 说明：${backend.modelHint}`)
          }
        } else {
          lines.push('', '### 生图后端', '（未发现可用生图工具；安装任意生图插件后会自动发现）')
        }
        lines.push('', '用法：文本模型 id 传给 ai_task / copy_review / copy_compare；生图模型 id 传给 ai_image / copy_cover。')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 30_000,
    async execute(args, exec) {
      const requested = typeof args?.provider === 'string' ? args.provider.trim() : ''
      let providers = []
      let listError = ''
      try {
        providers = ctx.llm.listProviders()
      } catch (error) {
        listError = describeError(error)
        providers = []
      }
      if (requested !== '' && providers.length > 0) providers = providers.filter((provider) => provider.id === requested)
      if (requested !== '' && providers.length === 0 && listError === '') {
        throw new Error(`没有找到 provider "${requested}"（可用 ai_models 不带 provider 查看全部）`)
      }
      const rows = []
      // 并发读取各 provider 目录：某个失败不影响其他（allSettled 语义）
      const settled = await Promise.allSettled(
        providers.map(async (provider) => {
          const models = await ctx.llm.listModels(provider.id)
          return {
            id: provider.id,
            name: provider.name,
            models: models.map((model) => ({
              id: model.id,
              name: model.name ?? model.id,
              description: typeof model.description === 'string' ? model.description : '',
            })),
            error: '',
          }
        }),
      )
      for (let index = 0; index < settled.length; index += 1) {
        const provider = providers[index]
        const outcome = settled[index]
        if (outcome.status === 'fulfilled') {
          rows.push(outcome.value)
        } else {
          rows.push({
            id: provider.id,
            name: provider.name,
            models: [],
            error: describeError(outcome.reason),
          })
        }
      }
      // 用真实 exec（agent 视角）列出后端，与 ai_image / copy_cover 执行时看到的能力一致
      const imageBackends = aiDesk.listImageBackends(exec)
      const textCount = rows.reduce((sum, row) => sum + row.models.length, 0)
      const imageCount = imageBackends.reduce((sum, backend) => sum + backend.models.length, 0)
      const summary = listError !== ''
        ? `读取 provider 目录失败（${listError}）`
        : `${rows.length} 个文本 provider / ${textCount} 个模型；${imageBackends.length} 个生图后端 / ${imageCount} 个生图模型`
      return { providers: rows, imageBackends, summary }
    },
    presentCall() {
      return { card: 'generic', title: '查看可用模型', kind: 'read' }
    },
  }
}

/**
 * ai_image：通用生图（业务无关，支持任一生图后端与模型）。
 * @param {object} aiDesk
 * @param {object} options
 */
function aiImageTool(aiDesk, options) {
  return {
    name: 'ai_image',
    description:
      '通用生图：把 prompt 交给 DSH 里已安装的生图后端，图片直接显示在对话里。' +
      '后端自动发现（也可用 backend 指定工具名、model 指定该后端支持的模型，ai_models 可查），' +
      '尺寸/质量/背景按后端能力透传。DSH 里没有生图后端时请先安装一个。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', description: '完整、生产级的生图提示词（英文效果更好）。' },
        ...imageParameterProperties(),
      },
      required: ['prompt'],
    },
    output: { schema: imageOutputSchema(), render(_args, value) { return renderImageResult(value, value.image) } },
    timeoutMs: options.imageTimeoutMs + 30_000,
    async execute(args, exec) {
      const prompt = typeof args?.prompt === 'string' ? args.prompt : ''
      if (prompt.trim() === '') throw new Error('prompt 不能为空')
      const startedAt = Date.now()
      const result = await aiDesk.generateImage({
        prompt,
        backend: args?.backend,
        model: args?.model,
        size: args?.size,
        quality: args?.quality,
        background: args?.background,
        exec,
      })
      return {
        prompt,
        description: '',
        copyModel: '',
        backend: result.backend,
        imageModel: result.model,
        requestedModel: result.requestedModel,
        size: result.size,
        requestedSize: result.requestedSize,
        localPath: result.localPath,
        elapsedMs: Date.now() - startedAt,
        image: result.image,
      }
    },
    presentCall() {
      return { card: 'generic', title: '生成图片', kind: 'other' }
    },
  }
}

// ---------------------------------------------------------------------------
// 业务工具：文案审核 / 对比 / 配图
// ---------------------------------------------------------------------------

/**
 * copy_review：文案审核与修改。
 * @param {object} aiDesk
 * @param {object} options
 */
function copyReviewTool(aiDesk, options) {
  return {
    name: 'copy_review',
    description:
      '用 DSH 里的另一个模型（省略 model 时用 DSH 当前默认模型）审核并修改中文文案：查错别字/病句/事实与逻辑问题，' +
      '按中国广告法与平台规范查合规风险，再给出可直接使用的修改稿；也支持只审核、只润色、或多版本改写。' +
      '适用：公众号/小红书/抖音口播/App 商店描述/电商详情页/广告语/产品介绍等。' +
      'content 传文案原文；保守起见先审后改，改动均会说明依据。' +
      '模型不绑定 provider：可写 provider/model，裸模型名会自动解析。可用模型用 ai_models 查询。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        content: { type: 'string', description: '需要审核或修改的文案原文（保持原样，不要预先改动）。' },
        task: {
          type: 'string',
          enum: TASK_VALUES,
          description:
            '任务类型：review_and_polish=审核并给修改稿（默认）；review=只审核不给全文；polish=直接润色改写；variants=审核后给 A/B/C 三个改写版本。',
        },
        model: { type: 'string', description: '用哪个模型审核；省略用 DSH 当前默认模型。可写 provider/model。' },
        max_tokens: { type: 'integer', description: '输出上限（可选；variants 或长文案建议调大）。' },
        platform: { type: 'string', description: '发布平台/渠道，如 小红书、公众号、抖音、App Store、淘宝详情页。' },
        audience: { type: 'string', description: '目标读者/用户画像，如 25-35 岁宝妈、B 端采购负责人。' },
        tone: { type: 'string', description: '期望调性，如 克制专业、轻松有网感、高端质感。' },
        background: { type: 'string', description: '产品/活动/品牌背景资料，用于核对文案中的事实与卖点是否准确。' },
        rules: { type: 'string', description: '额外审核标准：品牌规范、禁用词、行业合规红线、字数限制等。' },
      },
      required: ['content'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          model: { type: 'string' },
          provider: { type: 'string' },
          task: { type: 'string' },
          elapsedMs: { type: 'integer' },
          content: { type: 'string', description: '模型返回的审核/修改结果（Markdown）' },
          note: { type: 'string', description: '回退/路由重试/截断提示（正常为空字符串）' },
        },
        required: ['model', 'provider', 'task', 'elapsedMs', 'content', 'note'],
      },
      render(_args, value) {
        const noteLine = value.note !== '' ? `\n提示：${value.note}` : ''
        return [
          {
            type: 'text',
            text: `审核模型：${value.provider}/${value.model} · 任务：${TASK[value.task] ?? value.task} · 耗时：${(
              value.elapsedMs / 1000
            ).toFixed(1)}s${noteLine}\n\n${value.content}`,
          },
        ]
      },
    },
    timeoutMs: options.textTimeoutMs + 30_000,
    async execute(args, exec) {
      const content = requireContent(args?.content, options)
      const task = normalizeTask(args?.task)
      const result = await aiDesk.complete({
        model: args?.model,
        system: SYSTEM_PROMPT,
        prompt: buildUserPrompt({ ...args, content }, task),
        maxTokens: typeof args?.max_tokens === 'number' ? args.max_tokens : undefined,
        timeoutMs: options.textTimeoutMs,
        signal: exec?.signal,
        sessionId: exec?.agent?.id,
      })
      return {
        model: result.model,
        provider: result.provider,
        task,
        elapsedMs: result.elapsedMs,
        content: result.text,
        note: withTruncation(result.note, result.truncated),
      }
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: `审核文案（${routeLabel(args?.model, options.defaultModel || '默认模型')}）`,
        kind: 'other',
      }
    },
  }
}

/**
 * copy_compare：多模型对比审核。
 * @param {object} aiDesk
 * @param {object} options
 */
function copyCompareTool(aiDesk, options) {
  return {
    name: 'copy_compare',
    description:
      '把同一份文案同时交给 DSH 里的 2-4 个模型审核，返回各模型的独立评审与修改稿，便于横向对比、挑选最优改法。' +
      '不同 provider 的模型可以混合（如 glm-5.3 + gpt-5.6-luna）。需要模型候选先用 ai_models 查询。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        content: { type: 'string', description: '需要审核或修改的文案原文（保持原样）。' },
        models: {
          type: 'array',
          items: { type: 'string' },
          description: '参与对比的模型 id 列表（2-4 个）；可写 provider/model，裸名会自动解析。',
        },
        task: { type: 'string', enum: TASK_VALUES, description: '任务类型，同 copy_review；默认 review_and_polish。' },
        max_tokens: { type: 'integer', description: '每个模型的输出上限（可选）。' },
        platform: { type: 'string', description: '发布平台/渠道。' },
        audience: { type: 'string', description: '目标读者/用户画像。' },
        tone: { type: 'string', description: '期望调性。' },
        background: { type: 'string', description: '产品/活动/品牌背景资料。' },
        rules: { type: 'string', description: '额外审核标准。' },
      },
      required: ['content', 'models'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                provider: { type: 'string' },
                model: { type: 'string' },
                ok: { type: 'boolean' },
                elapsedMs: { type: 'integer' },
                content: { type: 'string' },
                note: { type: 'string' },
                error: { type: 'string' },
              },
              required: ['provider', 'model', 'ok', 'elapsedMs', 'content', 'note', 'error'],
            },
          },
          task: { type: 'string' },
          summary: { type: 'string' },
        },
        required: ['results', 'task', 'summary'],
      },
      render(_args, value) {
        const parts = [`多模型对比审核 · 任务：${TASK[value.task] ?? value.task} · ${value.summary}`]
        for (const item of value.results) {
          parts.push('', `## ${item.provider}/${item.model}（${(item.elapsedMs / 1000).toFixed(1)}s）`)
          if (item.note !== '') parts.push(`> ${item.note}`)
          parts.push(item.ok ? item.content : `调用失败：${item.error}`)
        }
        parts.push('', '---', '以上为各模型独立评审，可对比分歧后择优采用；用户可指定以哪个版本为准。')
        return [{ type: 'text', text: parts.join('\n') }]
      },
    },
    timeoutMs: options.compareTimeoutMs + 30_000,
    async execute(args, exec) {
      const content = requireContent(args?.content, options)
      const task = normalizeTask(args?.task)
      const requested = Array.isArray(args?.models) ? args.models : []
      if (requested.length < 2) throw new Error('models 至少需要 2 个模型才能对比')
      const routes = []
      for (const raw of requested) {
        if (typeof raw !== 'string' || raw.trim() === '') {
          throw new Error('models 里每一项都必须是非空模型名（可写 provider/model）')
        }
        const route = await aiDesk.resolveRoute(raw)
        if (!routes.some((r) => r.provider === route.provider && r.model === route.model)) routes.push(route)
      }
      if (routes.length < 2) throw new Error('models 至少需要 2 个不同的模型才能对比')
      if (routes.length > 4) throw new Error('models 最多支持 4 个模型（控制耗时与费用）')
      const prompt = buildUserPrompt({ ...args, content }, task)
      const results = await Promise.all(
        routes.map(async (route) => {
          const startedAt = Date.now()
          try {
            const result = await aiDesk.complete({
              model: `${route.provider}/${route.model}`,
              system: SYSTEM_PROMPT,
              prompt,
              maxTokens: typeof args?.max_tokens === 'number' ? args.max_tokens : undefined,
              timeoutMs: options.compareTimeoutMs,
              signal: exec?.signal,
              sessionId: exec?.agent?.id,
              allowFallback: false,
            })
            return {
              provider: result.provider,
              model: result.model,
              ok: true,
              elapsedMs: Date.now() - startedAt,
              content: result.text,
              note: withTruncation(result.note, result.truncated),
              error: '',
            }
          } catch (error) {
            return {
              provider: route.provider,
              model: route.model,
              ok: false,
              elapsedMs: Date.now() - startedAt,
              content: '',
              note: '',
              error: describeError(error),
            }
          }
        }),
      )
      const okCount = results.filter((item) => item.ok).length
      return { results, task, summary: `${okCount}/${results.length} 个模型调用成功` }
    },
    presentCall() {
      return { card: 'generic', title: '多模型对比审核', kind: 'other' }
    },
  }
}

/**
 * copy_cover：文案 → 封面/配图（先用模型设计提示词，再调生图后端）。
 * @param {object} aiDesk
 * @param {object} options
 */
function copyCoverTool(aiDesk, options) {
  const designTimeoutMs = options.textTimeoutMs
  return {
    name: 'copy_cover',
    description:
      '给文案做封面/配图：先用 DSH 里的模型把文案或画面描述设计成专业生图提示词，' +
      '再交给可用的生图后端出图，图片会直接显示在对话里。适合作公众号封面、小红书配图、活动海报、文章头图。' +
      'content 可传文案全文，也可传画面描述；only_prompt=true 时只返回提示词不出图（省额度、先对齐方向）。' +
      '生图后端与模型可自由选择：backend 指定生图工具、image_model 指定该后端模型（ai_models 可查）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        content: { type: 'string', description: '文案原文，或要生成的画面描述。' },
        platform: { type: 'string', description: '配图渠道，如 公众号封面 / 小红书 / 抖音 / 电商横幅。' },
        style: {
          type: 'string',
          description: '风格偏好，如 扁平插画 / 3D 渲染 / 手绘水彩 / 极简几何 / 摄影质感 / 国潮。',
        },
        only_prompt: { type: 'boolean', description: 'true=只生成提示词，不调用生图（默认 false）。' },
        model: { type: 'string', description: '设计提示词用的文本模型；省略用 DSH 默认模型。可写 provider/model。' },
        image_model: {
          type: 'string',
          description: '生图模型 id；省略用后端默认模型（可选值见 ai_models 的 imageBackends[].models）。',
        },
        backend: { type: 'string', description: '生图工具名；省略自动选择。' },
        size: { type: 'string', description: '画面尺寸，如 1536x1024（横版封面）/ 1024x1536（竖版）/ auto。' },
        quality: { type: 'string', description: '出图质量，如 auto / low / medium / high。' },
        background: { type: 'string', description: '背景：auto / transparent / opaque。' },
      },
      required: ['content'],
    },
    output: { schema: imageOutputSchema(), render(_args, value) { return renderImageResult(value, value.image) } },
    timeoutMs: designTimeoutMs + options.imageTimeoutMs + 60_000,
    async execute(args, exec) {
      const content = requireContent(args?.content, options)
      const startedAt = Date.now()
      const designed = await aiDesk.complete({
        model: args?.model,
        system: DIRECTOR_SYSTEM,
        prompt: buildDirectorPrompt(args, content),
        timeoutMs: designTimeoutMs,
        signal: exec?.signal,
        sessionId: exec?.agent?.id,
      })
      const parsed = parseDirectorOutput(designed.text)
      if (parsed.prompt === '') throw new Error('提示词设计模型没有返回可用的生图提示词，请重试或换一个 model')
      let description = parsed.description
      const designNote = withTruncation(designed.note, designed.truncated)
      if (designNote !== '') description = `${description}（${designNote}）`.trim()
      const copyModel = `${designed.provider}/${designed.model}`
      if (args?.only_prompt === true) {
        return {
          prompt: parsed.prompt,
          description,
          copyModel,
          backend: '',
          imageModel: '',
          requestedModel: '',
          size: '',
          requestedSize: '',
          localPath: '',
          elapsedMs: Date.now() - startedAt,
        }
      }
      const result = await aiDesk.generateImage({
        prompt: parsed.prompt,
        backend: args?.backend,
        model: args?.image_model,
        size: args?.size,
        quality: args?.quality,
        background: args?.background,
        exec,
      })
      return {
        prompt: parsed.prompt,
        description,
        copyModel,
        backend: result.backend,
        imageModel: result.model,
        requestedModel: result.requestedModel,
        size: result.size,
        requestedSize: result.requestedSize,
        localPath: result.localPath,
        elapsedMs: Date.now() - startedAt,
        image: result.image,
      }
    },
    presentCall() {
      return { card: 'generic', title: '文案配图', kind: 'other' }
    },
  }
}

/**
 * 插件入口：暴露 aiDesk 服务、装配工具。
 * @param {object} ctx Cordis 上下文（tools / llm 已注入）
 * @param {object} [config] profile 里该插件行的 config（可选，见 DEFAULT_OPTIONS）
 */
export function apply(ctx, config) {
  const options = resolveOptions(config)
  const aiDesk = createAiDesk(ctx, options)
  ctx.effect(() => ctx.reflect.provide('aiDesk', aiDesk), 'content-desk: aiDesk service')
  ctx.effect(() => ctx.tools.register(aiTaskTool(aiDesk, options)), 'content-desk: ai_task')
  ctx.effect(() => ctx.tools.register(aiModelsTool(aiDesk, ctx)), 'content-desk: ai_models')
  ctx.effect(() => ctx.tools.register(aiImageTool(aiDesk, options)), 'content-desk: ai_image')
  ctx.effect(() => ctx.tools.register(copyReviewTool(aiDesk, options)), 'content-desk: copy_review')
  ctx.effect(() => ctx.tools.register(copyCompareTool(aiDesk, options)), 'content-desk: copy_compare')
  ctx.effect(() => ctx.tools.register(copyCoverTool(aiDesk, options)), 'content-desk: copy_cover')
}
