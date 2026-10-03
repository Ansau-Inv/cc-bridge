import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { consumeNdjson, flushNdjson } from '../src/ndjson.mjs'
import { parseMapJson, mappingIdFromResult } from '../src/session-map.mjs'
import { createInboxQueue, resolveSpliceRange } from '../src/inbox-queue.mjs'
import {
  appendHostMessage, createMailbox, inspectMailbox, latestTurn, listMailboxes,
  mailboxAcceptsSend, parseMailboxJson, pickDefaultMailbox, readMailbox,
  requestMailboxCancel, setMailboxStatus, takePending, writeTurnResult,
} from '../src/mailbox.mjs'
import { resolveMode, resolveStateDir, resolveWindowCwd, windowAppearanceDefaults } from '../src/mode.mjs'
import { renderBox, resolveHostTarget } from '../src/host-surface.mjs'
import {
  ensureHostCcbCommand, interceptsCcb, HOST_CCB_COMMAND,
  injectCcbIntoCommandsSource, isTuiCommandsModuleUrl,
} from '../src/host-slash.mjs'
import { collectTuiRootCandidates } from '../src/tui-roots.mjs'
import {
  buildLaunchArgs, buildSpawnSpec, installHostSurface, resetHostSurfaceForTests,
} from '../src/host-surface.mjs'

describe('consumeNdjson', () => {
  it('整行带换行：立刻成行，rest 为空', () => {
    const r = consumeNdjson('', '{"type":"result"}\n')
    assert.deepEqual(r.lines, ['{"type":"result"}'])
    assert.equal(r.rest, '')
  })

  it('残行：不成行，整段留在 rest', () => {
    const r = consumeNdjson('', '{"type":"result"}')
    assert.deepEqual(r.lines, [])
    assert.equal(r.rest, '{"type":"result"}')
  })

  it('半行 + 半行 + 换行：拼成一行', () => {
    const a = consumeNdjson('', '{"type":')
    const b = consumeNdjson(a.rest, '"result"}\n')
    assert.deepEqual(a.lines, [])
    assert.deepEqual(b.lines, ['{"type":"result"}'])
    assert.equal(b.rest, '')
  })

  it('flush 残行：等价于再喂一个换行，不丢内容', () => {
    const r = flushNdjson('{"type":"result","session_id":"abc"}')
    assert.deepEqual(r.lines, ['{"type":"result","session_id":"abc"}'])
    assert.equal(r.rest, '')
  })

  it('复现旧 bug：先清空再喂换行，残行会丢', () => {
    let outBuf = '{"type":"result"}'
    const tail = outBuf
    outBuf = ''
    const broken = consumeNdjson(outBuf, '\n')
    assert.deepEqual(broken.lines, [])

    const fixed = consumeNdjson(tail, '\n')
    assert.deepEqual(fixed.lines, ['{"type":"result"}'])
  })

  it('空 buffer flush 不产出空行', () => {
    assert.deepEqual(flushNdjson(''), { lines: [], rest: '' })
    assert.deepEqual(flushNdjson('   '), { lines: [], rest: '' })
  })
})

describe('session-map', () => {
  it('非对象 JSON 当成空表', () => {
    assert.deepEqual(parseMapJson('null'), {})
    assert.deepEqual(parseMapJson('[]'), {})
    assert.deepEqual(parseMapJson('"x"'), {})
    assert.deepEqual(parseMapJson('{'), {})
  })

  it('对象只留字符串值', () => {
    assert.deepEqual(parseMapJson('{"a":"b"}'), { a: 'b' })
    assert.deepEqual(parseMapJson('{"a":"b","n":1,"z":null,"e":""}'), { a: 'b' })
  })

  it('出错轮只要带了 session_id 也该写映射', () => {
    assert.equal(
      mappingIdFromResult('session-dsh', { is_error: true, session_id: 'claude-uuid' }),
      'claude-uuid',
    )
  })

  it('没有 session_id 或等于 dsh id 则不写', () => {
    assert.equal(mappingIdFromResult('session-dsh', { is_error: false }), null)
    assert.equal(mappingIdFromResult('same', { session_id: 'same' }), null)
    assert.equal(mappingIdFromResult('x', null), null)
  })
})

