/**
 * 日常 DSH（网页 / dsh-tui）挂的那一层：
 *   · `/ccb <任务>` —— 另开一扇完整 cc-bridge-tui（橙色女仆 + factory）
 *   · `ccb_send` / `ccb_status` / `ccb_list` / `ccb_cancel` —— DeepSeek 当 teammate 指挥 Claude
 *
 * 这一层**绝不** setFactory、绝不改立绘/大字/主题。
 * 整窗替换（橙色女仆）只发生在新窗口进程里，走 run.ps1 / --patch。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  appendHostMessage, createMailbox, inspectMailbox, latestTurn, listMailboxes,
  mailboxAcceptsSend, pickDefaultMailbox, readMailbox, requestMailboxCancel,
  setMailboxStatus,
} from './mailbox.mjs'

const PLUGIN_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')

function resolveCwd(agent, fallback) {
  const fromHeader = agent?.session?.header?.cwd
  if (typeof fromHeader === 'string' && fromHeader.trim()) return fromHeader
  if (typeof fallback === 'string' && fallback.trim()) return fallback
  return process.cwd()
}

export function renderBox(box, opts) {
  if (!box) return '没有这个窗口。'
  const last = latestTurn(box)
  const pending = box.pending?.length ?? 0
  const info = inspectMailbox(box, opts)
  const lastText = last?.text
    ? last.text.length > 800 ? `${last.text.slice(0, 800)}…` : last.text
    : '(还没有回合结果)'
  const alive = info.alive ? '活着' : (info.state === 'starting' || info.state === 'loading' ? '启动中' : '已死')
  const loadingHint = info.state === 'loading' || (info.state === 'running' && !last)
    ? '\n提示：第一轮 `--print` 要加载 Claude 的整套工具面（本机常见 300+ 工具 / ~24k tokens），可能要 1–3 分钟。这是在干活，不是没连上。'
    : ''
  return [
    `窗口 ${box.id}`,
    `状态 ${box.status} / 存活 ${alive}${box.windowPid ? ` pid=${box.windowPid}` : ''}`,
    `cwd ${box.cwd ?? '(未记)'}`,
    pending ? `排队 ${pending} 条` : '排队空',
    box.claudeSid ? `claude ${box.claudeSid}` : 'claude 尚未分配 UUID（冷启动）',
    box.cancelRequestedAt ? '已请求中断，等窗口认领' : '',
    `最近回复：\n${lastText}${loadingHint}`,
  ].filter(Boolean).join('\n')
}

export function resolveHostTarget(stateDir, windowId, opts) {
  const id = typeof windowId === 'string' ? windowId.trim() : ''
  if (id) {
    const box = readMailbox(stateDir, id)
    if (!box) return { box: null, info: { state: 'missing', alive: false, pid: null } }
    return { box, info: inspectMailbox(box, opts) }
  }
  const boxes = listMailboxes(stateDir)
  const live = pickDefaultMailbox(boxes, opts)
  if (!live) {
    return { box: null, info: { state: 'missing', alive: false, pid: null } }
  }
  return { box: live, info: inspectMailbox(live, opts) }
}

function findPwsh() {
  const candidates = [
    process.env.PWSH_EXE,
    'pwsh',
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ].filter(Boolean)
  for (const c of candidates) {
    if (c === 'pwsh') return c
    if (existsSync(c)) return c
  }
  return 'pwsh'
}

/**
 * 新开一扇独立终端，跑完整 cc-bridge 窗口（factory + 橙色女仆）。
 * 不走独立 profile，走 run.ps1 --patch，外观和日常 dsh-tui 隔离。
 *
 * Windows：不能 `spawn(pwsh, …, { detached, stdio:'ignore' })`。
 * Node 会给子进程 CREATE_NO_WINDOW，`wt.exe` 那个 0 字节商店别名
 * 在这种进程里会静默失败（exit 0、信箱已写、窗不出现）。
 * 走 `cmd /c start "" …` 才真正弹出可见窗口。
 */
export function launchBridgeWindow({ id, cwd, log, stateDir }) {
  const launcher = join(PLUGIN_ROOT, 'launch-window.ps1')
  if (!existsSync(launcher)) {
    throw new Error(`找不到启动脚本：${launcher}`)
  }
  const spec = buildSpawnSpec({ id, cwd, stateDir })
  log?.('launch window', id, 'cwd=', cwd, spec.command, spec.args.join(' '))
  if (process.env.CCB_TEST_NO_SPAWN) {
    return { pid: 0, unref() {} }
  }
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.on('error', (err) => {
    log?.('launch window spawn 失败：', err.code ?? '', err.message)
  })
  child.unref()
  return child
}

/** 给测试看启动参数，不含真正 spawn。 */
export function buildLaunchArgs({ id, cwd, stateDir, title }) {
  const launcher = join(PLUGIN_ROOT, 'launch-window.ps1')
  const args = ['-NoProfile', '-File', launcher, '-MailboxId', id]
  if (typeof cwd === 'string' && cwd.trim()) args.push('-Cwd', cwd)
  if (typeof stateDir === 'string' && stateDir.trim()) args.push('-StateDir', stateDir)
  if (typeof title === 'string' && title.trim()) args.push('-Title', title)
  return args
}

