// 给 dsh-TUI 注册一个 llm provider adapter，让状态栏能显示我们想要的模型名。
//
// ════════════════════════════════════════════════════════════════════
// 为什么需要这个
// ════════════════════════════════════════════════════════════════════
//
// 底部状态栏左边那个模型名走的是：
//
//   StatusLine.js:206   <Text>{channel.model}</Text>
//        ↑
//   channel.model = state.model            （channel.js:566 `model: () => state.model`）
//        ↑
//   state.model = route.model              （session-resume.js:27 / model-switch.js:86）
//        ↑
//   route = resolveModelRoute(configured, readModelPref(), DEFAULT_MODEL_ROUTE)
//
// 注意显示的是 **model id**，不是 display name。
//
// ════════════════════════════════════════════════════════════════════
// 为什么以前改不动
// ════════════════════════════════════════════════════════════════════
//
// route 不是随便写的 —— 探测到路由后要过一道校验（modelRoute.js）：
//
//   export async function validateModelRoute(llm, route, fallback) {
//     let models
//     try { models = await llm.listModels(route.provider) }
//     catch (error) {
//       if (!isUnregisteredProvider(error)) return { route }
//       return { route: fallback, rejected: route }     // ← provider 没注册 → 打回
//     }
//     if (models.length === 0 || models.some(m => m.id === route.model))
//       return { route }                                 // ← 接受
//     return { route: fallback, rejected: route }        // ← 模型不在表里 → 打回
//   }
//
// 我们之前把 provider 写成 `claude-code`，而它**不是 DSH 注册过的 provider**
// —— `llm.listModels('claude-code')` 抛 NO_ADAPTER，走第一个 return，
// 整份路由被打回默认值（`wbp` / `deepseek-v4.1-flash`）。于是状态栏显示的
// 是那个跟实际后端毫无关系的名字。
//
// ════════════════════════════════════════════════════════════════════
// 解法：自己注册一个 provider
// ════════════════════════════════════════════════════════════════════
//
// `ctx.llm.registerAdapter(providers, adapter)` 就是为此存在的官方接口
// （dsh-llm 的 `LlmAdapter` 抽象类）。注册之后：
//
//   · `listModels('claude-code')` 返回我们声明的那个模型
//     → `models.some(m => m.id === route.model)` 为真 → **路由被接受**
//   · `resolveModelInfo('claude-code', id)` 返回我们声明的
//     `context.contextWindow` 和 `reasoning.efforts`
//     → 状态栏的 ctx 条刻度、effort 档位都从这条路拿到权威值
//
// 注意：**我们从不真的通过它发请求** —— claude 是我们 spawn 的子进程。
// 这个 adapter 只负责「宣告路由存在」，`stream()` 永远不会被调用。
//
// ════════════════════════════════════════════════════════════════════
// 还需要配合的一步
// ════════════════════════════════════════════════════════════════════
//
// 光注册 adapter 不够 —— `resolveModelRoute` 的优先级是：
//
//   cordis.yml 里**成对**的 provider+model  >  ~/.dsh-tui/model.json  >  默认值
//
// dsh-tui 那行的配置里只有 `provider`、没有 `model`（半配会被整份忽略），
// 所以实际落到了 `~/.dsh-tui/model.json`。那个文件是**全局**的，改它会影响
// 用户所有 dsh-tui 窗口 —— 不能动。
//
// 所以要在**本 patch 的 dsh-tui 条目**里显式写 `provider` + `model`。
// 代价：patch 的 config 是**整段替换**不是深合并（cordis-plugin-include 的
// `applyEntryPatches` 里就是 `target[key] = value`），所以 profile 原有的
// effort / fullscreen / whaleGirl … 都得在那边手工写全。见 cordis.patch.yml。

/**
 * 把一个「只作路由声明」的 provider 注册进 DSH 的 llm 运行时。
 *
 * @param ctx cordis 上下文
 * @param log 日志函数
 * @param options.modelId 要显示、也要被接受的 model id
 * @param options.providerId provider 路由名（默认与 modelId 同源）
 * @param options.displayName provider 的人类可读名
 * @param options.modelName 模型的人类可读名
 * @param options.contextWindow 上下文容量（我们会从 claude 实报值更新它）
 * @param options.effortLevels 可选的推理档位 id 列表
 * @param options.effort 默认档位（必须是 effortLevels 里的一项）
 * @returns 注册成功与否
 */