describe('inbox-queue', () => {
  it('steer 在忙时入队，本轮结束后才跑', async () => {
    const order = []
    let release
    const first = new Promise((r) => { release = r })
    const q = createInboxQueue({
      agent: { id: 'a' },
      dispatch: { emit: (type, payload) => order.push([type, payload.message?.id]) },
      run: async (message) => {
        order.push(['run', message.id])
        if (message.id === 'm1') await first
      },
    })

    q.followup({ id: 'm1', content: '一' })
    q.steer({ id: 'm2', content: '二' })
    assert.equal(q.running, true)
    assert.equal(q.pending, 1)
    assert.equal(q.inbox.nextStep.length, 1)

    release()
    await q.whenIdle()
    assert.deepEqual(
      order.filter((x) => x[0] === 'run').map((x) => x[1]),
      ['m1', 'm2'],
    )
    assert.equal(q.running, false)
    assert.equal(q.pending, 0)
  })

  it('followup 重入不会并行跑两轮', async () => {
    let concurrent = 0
    let max = 0
    const q = createInboxQueue({
      run: async () => {
        concurrent += 1
        max = Math.max(max, concurrent)
        await Promise.resolve()
        concurrent -= 1
      },
    })
    q.followup({ id: 'a' })
    q.followup({ id: 'b' })
    q.followup({ id: 'c' })
    await q.whenIdle()
    assert.equal(max, 1)
  })

  it('remove 发 discarded，claimed 带 agent', async () => {
    const events = []
    const agent = { id: 'ag' }
    const q = createInboxQueue({
      agent,
      dispatch: { emit: (type, payload) => events.push({ type, agent: payload.agent, id: payload.message?.id }) },
      run: async () => {},
    })
    q.steer({ id: 'keep' })
    q.steer({ id: 'drop' })
    assert.equal(q.inbox.remove('drop'), true)
    assert.equal(q.inbox.remove('ghost'), false)
    await q.whenIdle()
    assert.equal(events.some((e) => e.type === 'agent/inbox/discarded' && e.id === 'drop'), true)
    assert.equal(events.find((e) => e.type === 'agent/inbox/claimed')?.agent, agent)
  })

  it('run 抛错也不卡死队列', async () => {
    const ran = []
    const q = createInboxQueue({
      log: () => {},
      run: async (m) => {
        ran.push(m.id)
        if (m.id === 'boom') throw new Error('boom')
      },
    })
    q.followup({ id: 'boom' })
    q.followup({ id: 'after' })
    await q.whenIdle()
    assert.deepEqual(ran, ['boom', 'after'])
  })

  it('state() 暴露 pending / size / removedCount', () => {
    const q = createInboxQueue({
      blocked: () => true,
      run: async () => {},
    })
    q.steer({ id: 'a' })
    q.followup({ id: 'b' })
    assert.deepEqual(q.inbox.state(), {
      pending: [{ id: 'a' }, { id: 'b' }],
      size: 2,
      removedCount: 0,
    })
    q.inbox.remove('a')
    assert.equal(q.inbox.state().removedCount, 1)
    assert.equal(q.inbox.state().size, 1)
  })

  it('blocked 时入队不跑，nudge 才开工', async () => {
    const ran = []
    let blocked = true
    const q = createInboxQueue({
      blocked: () => blocked,
      run: async (m) => { ran.push(m.id) },
    })
    q.followup({ id: 'later' })
    assert.equal(q.running, false)
    assert.equal(q.pending, 1)
    blocked = false
    q.nudge()
    await q.whenIdle()
    assert.deepEqual(ran, ['later'])
  })

  it('cancel keepInbox=false 时 clear 会 discarded', () => {
    const events = []
    const q = createInboxQueue({
      blocked: () => true,
      dispatch: { emit: (type, payload) => events.push(type + ':' + payload.message.id) },
      run: async () => {},
    })
    q.steer({ id: 'keep-me' })
    q.clear()
    assert.equal(q.pending, 0)
    assert.equal(events.includes('agent/inbox/discarded:keep-me'), true)
  })

  it('whenIdle 在 blocked+pending 时立刻返回，不空转', async () => {
    const q = createInboxQueue({
      blocked: () => true,
      run: async () => {},
    })
    q.followup({ id: 'later' })
    assert.equal(q.running, false)
    assert.equal(q.pending, 1)
    await q.whenIdle()
  })

  it('append / inject 只落盘不唤醒，followup 才开工', async () => {
    const ran = []
    const q = createInboxQueue({
      run: async (m) => { ran.push(m.id) },
    })
    q.inbox.append('next-turn', { id: 'parked' })
    q.inject({ id: 'injected' })
    assert.equal(q.running, false)
    assert.equal(q.pending, 2)
    assert.deepEqual(ran, [])
    q.followup({ id: 'wake' })
    await q.whenIdle()
    assert.deepEqual(ran, ['injected', 'parked', 'wake'])
  })

  it('send(..., false) 不跑，send(..., true) 才跑', async () => {
    const ran = []
    const q = createInboxQueue({
      run: async (m) => { ran.push(m.id) },
    })
    q.send({ id: 'quiet' }, 'next-turn', false)
    assert.equal(q.running, false)
    q.send({ id: 'loud' }, 'next-turn', true)
    await q.whenIdle()
    assert.deepEqual(ran, ['quiet', 'loud'])
  })

  it('replace 发 discarded + inserted，不唤醒', async () => {
    const events = []
    const ran = []
    const q = createInboxQueue({
      dispatch: { emit: (type, payload) => events.push(type + ':' + payload.message.id) },
      run: async (m) => { ran.push(m.id) },
    })
    q.inbox.append('next-step', { id: 'old' })
    assert.equal(q.inbox.replace('old', { id: 'new' }), true)
    assert.equal(q.running, false)
    assert.equal(q.inbox.nextStep[0].id, 'new')
    assert.equal(events.includes('agent/inbox/discarded:old'), true)
    assert.equal(events.includes('agent/inbox/inserted:new'), true)
    assert.deepEqual(ran, [])
  })

  it('splice 负下标 / Infinity 对齐官方 mutate', () => {
    assert.deepEqual(resolveSpliceRange(['a', 'b', 'c'], -1, 1), { actualStart: 2, actualDeleteCount: 1 })
    assert.deepEqual(resolveSpliceRange(['a'], Infinity, 0), { actualStart: 1, actualDeleteCount: 0 })
    assert.deepEqual(resolveSpliceRange(['a', 'b'], NaN, NaN), { actualStart: 0, actualDeleteCount: 0 })
    const q = createInboxQueue({ run: async () => {} })
    q.inbox.append('next-turn', { id: 'a' })
    q.inbox.append('next-turn', { id: 'b' })
    q.inbox.append('next-turn', { id: 'c' })
    const removed = q.inbox.splice('next-turn', -1, 1, [])
    assert.deepEqual(removed.map((m) => m.id), ['c'])
    assert.deepEqual(q.inbox.nextTurn.map((m) => m.id), ['a', 'b'])
    q.inbox.splice('next-turn', Infinity, 0, [{ id: 'd' }])
    assert.deepEqual(q.inbox.nextTurn.map((m) => m.id), ['a', 'b', 'd'])
  })

  it('claimed 带 turn，连排不夹 idle', async () => {
    const claimed = []
    const statuses = []
    const q = createInboxQueue({
      nextTurnNumber: (() => { let n = 0; return () => ++n })(),
      dispatch: {
        emit: (type, payload) => {
          if (type === 'agent/inbox/claimed') claimed.push(payload.turn)
        },
      },
      onStart: () => statuses.push('start'),
      onEnd: () => statuses.push('end'),
      run: async () => {},
    })
    q.followup({ id: 'a' })
    q.followup({ id: 'b' })
    q.followup({ id: 'c' })
    await q.whenIdle()
    assert.deepEqual(claimed, [1, 2, 3])
    assert.deepEqual(statuses, ['start', 'end'])
  })

  it('Esc + 排队：interruptAndDeliver 立刻中断，重投的 followup 下一轮就跑', async () => {
    const ran = []
    let release
    const first = new Promise((r) => { release = r })
    const q = createInboxQueue({
      run: async (message) => {
        ran.push(message.id)
        if (message.id === 'live') await first
      },
    })
    q.followup({ id: 'live' })
    q.steer({ id: 'queued' })
    assert.equal(q.running, true)
    assert.equal(q.pending, 1)

    // 官方 input-actions.interruptAndDeliver：cancel() 不清 keepInbox，
    // 再把排队重投 followup。微任务里送，本轮 run() 还没返回。
    q.markAborting()
    q.clear()
    assert.equal(q.pending, 0)
    q.followup({ id: 'queued' })
    assert.equal(q.aborting, true)
    assert.equal(q.wakeRequested, true)
    assert.equal(q.inbox.nextTurn[0].id, 'queued')
    assert.equal(q.inbox.nextStep.length, 0)

    release()
    await q.whenIdle()
    assert.deepEqual(ran, ['live', 'queued'])
    assert.equal(q.running, false)
    assert.equal(q.pending, 0)
  })

  it('Esc 无排队 keepInbox：中断后原来的 steer 仍会跑', async () => {
    const ran = []
    let release
    const first = new Promise((r) => { release = r })
    const q = createInboxQueue({
      run: async (message) => {
        ran.push(message.id)
        if (message.id === 'live') await first
      },
    })
    q.followup({ id: 'live' })
    q.steer({ id: 'parked' })
    q.markAborting()
    // keepInbox=true：不清队列，也不重投
    assert.equal(q.pending, 1)
    release()
    await q.whenIdle()
    assert.deepEqual(ran, ['live', 'parked'])
  })

  it('interruptAndDeliver 对齐官方微任务：先 cancel 再 followup', async () => {
    const ran = []
    let release
    const first = new Promise((r) => { release = r })
    const q = createInboxQueue({
      run: async (message) => {
        ran.push(message.id)
        if (message.id === 'live') await first
      },
    })
    q.followup({ id: 'live' })
    q.steer({ id: 'a' })
    q.steer({ id: 'b' })
    const parked = q.inbox.state().pending.map((m) => m.id)
    q.markAborting()
    q.clear()
    queueMicrotask(() => {
      for (const id of parked) q.followup({ id })
    })
    await Promise.resolve()
    assert.equal(q.wakeRequested, true)
    assert.deepEqual(q.inbox.nextTurn.map((m) => m.id), ['a', 'b'])
    release()
    await q.whenIdle()
    assert.deepEqual(ran, ['live', 'a', 'b'])
  })
})