/** 真正交给 spawn 的 command/args。Windows 必须套 cmd /c start。 */
export function buildSpawnSpec({ id, cwd, stateDir }) {
  const pwsh = findPwsh()
  // 标题不能有空格：要过 cmd /c start，空格会把参数拆断。
  const inner = buildLaunchArgs({
    id, cwd, stateDir, title: id,
  })
  if (process.platform === 'win32') {
    return {
      command: 'cmd.exe',
      args: ['/c', 'start', '', pwsh, ...inner],
      cwd: PLUGIN_ROOT,
    }
  }
  return { command: pwsh, args: inner, cwd: PLUGIN_ROOT }
}

function loadDefineTool(log) {
  const { homedir } = process.getBuiltinModule('node:os')
  const anchors = [
    process.env.DSH_HOME && join(process.env.DSH_HOME, 'profiles', 'node_modules', 'noop.js'),
    process.env.DSH_PROFILE_DIR && join(process.env.DSH_PROFILE_DIR, 'node_modules', 'noop.js'),
    join(homedir(), '.dsh', 'profiles', 'node_modules', 'noop.js'),
    process.argv[1],
  ].filter(Boolean)
  for (const anchor of anchors) {
    try {
      const { createRequire } = process.getBuiltinModule('node:module')
      const req = createRequire(anchor)
      const hit = req.resolve('@deepseek-ai/dsh-tools')
      return import(new URL(`file:///${hit.replace(/\\/g, '/')}`).href)
    } catch (err) {
      log?.(`解析 dsh-tools 失败 ${anchor}: ${err.code ?? ''} ${err.message}`)
    }
  }
  return null
}

const installed = { command: false, tools: false }

/** 单测重置。正式运行不要调。 */
export function resetHostSurfaceForTests() {
  installed.command = false
  installed.tools = false
}

