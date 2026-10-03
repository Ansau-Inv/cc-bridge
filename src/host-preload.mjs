/**
 * 日常 DeepSeek 窗口的预加载：只把 `/ccb` 写进 LOCAL_COMMANDS。
 *
 * 必须赶在 dsh-tui 建 Channel / `refreshCommands()` 之前。
 * `--import` 会等本模块（含 top-level await）跑完再加载入口。
 *
 * **不要**复用 window 那份 preload.mjs：那份会改 ctx 条颜色、藏开屏提示。
 * 日常窗口必须保持官方女仆和雾蓝。
 *
 * 两道闸：
 *   1. registerHooks —— 改**即将加载**的 commands.js 源码（含 npx 缓存那份）
 *   2. 运行时 push —— 改已经在模块缓存里的 LOCAL_COMMANDS
 *
 * 日志写 bridge.log，不写 stderr（否则开屏会闪几行）。
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  installHostSlashIntercept, installHostSlashLoadHook,
} from './host-slash.mjs'
import { resolveStateDir } from './mode.mjs'

const dir = resolveStateDir()
try { mkdirSync(dir, { recursive: true }) } catch { /* 下面写日志再兜底 */ }

const log = (...args) => {
  try {
    appendFileSync(join(dir, 'bridge.log'), `[cc-bridge] ${args.join(' ')}\n`)
  } catch { /* 预加载失败不能把宿主打崩 */ }
}

installHostSlashLoadHook(log)
await installHostSlashIntercept(log)
