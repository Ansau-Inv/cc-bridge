// 通过 dsh-TUI 的注入管道发消息。
//
// 为什么不用合成键盘（tools/type.py）：
//   · KEYEVENTF_UNICODE 对 Windows Terminal **完全无效** —— 实测收到的是
//     ` } J \x1f H 这种乱码，不是原字符。
//   · VkKeyScanW 只能处理当前代码页里有 VK 的字符，中文直接没戏。
//   · 还得先抢前台焦点，抢不到就静默丢输入（"已输入 41 个字符"但界面空白）。
//
// dsh-TUI 自己提供了注入通道，专为编辑器集成设计：
//   Windows: 命名管道 \\.\pipe\dsh-tui-inject-<sessionId>
//   协议:    换行分隔的 JSON
//     { "type": "prompt.append",    "text": "..." }               ← 追加到输入框
//     { "type": "command.execute",  "command": "prompt.submit" }  ← 提交
//
// 用法:
//   node inject.mjs <sessionId> <text>             只追加，不提交
//   node inject.mjs <sessionId> <text> --submit    追加并提交（**一次调用完成**）
//   node inject.mjs --list                         列出活跃会话
//
// 踩坑：别把「追加」和「提交」拆成两次调用。
// 拆开时实战出现过排队面板里出现重复条目 —— 因为两次连接之间 TUI 可能
// 已经处理过一轮，状态不一致。一次连接里发两行最稳。
//
// 另外注意 prompt.append 的文本**没有**自动加尾随空格 —— 是否提交完全
// 由有没有跟着 `prompt.submit` 决定。

import { connect } from 'node:net'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DATA_DIR = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh-tui')
const SERVERS_FILE = join(DATA_DIR, 'inject', 'servers.json')

function listServers() {
  try {
    const raw = JSON.parse(readFileSync(SERVERS_FILE, 'utf8'))
    return Array.isArray(raw) ? raw : (raw.servers ?? [])
  } catch { return [] }
}

const args = process.argv.slice(2)

if (args[0] === '--list' || args.length === 0) {
  const servers = listServers()
  if (servers.length === 0) {
    console.log('没有活跃的 dsh-TUI 会话')
  } else {
    for (const s of servers) console.log(`  ${s.sessionId}  cwd=${s.cwd}  pid=${s.pid}`)
  }
  process.exit(0)
}

const sessionId = args[0]
const submit = args.includes('--submit')
// --submit 是开关，不是文本的一部分，要排掉
const text = args.slice(1).filter((a) => a !== '--submit').join(' ')

const pipePath = `\\\\.\\pipe\\dsh-tui-inject-${sessionId}`

const sock = connect(pipePath)
let done = false

const finish = (code, msg) => {
  if (done) return
  done = true
  if (msg) console.log(msg)
  try { sock.destroy() } catch { /* ignore */ }
  process.exit(code)
}

sock.on('connect', () => {
  const lines = []
  if (text) lines.push(JSON.stringify({ type: 'prompt.append', text }))
  if (submit) lines.push(JSON.stringify({ type: 'command.execute', command: 'prompt.submit' }))

  sock.write(lines.join('\n') + '\n', 'utf8')
  console.log(`已发送 ${lines.length} 条消息到 ${sessionId}${submit ? '（含提交）' : ''}`)
  // 给服务端一点时间处理再断开 —— 立刻 destroy 可能让消息来不及读完
  setTimeout(() => finish(0), 500)
})

sock.on('error', (err) => {
  finish(1, `连接失败: ${err.message}\n提示: 用 --list 看活跃会话`)
})

setTimeout(() => finish(1, '超时：管道无响应'), 5000)