export async function installModelAdapter(ctx, log = () => {}, options = {}) {
  const providerId = options.providerId ?? 'claude-code'
  const modelId = options.modelId ?? providerId
  const modelName = options.modelName ?? modelId
  const displayName = options.displayName ?? 'Claude Code (cc-bridge)'
  // 初始容量。拿到 claude 实报值之后由外部调 `setContextWindow` 更新。
  let contextWindow = Number.isInteger(options.contextWindow) && options.contextWindow > 0
    ? options.contextWindow
    : 200000
  // 档位表。默认那五档就是 `claude --help` 里 --effort 认的。
  //
  // 注意 `xhigh` —— dsh-tui 自己的标准档序是
  // `['off','low','medium','high','max']`（effortPrefs.js），**不含它**。
  // 标准序只用于「偏好档不在路由表里就降一档」的回退，精确命中会短路放行，
  // 所以只要在这里声明了 xhigh，dsh-tui 就能原样显示它。
  const efforts = Array.isArray(options.effortLevels) && options.effortLevels.length > 0
    ? options.effortLevels
    : ['low', 'medium', 'high', 'xhigh', 'max']
  // 默认档：给的那个必须真在表里，否则落到最后一档（最强）。
  const defaultEffort = typeof options.effort === 'string' && efforts.includes(options.effort)
    ? options.effort
    : efforts[efforts.length - 1]

  let llm
  try {
    // 软探测：没 inject 也拿得到（`ctx.get(name, false)` 查服务注册表）
    llm = ctx.get?.('llm', false)
  } catch {
    llm = undefined
  }
  if (!llm || typeof llm.registerAdapter !== 'function') {
    log('  llm 服务不可用，模型名改不了（状态栏会显示 dsh 的默认路由）')
    return { ok: false, reason: 'no llm service' }
  }

  /**
   * 我们声明的那个模型条目。
   *
   * `provider` 必须**等于**注册时用的路由名，`id`/`name` 必须非空 ——
   * dsh-llm 的 `normalizeModelInfo` 会逐项校验，不合法直接抛
   * INVALID_MODEL_INFO。
   */
  const modelEntry = () => ({
    provider: providerId,
    id: modelId,
    name: modelName,
    description: '由 cc-bridge 接管：实际后端是 Claude Code 子进程',
    inputModalities: ['text', 'image'],
  })

  const adapter = {
    providerInfo(provider) {
      return { id: provider, name: displayName }
    },

    /** 没有特殊重试策略，返回 undefined 即走默认。 */
    providerRetryPolicy() {
      return undefined
    },

    /** 声明这个 provider 下**存在**我们那个 model id —— 校验靠它通过。 */
    async listModels() {
      return [modelEntry()]
    },

    /**
     * 解析确切模型的元信息。
     *
     * 这里返回的 `context.contextWindow` 会被 dsh-tui 收进
     * `state.contextWindow`（model-actions.js:45 的 applyRouteMetadata），
     * 是 ctx 条的另一个刻度来源 —— 与 `request/context` 事件互为补充。
     *
     * `reasoning.efforts` 必须非空且 id/name 都不重复，否则抛
     * INVALID_MODEL_REASONING。档位与 profile 里 wbp 那套保持一致，
     * 免得 effort 选择器行为变化。
     */
    async resolveModel(provider, model) {
      return {
        ...modelEntry(),
        provider,
        id: model,
        context: { contextWindow },
        reasoning: {
          efforts: efforts.map((id) => ({ id, name: id })),
          defaultEffort,
        },
      }
    },

    /**
     * 我们**从不**通过这个 adapter 发请求 —— 真正的调用是 spawn claude
     * 子进程。但接口要求它存在（`LlmAdapter` 说它是「唯一必需的方法」），
     * 所以给一个明确的失败，免得哪天真被调到却静默返回空流。
     */
    async *stream() {
      throw new Error('cc-bridge: 该 provider 只用于路由声明，请求请走 AgentFactory 的 claude 子进程')
    },
  }

  try {
    llm.registerAdapter([providerId], adapter)
  } catch (err) {
    log('  注册 provider 失败：' + (err?.message ?? err))
    return { ok: false, reason: String(err?.message ?? err) }
  }

  log(`  已注册 llm provider「${providerId}」→ 模型「${modelId}」（状态栏将显示这个）`)

  return {
    ok: true,
    /** 拿到 claude 实报的窗口容量后调它，让 ctx 条刻度跟着更新。 */
    setContextWindow(n) {
      if (Number.isInteger(n) && n > 0) contextWindow = n
    },
  }
}