describe('mode', () => {
  it('显式 config.mode 压过环境和信箱', () => {
    assert.equal(resolveMode({ mode: 'host' }, { CCB_MAILBOX_ID: 'ccb-x', CCB_MODE: 'window' }), 'host')
    assert.equal(resolveMode({ mode: 'window' }, {}), 'window')
    assert.equal(resolveMode({ mode: 'takeover' }, {}), 'takeover')
  })

  it('CCB_MODE / 信箱 / 独立 profile 依次回落，默认 host', () => {
    assert.equal(resolveMode({}, { CCB_MODE: 'window' }), 'window')
    assert.equal(resolveMode({}, { CCB_MAILBOX_ID: 'ccb-1' }), 'window')
    assert.equal(resolveMode({}, { DSH_PROFILE: 'cc-bridge-tui' }), 'takeover')
    assert.equal(resolveMode({}, { DSH_PROFILE_DIR: 'C:\\Users\\x\\.dsh\\profiles\\cc-bridge-headless' }), 'takeover')
    assert.equal(resolveMode({}, { DSH_PROFILE: 'dsh-tui' }), 'host')
    assert.equal(resolveMode({}, {}), 'host')
  })

  it('window 缺外观字段就补橙色女仆，appearance:false 不补', () => {
    const filled = windowAppearanceDefaults({})
    assert.equal(filled.maidArt, 'assets/maid.png')
    assert.equal(filled.splashTitle, 'CLAUDE CODE')
    const off = windowAppearanceDefaults({ appearance: false })
    assert.equal(off.maidArt, undefined)
    assert.equal(off.splashTitle, undefined)
  })

  it('橙色窗口 cwd 跟 DeepSeek 会话，不跟插件仓库', () => {
    assert.equal(resolveWindowCwd({
      metaCwd: 'D:\\project',
      processCwd: 'D:\\code\\cc-bridge',
    }), 'D:\\project')
    assert.equal(resolveWindowCwd({
      mailboxCwd: 'D:\\project',
      processCwd: 'D:\\code\\cc-bridge',
    }), 'D:\\project')
    assert.equal(resolveWindowCwd({
      processCwd: 'D:\\code\\cc-bridge',
    }), 'D:\\code\\cc-bridge')
  })

  it('DSH_HOME 未设时状态目录跟 ~/.dsh，不落到 ~/.cc-bridge', () => {
    const home = mkdtempSync(join(tmpdir(), 'ccb-statedir-'))
    mkdirSync(join(home, '.dsh'))
    assert.equal(
      resolveStateDir({}, { home, exists: (p) => p === join(home, '.dsh') }),
      join(home, '.dsh', 'cc-bridge'),
    )
    assert.equal(
      resolveStateDir({ CCB_STATE_DIR: 'D:\\tmp\\ccb' }, { home, exists: () => true }),
      'D:\\tmp\\ccb',
    )
  })
})

