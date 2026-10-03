/**
 * 单飞收件箱：对齐 dsh-agent-loop 的 ReactLoopInbox / Agent.send。
 *
 * 为什么不能做成「往当前 claude 进程插一句」
 * ------------------------------------------
 * `--print` 一轮只吃一条 user 帧，写完就 stdin.end()。
 * 官方 `steer` 的语义是「插进正在跑的那一轮的下一个 step」。
 * 我们做不到那件事，硬做会把字丢进已经关掉的管道。
 *
 * 所以本实现把 steer / inject 落成 **next-step**，等本轮 `run()` 结束后再开
 * 一轮新的 `claude --print`。观感是「打进去了，等这轮说完再回」，
 * 不是「当场插嘴」。
 *
 * 写入 vs 唤醒（官方契约，不能混）
 * --------------------------------
 *   · `inbox.append` / `prepend` / `splice` / `replace` / `remove` / `clear`
 *     只改队列，**不**唤醒。官方走 `session.append('agent/inbox/spliced')`，
 *     我们内存投影，live 事件照发。
 *   · `agent.send(message, target, wakeup)` 先 splice 再按开关唤醒。
 *   · `followup` = send(next-turn, true)
 *   · `steer`    = send(next-step, true)
 *   · `inject`   = send(next-step, false)  —— 只落盘，等下一次唤醒才跑
 *
 * 单飞 + 排空
 * ----------
 * 官方 `kick()` 在 `while (await this.turn())` 期间一直是 running，
 * 中间不切 idle。我们也一次排空：连排的 followup/steer 不夹一次 idle。
 *
 * TUI 契约（dsh-tui 0.12 / dsh 0.2.0-rc.2）
 * ------------------------------------------
 *   · 忙时 Enter → `agent.steer(message)`（PromptInput.js:1436）
 *   · 闲时 Enter → `agent.followup(message)`
 *   · Alt+Up     → `agent.inbox.remove(id)`，靠 `agent/inbox/discarded` 抽回输入框
 *   · 排队面板   → `agent/inbox/claimed` 才从 pending 消失
 *   · Esc 有排队 → `interruptAndDeliver`：`cancel()` 不清 keepInbox，
 *     再把排队重投 followup。官方靠 abort 后的 wake latch 立刻开工；
 *     我们这边 `markAborting()` + `wakeRequested` 对齐同一条。
 *   · Esc 无排队 → `cancel({keepInbox:true})`，排队留给下一轮
 *
 * claimed / discarded 的 payload 必须带 `agent`：
 * binding-events 用 `payload.agent !== capture.agent` 过滤。
 * claimed 还要带 `turn`（官方 claim(target, turn)）。
 */

/**
 * @typedef {object} QueueHooks
 * @property {{ id?: string }} [agent]
 * @property {{ emit: (type: string, payload: object) => void }} [dispatch]
 * @property {(args: ...unknown) => void} [log]
 * @property {(message: object, ctx: { turn: number }) => (void | Promise<void>)} run
 * @property {() => boolean} [blocked]
 * @property {() => void} [onStart]
 * @property {() => void} [onEnd]
 * @property {() => number} [nextTurnNumber]
 */

/**
 * 对齐官方 mutate() 的 splice 下标：trunc、负下标从尾算、Infinity 夹到末尾。
 * @param {unknown[]} list
 * @param {number} start
 * @param {number} deleteCount
 */
export function resolveSpliceRange(list, start, deleteCount) {
  const truncatedStart = Math.trunc(start)
  const offset = Number.isNaN(truncatedStart) ? 0 : truncatedStart
  const actualStart = offset < 0
    ? Math.max(list.length + offset, 0)
    : Math.min(offset, list.length)
  const truncatedDeleteCount = Math.trunc(deleteCount)
  const actualDeleteCount = Math.min(
    Math.max(Number.isNaN(truncatedDeleteCount) ? 0 : truncatedDeleteCount, 0),
    list.length - actualStart,
  )
  return { actualStart, actualDeleteCount }
}

/**
 * @param {QueueHooks} hooks
 */
