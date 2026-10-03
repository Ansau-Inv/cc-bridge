/**
 * 日常 DSH ↔ cc-bridge 窗口 的信箱。
 *
 * 窗口进程独占 `claude --print`（stream-json）。宿主不直接再开一轮
 * `--print`（同一 UUID 并发会互相踩）。宿主把任务写进信箱，窗口认领后
 * 经 inbox → runClaude；回合结果写回信箱，宿主用工具读。
 *
 * Windows 上两个进程会同时改同一个 json（认领写 pid、领取 pending、
 * 心跳、宿主 append）。旧实现 rename 失败就 unlink 目标文件，pending
 * 会跟着消失 —— 活日志里的「窗口开了但不干活」就是这条。
 */

import {
  closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync,
  renameSync, unlinkSync, watch, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const WRITE_ATTEMPTS = 12
const HEARTBEAT_STALE_MS = 12_000
const STARTING_GRACE_MS = 45_000

function lockPath(file) {
  return `${file}.lock`
}

function acquireFileLock(file) {
  const dest = lockPath(file)
  mkdirSync(dirname(file), { recursive: true })
  let lastErr
  for (let i = 0; i < WRITE_ATTEMPTS * 3; i++) {
    try {
      const fd = openSync(dest, 'wx')
      writeFileSync(fd, `${process.pid} ${Date.now()}`)
      return () => {
        try { closeSync(fd) } catch { /* ignore */ }
        try { unlinkSync(dest) } catch { /* ignore */ }
      }
    } catch (err) {
      lastErr = err
      try {
        const raw = readFileSync(dest, 'utf8')
        const ts = Number(String(raw).split(/\s+/)[1])
        if (Number.isFinite(ts) && Date.now() - ts > 8000) {
          try { unlinkSync(dest) } catch { /* ignore */ }
        }
      } catch { /* lock 不存在或读失败 */ }
      sleepSync(10 + i * 5)
    }
  }
  throw lastErr ?? new Error(`信箱加锁失败：${file}`)
}

export function mailboxDir(stateDir) {
  return join(stateDir, 'mailbox')
}

export function mailboxPath(stateDir, id) {
  return join(mailboxDir(stateDir), `${id}.json`)
}

function mintId() {
  return `ccb-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`
}

function mintMsgId() {
  return `m-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 6)}`
}

function emptyBox(partial = {}) {
  return {
    id: partial.id ?? mintId(),
    hostSessionId: typeof partial.hostSessionId === 'string' ? partial.hostSessionId : null,
    cwd: typeof partial.cwd === 'string' ? partial.cwd : null,
    createdAt: partial.createdAt ?? Date.now(),
    status: partial.status ?? 'starting',
    claudeSid: partial.claudeSid ?? null,
    windowPid: partial.windowPid ?? null,
    heartbeatAt: typeof partial.heartbeatAt === 'number' ? partial.heartbeatAt : null,
    cancelRequestedAt: typeof partial.cancelRequestedAt === 'number' ? partial.cancelRequestedAt : null,
    pending: Array.isArray(partial.pending) ? partial.pending : [],
    turns: Array.isArray(partial.turns) ? partial.turns : [],
  }
}

export function parseMailboxJson(raw) {
  try {
    const v = JSON.parse(raw)
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
    if (typeof v.id !== 'string' || !v.id) return null
    return emptyBox(v)
  } catch {
    return null
  }
}

export function sleepSync(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return
  const buf = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(buf, 0, 0, Math.min(Math.trunc(n), 1000))
}

function cloneBox(box) {
  return emptyBox(JSON.parse(JSON.stringify(box)))
}

export function mergePending(a = [], b = []) {
  const seen = new Set()
  const out = []
  for (const item of [...a, ...b]) {
    if (!item || typeof item !== 'object') continue
    const id = typeof item.id === 'string' && item.id ? item.id : null
    if (id) {
      if (seen.has(id)) continue
      seen.add(id)
    }
    out.push(item)
  }
  return out
}

/**
 * 原子写。Windows 上 rename 覆盖常会 EPERM。
 * **绝不**先删目标文件再改名 —— 删了而第二次 rename 失败，pending 就没了。
 */
export function atomicWrite(file, body) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`
  writeFileSync(tmp, body, 'utf8')
  let lastErr
  for (let i = 0; i < WRITE_ATTEMPTS; i++) {
    try {
      renameSync(tmp, file)
      return
    } catch (err) {
      lastErr = err
      if (i < WRITE_ATTEMPTS - 1) sleepSync(15 * (i + 1))
    }
  }
  try {
    writeFileSync(file, body, 'utf8')
    try { unlinkSync(tmp) } catch { /* ignore */ }
    return
  } catch (err) {
    try { unlinkSync(tmp) } catch { /* ignore */ }
    throw lastErr ?? err
  }
}

export function readMailbox(stateDir, id) {
  const file = mailboxPath(stateDir, id)
  try {
    return parseMailboxJson(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function pendingIds(list) {
  return (Array.isArray(list) ? list : [])
    .map((item) => (item && typeof item.id === 'string' ? item.id : ''))
    .filter(Boolean)
}

function pendingKey(list) {
  return pendingIds(list).join('\0')
}

/**
 * @param {{ replacePending?: boolean, keepLivePending?: boolean, clearCancel?: boolean, expectedPending?: object[] }} [opts]
 *   takePending / append 必须 replacePending，否则会把刚领走的任务写回去。
 *   认领 / 心跳 / 改状态用 keepLivePending：磁盘上的队列是权威，快照里的 pending 作废。
 *   expectedPending：磁盘队列必须仍是这一版，否则抛 CCB_STALE 让 mutate 重读。
 */
export function writeMailbox(stateDir, box, opts = {}) {
  const live = readMailbox(stateDir, box.id)
  const next = cloneBox(box)
  if (live && opts.expectedPending) {
    if (pendingKey(live.pending) !== pendingKey(opts.expectedPending)) {
      const err = new Error('信箱 pending 已变，重试')
      err.code = 'CCB_STALE'
      throw err
    }
  }
  if (live) {
    if (opts.replacePending === true) {
      // next.pending 就是这次领取 / 追加 / 建箱的结果
    } else if (opts.keepLivePending === true) {
      next.pending = live.pending
    } else {
      next.pending = mergePending(live.pending, next.pending)
    }
    if ((live.turns?.length ?? 0) > (next.turns?.length ?? 0)) {
      next.turns = live.turns
    }
    if (live.claudeSid && !next.claudeSid) next.claudeSid = live.claudeSid
    if (typeof live.heartbeatAt === 'number') {
      if (typeof next.heartbeatAt !== 'number' || next.heartbeatAt < live.heartbeatAt) {
        next.heartbeatAt = live.heartbeatAt
      }
    }
    if (live.cancelRequestedAt && !next.cancelRequestedAt && opts.clearCancel !== true) {
      next.cancelRequestedAt = live.cancelRequestedAt
    }
  }
  atomicWrite(mailboxPath(stateDir, next.id), JSON.stringify(next, null, 2))
  return next
}

export function createMailbox(stateDir, { id, hostSessionId, cwd, prompt } = {}) {
  const box = emptyBox({ id, hostSessionId, cwd, status: 'starting' })
  if (typeof prompt === 'string' && prompt.trim()) {
    box.pending.push({
      id: mintMsgId(),
      role: 'host',
      text: prompt.trim(),
      at: Date.now(),
    })
  }
  const file = mailboxPath(stateDir, box.id)
  const unlock = acquireFileLock(file)
  try {
    writeMailbox(stateDir, box, { replacePending: true })
  } finally {
    unlock()
  }
  return box
}

export function listMailboxes(stateDir) {
  const dir = mailboxDir(stateDir)
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const box = readMailbox(stateDir, name.slice(0, -5))
    if (box) out.push(box)
  }
  out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  return out
}

function mutate(stateDir, id, fn, writeOpts = {}) {
  const file = mailboxPath(stateDir, id)
  const unlock = acquireFileLock(file)
  try {
    let lastErr
    for (let i = 0; i < WRITE_ATTEMPTS; i++) {
      const current = readMailbox(stateDir, id)
      if (!current && writeOpts.mustExist) {
        if (i < WRITE_ATTEMPTS - 1) {
          sleepSync(15 * (i + 1))
          continue
        }
        return null
      }
      const box = current ?? emptyBox({ id })
      const snapshot = cloneBox(box)
      const next = fn(snapshot) ?? box
      try {
        return writeMailbox(stateDir, next, {
          ...writeOpts,
          expectedPending: box.pending,
        })
      } catch (err) {
        lastErr = err
        sleepSync(15 * (i + 1))
      }
    }
    throw lastErr ?? new Error(`信箱写入失败：${id}`)
  } finally {
    unlock()
  }
}

export function appendHostMessage(stateDir, id, text) {
  if (typeof text !== 'string' || !text.trim()) return readMailbox(stateDir, id)
  const item = { id: mintMsgId(), role: 'host', text: text.trim(), at: Date.now() }
  return mutate(stateDir, id, (box) => {
    box.pending.push(item)
    return box
  }, { replacePending: true })
}

export function takePending(stateDir, id) {
  let taken = []
  const written = mutate(stateDir, id, (box) => {
    taken = Array.isArray(box.pending) ? box.pending.slice() : []
    box.pending = []
    return box
  }, { replacePending: true, mustExist: true })
  if (!written) return []
  return taken
}

export function writeTurnResult(stateDir, id, { text, ok, claudeSid, at } = {}) {
  return mutate(stateDir, id, (box) => {
    box.turns.push({
      ok: ok !== false,
      text: typeof text === 'string' ? text : '',
      at: at ?? Date.now(),
    })
    if (box.turns.length > 50) box.turns = box.turns.slice(-50)
    if (typeof claudeSid === 'string' && claudeSid) box.claudeSid = claudeSid
    box.status = ok === false ? 'error' : 'idle'
    box.cancelRequestedAt = null
    return box
  }, { clearCancel: true, keepLivePending: true })
}

export function setMailboxStatus(stateDir, id, status, extra = {}) {
  return mutate(stateDir, id, (box) => {
    box.status = status
    if (typeof extra.windowPid === 'number') box.windowPid = extra.windowPid
    if (Object.hasOwn(extra, 'claudeSid')) {
      box.claudeSid = typeof extra.claudeSid === 'string' && extra.claudeSid
        ? extra.claudeSid
        : null
    }
    if (typeof extra.heartbeatAt === 'number') box.heartbeatAt = extra.heartbeatAt
    if (Object.hasOwn(extra, 'cancelRequestedAt')) {
      box.cancelRequestedAt = typeof extra.cancelRequestedAt === 'number'
        ? extra.cancelRequestedAt
        : null
    }
    return box
  }, { keepLivePending: true, mustExist: extra.mustExist === true })
}

export function requestMailboxCancel(stateDir, id) {
  return mutate(stateDir, id, (box) => {
    box.cancelRequestedAt = Date.now()
    return box
  }, { mustExist: true, keepLivePending: true })
}

export function clearMailboxCancel(stateDir, id) {
  return mutate(stateDir, id, (box) => {
    box.cancelRequestedAt = null
    return box
  }, { clearCancel: true, mustExist: true, keepLivePending: true })
}

export function touchMailboxHeartbeat(stateDir, id, pid = process.pid) {
  return mutate(stateDir, id, (box) => {
    box.windowPid = pid
    box.heartbeatAt = Date.now()
    return box
  }, { mustExist: true, keepLivePending: true })
}

export function latestTurn(box) {
  if (!box || !Array.isArray(box.turns) || box.turns.length === 0) return null
  return box.turns[box.turns.length - 1]
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err && err.code === 'EPERM'
  }
}

/**
 * 给宿主看这扇窗还在不在。starting 的前几十秒允许还没心跳。
 */
export function inspectMailbox(box, { now = Date.now(), alive = isProcessAlive } = {}) {
  if (!box) return { state: 'missing', alive: false, pid: null }
  const pid = typeof box.windowPid === 'number' ? box.windowPid : null
  const pidAlive = pid !== null && alive(pid)
  const createdAgo = now - (box.createdAt ?? now)
  const hbAge = typeof box.heartbeatAt === 'number' ? now - box.heartbeatAt : null
  const starting = box.status === 'starting' && createdAgo < STARTING_GRACE_MS
  const loading = box.status === 'loading' && createdAgo < STARTING_GRACE_MS
  if (pidAlive) {
    if (box.status === 'loading') return { state: 'loading', alive: true, pid, heartbeatAge: hbAge }
    if (box.status === 'running') return { state: 'running', alive: true, pid, heartbeatAge: hbAge }
    if (starting) return { state: 'starting', alive: true, pid, heartbeatAge: hbAge }
    return { state: box.status || 'idle', alive: true, pid, heartbeatAge: hbAge }
  }
  if (starting || loading) {
    return { state: starting ? 'starting' : 'loading', alive: false, pid, heartbeatAge: hbAge }
  }
  if (box.status === 'closed' || (pid !== null && !pidAlive)) {
    return { state: 'dead', alive: false, pid, heartbeatAge: hbAge }
  }
  if (hbAge !== null && hbAge > HEARTBEAT_STALE_MS) {
    return { state: 'dead', alive: false, pid, heartbeatAge: hbAge }
  }
  if (box.status === 'starting' || box.status === 'loading') {
    return { state: 'dead', alive: false, pid, heartbeatAge: hbAge }
  }
  return { state: box.status || 'idle', alive: false, pid, heartbeatAge: hbAge }
}

/** 默认指挥对象：最新一扇还活着或正在启动的。死窗不选。 */
export function pickDefaultMailbox(boxes, opts) {
  if (!Array.isArray(boxes) || boxes.length === 0) return null
  for (const box of boxes) {
    const info = inspectMailbox(box, opts)
    if (info.alive || info.state === 'starting' || info.state === 'loading') return box
  }
  return null
}

export function mailboxAcceptsSend(box, opts) {
  const info = inspectMailbox(box, opts)
  if (info.state === 'missing') return { ok: false, info, reason: '没有这个窗口' }
  if (info.alive || info.state === 'starting' || info.state === 'loading') {
    return { ok: true, info }
  }
  return {
    ok: false,
    info,
    reason: `窗口 ${box.id} 已关闭或无心跳。让用户再打 /ccb，或把 spawn 设为 true。`,
  }
}

/**
 * 盯一个信箱文件。回调里再 takePending，避免和写入抢。
 * @returns {() => void} disposer
 */
export function watchMailbox(stateDir, id, onChange) {
  const dir = mailboxDir(stateDir)
  const file = mailboxPath(stateDir, id)
  mkdirSync(dir, { recursive: true })
  // 缺文件才建空箱。走 mutate，避免和宿主 create 抢写时把任务冲掉。
  if (!existsSync(file)) {
    mutate(stateDir, id, (box) => box)
  }
  let timer = null
  const fire = () => {
    timer = null
    try { onChange() } catch { /* 调用方自己记日志 */ }
  }
  const kick = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(fire, 80)
  }
  const stop = []
  try {
    // 盯目录而不是文件：Windows 上 atomicWrite 会先删再改名，文件 watcher 会跟着死。
    const watcher = watch(dir, { persistent: false }, (_event, filename) => {
      if (!filename) {
        kick()
        return
      }
      const name = String(filename)
      if (name === `${id}.json` || name.startsWith(`${id}.json.`)) kick()
    })
    watcher.on?.('error', () => {})
    stop.push(() => { try { watcher.close() } catch { /* ignore */ } })
  } catch { /* 只靠轮询 */ }
  const poll = setInterval(kick, 500)
  poll.unref?.()
  stop.push(() => clearInterval(poll))
  return () => {
    if (timer) clearTimeout(timer)
    for (const fn of stop) fn()
  }
}

export function defaultStateDir() {
  return process.env.CCB_STATE_DIR
    || (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'cc-bridge') : null)
    || join(homedir(), '.cc-bridge')
}