export async function installHostSurface(ctx, config, { stateDir, log }) {
  // 只走 get(..., false)。直接读 ctx.tools / ctx.commands 会在没声明 inject 时抛。
  let tools
  let commands
  try { tools = ctx.get?.('tools', false) } catch { tools = undefined }
  try { commands = ctx.get?.('commands', false) } catch { commands = undefined }
  if (!tools && !commands) {
    return { ok: false, reason: 'no-host-services' }
  }

  const openWindow = (prompt, agent) => {
    const cwd = resolveCwd(agent, config.cwd)
    const box = createMailbox(stateDir, {
      hostSessionId: agent?.session?.id ?? agent?.id ?? null,
      cwd,
      prompt,
    })
    try {
      launchBridgeWindow({ id: box.id, cwd, log, stateDir })
    } catch (err) {
      setMailboxStatus(stateDir, box.id, 'error')
      throw err
    }
    return box
  }

  const effect = typeof ctx.effect === 'function' ? ctx.effect.bind(ctx) : (fn) => fn()

  if (!installed.command && commands?.register) {
    effect(() => commands.register({
      name: 'ccb',
      description: '另开一扇 cc-bridge-tui，用 Claude Code 做这件事；DeepSeek 继续当指挥。',
      input: { hint: '<任务，可空：只开窗口>' },
      handler: ({ agent, rawInput }) => {
        const prompt = String(rawInput ?? '').trim()
        try {
          const box = openWindow(prompt, agent)
          return {
            kind: 'success',
            text: prompt
              ? `已开窗口 ${box.id}，任务已写进信箱。橙色窗口绑上 Channel 后会自己开工；第一轮冷启动常要 1–3 分钟（加载 300+ 工具 / ~24k tokens），不是没连上。用 ccb_status ${box.id} 看进度，ccb_cancel 可中断。`
              : `已开窗口 ${box.id}。进那个橙色窗口跟 Claude 聊，或用 ccb_send 指挥。`,
          }
        } catch (err) {
          return { kind: 'error', text: `开窗口失败：${err.message}` }
        }
      },
    }), 'cc-bridge.register(/ccb)')
    installed.command = true
    log?.('host 面：已注册 /ccb')
  }

  if (installed.tools) return { ok: true, tools: true, command: installed.command }
  if (!tools?.register) {
    return { ok: installed.command, tools: false, command: installed.command }
  }

  const toolsMod = await loadDefineTool(log)
  if (!toolsMod?.defineTool) {
    return { ok: installed.command, tools: false, command: installed.command }
  }

  const { defineTool } = toolsMod

  effect(() => tools.register(defineTool({
    name: 'ccb_send',
    description:
      '向一扇还活着的 cc-bridge 窗口里的 Claude Code 下达任务。'
      + '只确认信箱收下，不返回最终答复；之后用 ccb_status 看最近一轮。'
      + '省略 window_id 时只选还活着或正在启动的窗口，绝不发给已关的窗。'
      + '窗口已死就报错；要新开一扇把 spawn 设为 true。'
      + '本调用不要阻塞会话空等 Claude——第一轮冷启动可能要 1–3 分钟。',
    parameters: {
      message: {
        type: 'string',
        required: true,
        description: '交给 Claude Code 的任务或补充说明。',
      },
      window_id: {
        type: 'string',
        description: '窗口 id（ccb-…）。省略则用最近一扇还活着的。',
      },
      spawn: {
        type: 'boolean',
        description: '没有活窗口时是否新开一扇。默认 false。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          windowId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          spawned: { type: 'boolean', required: true },
          alive: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.spawned
          ? `opened window ${value.windowId} and queued the task`
          : `queued task for window ${value.windowId} (${value.status})`,
      }],
    },
    async execute(args, exec) {
      const wanted = typeof args.window_id === 'string' ? args.window_id.trim() : ''
      if (wanted) {
        const existing = readMailbox(stateDir, wanted)
        if (!existing) throw new Error(`没有这个窗口：${wanted}`)
        const gate = mailboxAcceptsSend(existing)
        if (!gate.ok) {
          if (args.spawn === true) {
            const box = openWindow(args.message, exec.agent)
            return { windowId: box.id, status: box.status, spawned: true, alive: false }
          }
          throw new Error(gate.reason)
        }
        appendHostMessage(stateDir, wanted, args.message)
        return { windowId: wanted, status: existing.status, spawned: false, alive: gate.info.alive }
      }
      const picked = pickDefaultMailbox(listMailboxes(stateDir))
      if (!picked) {
        if (args.spawn !== true) {
          throw new Error('没有还活着的 cc-bridge 窗口。让用户打 /ccb <任务>，或把 spawn 设为 true。')
        }
        const box = openWindow(args.message, exec.agent)
        return { windowId: box.id, status: box.status, spawned: true, alive: false }
      }
      appendHostMessage(stateDir, picked.id, args.message)
      const info = inspectMailbox(picked)
      return { windowId: picked.id, status: picked.status, spawned: false, alive: info.alive }
    },
  })), 'cc-bridge.register(ccb_send)')

  effect(() => tools.register(defineTool({
    name: 'ccb_status',
    description:
      '查看一扇 cc-bridge 窗口的状态、是否还活着、以及 Claude 最近一轮回复。'
      + '省略 window_id 时只看最近一扇还活着的。不要阻塞会话空等；隔一会儿再问一次即可。'
      + '状态 loading / 第一轮 running 且还没回复，是在加载工具面，不是断线。',
    parameters: {
      window_id: {
        type: 'string',
        description: '窗口 id。省略则用最近一扇还活着的。',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const { box } = resolveHostTarget(stateDir, args.window_id)
      if (!box) return '还没有还活着的 cc-bridge 窗口。让用户打 /ccb <任务>。'
      return renderBox(box)
    },
  })), 'cc-bridge.register(ccb_status)')

  effect(() => tools.register(defineTool({
    name: 'ccb_list',
    description: '列出本机已打开或曾打开的 cc-bridge 窗口，并标明还活着还是已死。指挥时只用活着的 id。',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      const boxes = listMailboxes(stateDir)
      if (boxes.length === 0) return '(no cc-bridge windows)'
      return boxes.map((b) => {
        const last = latestTurn(b)
        const snippet = last?.text ? last.text.replace(/\s+/g, ' ').slice(0, 80) : '-'
        const info = inspectMailbox(b)
        const life = info.alive ? 'alive' : (info.state === 'starting' || info.state === 'loading' ? info.state : 'dead')
        return `${b.id} [${b.status}/${life}] pending=${b.pending?.length ?? 0} last=${snippet}`
      }).join('\n')
    },
  })), 'cc-bridge.register(ccb_list)')

  effect(() => tools.register(defineTool({
    name: 'ccb_cancel',
    description:
      '请一扇还活着的 cc-bridge 窗口中断当前这一轮 Claude（等价于窗口里按 Esc）。'
      + '只写中断请求，窗口自己杀 --print 树；不会强杀 TUI 进程。'
      + '窗口已关就报错，不要再往它 ccb_send。',
    parameters: {
      window_id: {
        type: 'string',
        description: '窗口 id。省略则用最近一扇还活着的。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          windowId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          requested: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `asked window ${value.windowId} to cancel (${value.status})`,
      }],
    },
    async execute(args) {
      const { box, info } = resolveHostTarget(stateDir, args.window_id)
      if (!box) throw new Error('没有还活着的 cc-bridge 窗口。')
      if (!(info.alive || info.state === 'starting' || info.state === 'loading')) {
        throw new Error(`窗口 ${box.id} 已关闭，没法中断。`)
      }
      const next = requestMailboxCancel(stateDir, box.id)
      if (!next) throw new Error(`没有这个窗口：${box.id}`)
      return { windowId: box.id, status: next.status, requested: true }
    },
  })), 'cc-bridge.register(ccb_cancel)')

  log?.('host 面：已注册 ccb_send / ccb_status / ccb_list / ccb_cancel')
  installed.tools = true
  return { ok: true, tools: true, command: installed.command }
}