describe('host /ccb 拦截', () => {
  it('commandList 没有 ccb 时会进模型（复现截图）', () => {
    const locals = [
      { name: 'help', description: 'Show shortcuts' },
      { name: 'clear', description: 'Clear' },
    ]
    assert.equal(interceptsCcb(locals), false)
  })

  it('LOCAL_COMMANDS 写入 external /ccb 后 TUI 截胡', () => {
    const locals = [{ name: 'help', description: 'Show shortcuts' }]
    const r = ensureHostCcbCommand(locals)
    assert.equal(r.ok, true)
    assert.equal(r.added, true)
    assert.equal(interceptsCcb(locals), true)
    const again = ensureHostCcbCommand(locals)
    assert.equal(again.added, false)
    assert.equal(locals.filter((c) => c.name === 'ccb').length, 1)
    assert.equal(locals.find((c) => c.name === 'ccb').external, true)
    assert.equal(HOST_CCB_COMMAND.name, 'ccb')
  })

  it('Chat default 分支只认 external 的 ccb', () => {
    const list = [{ name: 'ccb', description: 'x' }]
    assert.equal(list.find((c) => c.external && c.name === 'ccb'), undefined)
    ensureHostCcbCommand(list)
    assert.equal(list.find((c) => c.external && c.name === 'ccb')?.name, 'ccb')
  })

  it('加载钩子只改 dsh-tui 的 commands.js，不误伤 channel/commands', () => {
    assert.equal(isTuiCommandsModuleUrl(
      'file:///C:/Users/x/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui/lib/types/commands.js',
    ), true)
    assert.equal(isTuiCommandsModuleUrl(
      'file:///C:/Users/x/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui/lib/types/dsh-adapter/channel/commands.js',
    ), false)
    assert.equal(isTuiCommandsModuleUrl('file:///D:/code/cc-bridge/src/host-slash.mjs'), false)
  })

  it('在 LOCAL_COMMANDS 求值后立刻 push /ccb，refresh 复制也能截胡', () => {
    const fake = [
      'export const LOCAL_COMMANDS = [',
      "  { name: 'help', description: 'Show shortcuts' },",
      '];',
      'export const HIDDEN_COMMANDS = [];',
    ].join('\n')
    const { source, hit } = injectCcbIntoCommandsSource(fake)
    assert.equal(hit, true)
    assert.equal(source.includes("name: 'ccb'"), true)
    assert.equal(source.includes('external: true'), true)
    assert.equal(source.indexOf("LOCAL_COMMANDS.push") < source.indexOf('HIDDEN_COMMANDS'), true)
    const again = injectCcbIntoCommandsSource(source)
    assert.equal(again.already, true)
    assert.equal(again.source, source)

    const real = join(
      process.env.USERPROFILE ?? '',
      '.dsh', 'profiles', 'dsh-tui', 'node_modules',
      '@deepseek-harness-tui', 'dsh-tui', 'lib', 'types', 'commands.js',
    )
    if (existsSync(real)) {
      const raw = readFileSync(real, 'utf8')
      const patched = injectCcbIntoCommandsSource(raw)
      assert.equal(patched.hit, true)
      assert.equal(patched.source.includes("name: 'ccb'"), true)
      assert.equal(patched.source.includes('external: true'), true)
      assert.equal(raw.includes("name: 'ccb'"), false)
    }
  })

  it('DSH_HOME 未设时仍扫 ~/.dsh/profiles', () => {
    const home = mkdtempSync(join(tmpdir(), 'ccb-home-'))
    const root = join(home, '.dsh', 'profiles', 'dsh-tui', 'node_modules',
      '@deepseek-harness-tui', 'dsh-tui')
    mkdirSync(root, { recursive: true })
    const c = collectTuiRootCandidates({}, { home, argv1: join(home, 'noop.js'), cwd: home })
    assert.equal(c.includes(root), true)
  })

  it('启动参数带上 DeepSeek 的 cwd', () => {
    const args = buildLaunchArgs({
      id: 'ccb-1',
      cwd: 'D:\\project',
      stateDir: 'C:\\Users\\x\\.dsh\\cc-bridge',
    })
    assert.equal(args.includes('-MailboxId'), true)
    assert.equal(args[args.indexOf('-MailboxId') + 1], 'ccb-1')
    assert.equal(args[args.indexOf('-Cwd') + 1], 'D:\\project')
    assert.equal(args[args.indexOf('-StateDir') + 1], 'C:\\Users\\x\\.dsh\\cc-bridge')
  })

  it('Windows 开窗走 cmd /c start，避免 CREATE_NO_WINDOW 让 wt.exe 静默失败', () => {
    const spec = buildSpawnSpec({
      id: 'ccb-1',
      cwd: 'D:\\project',
      stateDir: 'C:\\Users\\x\\.dsh\\cc-bridge',
    })
    if (process.platform === 'win32') {
      assert.equal(spec.command, 'cmd.exe')
      assert.deepEqual(spec.args.slice(0, 3), ['/c', 'start', ''])
      assert.equal(spec.args.includes('-MailboxId'), true)
      const title = spec.args[spec.args.indexOf('-Title') + 1]
      assert.equal(title, 'ccb-1')
      assert.equal(title.includes(' '), false)
    } else {
      assert.equal(spec.args.includes('-MailboxId'), true)
    }
  })

  it('host 面把 /ccb 写进 commands.register，handler 开窗并记下 cwd', async () => {
    process.env.CCB_TEST_NO_SPAWN = '1'
    resetHostSurfaceForTests()
    const registered = []
    const commands = {
      register(def) {
        registered.push(def)
        return () => {}
      },
    }
    const ctx = {
      get(name) {
        if (name === 'commands') return commands
        return undefined
      },
      effect(fn) { return fn() },
    }
    const dir = mkdtempSync(join(tmpdir(), 'ccb-host-'))
    const r = await installHostSurface(ctx, { cwd: 'D:\\project' }, {
      stateDir: dir,
      log: () => {},
    })
    assert.equal(r.command, true)
    assert.equal(registered[0]?.name, 'ccb')
    const result = registered[0].handler({
      agent: { session: { header: { cwd: 'D:\\project' }, id: 'session-1' } },
      rawInput: ' 帮我搜索一个女仆娘设定',
    })
    assert.equal(result.kind, 'success')
    const boxes = listMailboxes(dir)
    assert.equal(boxes.length, 1)
    assert.equal(boxes[0].cwd, 'D:\\project')
    assert.equal(boxes[0].pending[0].text, '帮我搜索一个女仆娘设定')
    delete process.env.CCB_TEST_NO_SPAWN
  })
})