export function createInboxQueue(hooks) {
  const nextTurn = []
  const nextStep = []
  let running = false
  let aborting = false
  let wakeRequested = false
  let removedCount = 0
  let tail = Promise.resolve()
  let localTurn = 0

  const emit = (type, payload) => {
    try {
      hooks.dispatch?.emit(type, { agent: hooks.agent, ...payload })
    } catch (err) {
      hooks.log?.(`emit ${type} 失败:`, String(err))
    }
  }

  const listOf = (target) => (target === 'next-step' ? nextStep : nextTurn)

  const hasPending = () => nextStep.length + nextTurn.length > 0

  const findIn = (list, id) => list.findIndex((m) => m?.id === id)

  const locate = (messageId) => {
    for (const target of ['next-step', 'next-turn']) {
      const list = listOf(target)
      const index = findIn(list, messageId)
      if (index >= 0) return { target, index, list }
    }
    return undefined
  }

  const take = () => (nextStep.length > 0 ? nextStep.shift() : nextTurn.shift())

  /**
   * `blocked` 给 runMaintenance 用：维护任务占着 idle 时，已入队的消息先趴着，
   * 维护结束再 `nudge()`。不把这条写进 `running`，否则维护本身会被当成回合。
   */
  const kick = () => {
    // 官方 wakeDriver：busy 时只有「维护」或「abort 后的 wake」才 latch，
    // 普通 steer/followup 只入队，等当前 kick 排空。interruptAndDeliver
    // 的 followup 发生在 abort 之后、本轮 run() 还没返回时，必须 latch，
    // 否则 finally 里若队列被看成空（时序缝）就会把新消息晾在那里。
    if (running || hooks.blocked?.()) return
    if (!hasPending()) return
    running = true
    wakeRequested = false
    const job = (async () => {
      try {
        for (;;) {
          while (!hooks.blocked?.()) {
            const message = take()
            if (!message) break
            const turn = hooks.nextTurnNumber?.() ?? ++localTurn
            emit('agent/inbox/claimed', { message, turn })
            try {
              await hooks.run(message, { turn })
            } catch (err) {
              hooks.log?.('turn failed:', err?.stack ?? String(err))
            }
            aborting = false
          }
          // 上一轮 await 期间 followup/steer 可能又塞进来了；继续排，不夹 idle。
          if (hooks.blocked?.() || !hasPending()) break
        }
      } finally {
        const replay = wakeRequested && hasPending()
        running = false
        aborting = false
        wakeRequested = false
        hooks.onEnd?.()
        if (replay || hasPending()) kick()
      }
    })()
    // tail 必须在 onStart 之前就位：whenIdle 跟的是 tail，
    // onStart 里的 followActivity(queue.whenIdle()) 不能拿到上一轮已 settled 的 promise。
    tail = job.then(() => undefined, () => undefined)
    hooks.onStart?.()
  }

  /** 只改队列。官方 append/prepend/splice 都不 wakeDriver。 */
  const persist = (target, start, deleteCount, inserted = []) => {
    const list = listOf(target)
    const items = Array.isArray(inserted) ? inserted.filter((m) => m != null) : []
    const { actualStart, actualDeleteCount } = resolveSpliceRange(list, start, deleteCount)
    if (actualDeleteCount === 0 && items.length === 0) return []
    const removed = list.splice(actualStart, actualDeleteCount, ...items)
    removedCount += removed.length
    for (const message of removed) emit('agent/inbox/discarded', { message })
    for (const message of items) emit('agent/inbox/inserted', { message })
    return removed
  }

  /**
   * 官方 wakeDriver(wakeAfterAbort)：
   *   · idle → 立刻 kick
   *   · 维护中 / abort 后的 wake → latch，等当前活动收尾再 kick
   *   · 普通忙时 send → 只入队（当前 kick 排空时自然接到）
   */
  const wake = (wakeAfterAbort = false) => {
    if (running || hooks.blocked?.()) {
      if (wakeAfterAbort || hooks.blocked?.()) wakeRequested = true
      return
    }
    kick()
  }

  const send = (message, target, wakeup) => {
    if (message == null) return
    // 官方：abort 后的 wakeup 一律落 next-turn。正在死的那一轮的
    // next-step 不会再被 claim，steer 这时必须改成新一轮。
    const wakingAfterAbort = !!(wakeup && (running || hooks.blocked?.()) && aborting)
    const resolved = wakingAfterAbort
      ? 'next-turn'
      : (target === 'next-step' ? 'next-step' : 'next-turn')
    persist(resolved, Infinity, 0, [message])
    if (wakeup) wake(wakingAfterAbort)
  }

  const discardAll = () => {
    // 官方 cancel(!keepInbox) 会清 wakeRequested，避免空队列还被 latch 叫醒。
    wakeRequested = false
    const dropped = persist('next-step', 0, nextStep.length, [])
    dropped.push(...persist('next-turn', 0, nextTurn.length, []))
    return dropped
  }

  const inbox = {
    get nextTurn() { return nextTurn },
    get nextStep() { return nextStep },
    get hasPending() { return hasPending() },
    state: () => ({
      pending: [...nextStep, ...nextTurn],
      size: nextStep.length + nextTurn.length,
      removedCount,
    }),
    clear: discardAll,
    append: (target, message) => { persist(target, Infinity, 0, [message]) },
    prepend: (target, message) => { persist(target, 0, 0, [message]) },
    replace: (messageId, newMessage) => {
      const loc = locate(messageId)
      if (!loc) return false
      persist(loc.target, loc.index, 1, [newMessage])
      return true
    },
    remove: (messageId) => {
      const loc = locate(messageId)
      if (!loc) return false
      persist(loc.target, loc.index, 1, [])
      return true
    },
    splice: (target, start, deleteCount, inserted = []) => persist(target, start, deleteCount, inserted),
  }

  return {
    inbox,
    get running() { return running },
    get pending() { return nextTurn.length + nextStep.length },
    get aborting() { return aborting },
    get wakeRequested() { return wakeRequested },
    send,
    followup: (message) => send(message, 'next-turn', true),
    steer: (message) => send(message, 'next-step', true),
    inject: (message) => send(message, 'next-step', false),
    /** Esc / interruptAndDeliver：当前轮已 abort，后续 wakeup 要 latch。 */
    markAborting: () => { aborting = true },
    nudge: kick,
    whenIdle: () => {
      // 官方 whenIdle 等的是「当前活动做完」，不是「队列清空」。
      // 维护占用时 blocked=true，队列里可能趴着消息、running=false、
      // tail 已经 settled —— 再 then(wait) 会同步空转。
      if (!running) return Promise.resolve()
      const wait = () => (running ? tail.then(wait) : Promise.resolve())
      return wait()
    },
    clear: discardAll,
  }
}
