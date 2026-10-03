/**
 * 双进程抢写信箱：复现 Windows 上认领 / 领取 / append 同时改同一个 json。
 * 旧实现 rename 失败会删目标文件，/ccb 任务就此消失。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createMailbox, readMailbox, writeTurnResult,
} from '../src/mailbox.mjs'

const root = dirname(fileURLToPath(new URL('.', import.meta.url)))
const dir = mkdtempSync(join(tmpdir(), 'ccb-race-'))
const id = 'ccb-race'
const mailboxUrl = new URL('../src/mailbox.mjs', import.meta.url).href

createMailbox(dir, { id, prompt: '搜索今天天气' })

function child(kind) {
  const src = [
    `import { appendHostMessage, setMailboxStatus, takePending } from ${JSON.stringify(mailboxUrl)}`,
    'const dir = process.env.CCB_RACE_DIR',
    'const id = process.env.CCB_RACE_ID',
    'const kind = process.env.CCB_RACE_KIND',
    "if (kind === 'claim') {",
    '  for (let i = 0; i < 20; i++) {',
    "    setMailboxStatus(dir, id, i % 2 ? 'loading' : 'idle', { windowPid: 100 + i, heartbeatAt: Date.now() })",
    '  }',
    "} else if (kind === 'append') {",
    '  for (let i = 0; i < 8; i++) appendHostMessage(dir, id, "补" + i)',
    '} else {',
    '  let n = 0',
    '  for (let i = 0; i < 8; i++) n += takePending(dir, id).length',
    '  process.stdout.write(String(n))',
    '}',
  ].join('\n')
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', src], {
      env: { ...process.env, CCB_RACE_DIR: dir, CCB_RACE_ID: id, CCB_RACE_KIND: kind },
      cwd: root,
      windowsHide: true,
    })
    let out = ''
    let err = ''
    p.stdout.on('data', (c) => { out += c })
    p.stderr.on('data', (c) => { err += c })
    p.on('error', reject)
    p.on('close', (code) => {
      if (code !== 0) reject(new Error(`${kind} exit ${code}: ${err || out}`))
      else resolve(out)
    })
  })
}

try {
  const [takenText] = await Promise.all([
    child('take'),
    child('claim'),
    child('append'),
  ])
  const leftover = readMailbox(dir, id)
  writeTurnResult(dir, id, { text: 'x', ok: true })
  const afterTurn = readMailbox(dir, id)
  const taken = Number(takenText || '0')
  const left = leftover?.pending?.length ?? -1
  const total = taken + left
  if (!leftover) throw new Error('信箱文件丢了')
  if (total < 9) throw new Error(`丢消息了 taken=${taken} left=${left} 期望至少 9`)
  if (afterTurn.pending.length !== left) {
    throw new Error(`回合回写冲掉了 pending ${afterTurn.pending.length} vs ${left}`)
  }
  console.log(`race ok taken=${taken} leftover=${left} total=${total}`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