describe('mailbox', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccb-mailbox-'))

  it('坏 JSON 当空，只认带 id 的对象', () => {
    assert.equal(parseMailboxJson('null'), null)
    assert.equal(parseMailboxJson('[]'), null)
    assert.equal(parseMailboxJson('{'), null)
    assert.equal(parseMailboxJson('{"status":"idle"}'), null)
    assert.equal(parseMailboxJson('{"id":"ccb-1"}').id, 'ccb-1')
  })

  it('create → append → take 清空 pending，回合写回最近一条', () => {
    const box = createMailbox(dir, { id: 'ccb-test', cwd: 'D:\\proj', prompt: '先做这个' })
    assert.equal(box.status, 'starting')
    assert.equal(box.pending.length, 1)
    appendHostMessage(dir, 'ccb-test', '再补一句')
    const taken = takePending(dir, 'ccb-test')
    assert.equal(taken.length, 2)
    assert.deepEqual(taken.map((m) => m.text), ['先做这个', '再补一句'])
    assert.equal(readMailbox(dir, 'ccb-test').pending.length, 0)
    writeTurnResult(dir, 'ccb-test', { text: '好了', ok: true, claudeSid: 'uuid-1' })
    const after = readMailbox(dir, 'ccb-test')
    assert.equal(after.status, 'idle')
    assert.equal(after.claudeSid, 'uuid-1')
    assert.equal(latestTurn(after).text, '好了')
    setMailboxStatus(dir, 'ccb-test', 'running', { windowPid: 42 })
    assert.equal(readMailbox(dir, 'ccb-test').windowPid, 42)
    assert.equal(listMailboxes(dir)[0].id, 'ccb-test')
  })

  it('/clear 语义：takePending 丢掉 leftover，claudeSid 可清空', () => {
    createMailbox(dir, { id: 'ccb-clear', prompt: '旧任务' })
    appendHostMessage(dir, 'ccb-clear', '还没领')
    const leftover = takePending(dir, 'ccb-clear')
    assert.equal(leftover.length, 2)
    setMailboxStatus(dir, 'ccb-clear', 'idle', { claudeSid: null })
    assert.equal(readMailbox(dir, 'ccb-clear').claudeSid, null)
    assert.equal(readMailbox(dir, 'ccb-clear').pending.length, 0)
  })

  it('认领 / 改状态不冲掉还没领的 pending（复现 /ccb 开窗不干活）', () => {
    createMailbox(dir, { id: 'ccb-claim', prompt: '搜索今天天气' })
    setMailboxStatus(dir, 'ccb-claim', 'idle', { windowPid: 11, heartbeatAt: Date.now() })
    const afterClaim = readMailbox(dir, 'ccb-claim')
    assert.equal(afterClaim.pending[0].text, '搜索今天天气')
    assert.equal(afterClaim.windowPid, 11)
    writeTurnResult(dir, 'ccb-claim', { text: '好了', ok: true, claudeSid: 'sid-1' })
    assert.equal(readMailbox(dir, 'ccb-claim').pending[0].text, '搜索今天天气')
    const taken = takePending(dir, 'ccb-claim')
    assert.equal(taken.length, 1)
    appendHostMessage(dir, 'ccb-claim', '补一句')
    assert.equal(readMailbox(dir, 'ccb-claim').pending.length, 1)
  })

  it('领取后的 stale 状态写不会把已领走的任务写回去', () => {
    createMailbox(dir, { id: 'ccb-stale', prompt: '第一句' })
    const taken = takePending(dir, 'ccb-stale')
    assert.equal(taken.length, 1)
    setMailboxStatus(dir, 'ccb-stale', 'loading', { windowPid: 22 })
    assert.equal(readMailbox(dir, 'ccb-stale').pending.length, 0)
  })

  it('默认指挥对象跳过已死窗口', () => {
    const now = 1_000_000
    createMailbox(dir, { id: 'ccb-dead', prompt: '旧' })
    setMailboxStatus(dir, 'ccb-dead', 'idle', { windowPid: 999001, heartbeatAt: now - 60_000 })
    createMailbox(dir, { id: 'ccb-live', prompt: '新' })
    setMailboxStatus(dir, 'ccb-live', 'idle', { windowPid: 7, heartbeatAt: now })
    const boxes = listMailboxes(dir).filter((b) => b.id === 'ccb-dead' || b.id === 'ccb-live')
    const alive = (pid) => pid === 7
    const picked = pickDefaultMailbox(boxes, { now, alive })
    assert.equal(picked?.id, 'ccb-live')
    const dead = readMailbox(dir, 'ccb-dead')
    assert.equal(inspectMailbox(dead, { now, alive }).state, 'dead')
    assert.equal(mailboxAcceptsSend(dead, { now, alive }).ok, false)
    const live = readMailbox(dir, 'ccb-live')
    assert.equal(mailboxAcceptsSend(live, { now, alive: (pid) => pid === 7 }).ok, true)
    requestMailboxCancel(dir, 'ccb-live')
    assert.equal(typeof readMailbox(dir, 'ccb-live').cancelRequestedAt, 'number')
    const rendered = renderBox(live, { now, alive: (pid) => pid === 7 })
    assert.match(rendered, /活着/)
    const target = resolveHostTarget(dir, '', { now, alive: (pid) => pid === 7 })
    assert.equal(target.box?.id, 'ccb-live')
  })
})
