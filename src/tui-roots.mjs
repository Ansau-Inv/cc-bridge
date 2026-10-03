// dsh-tui 包的所有可能位置。
//
// 系统里同时存在多份 dsh-tui（npm 全局、各 profile 的 node_modules），
// 各自是不同模块实例。原地改上游对象时必须**每份都改**，
// 只打日常 `dsh-tui` 那份的话，`cc-bridge-tui` 窗口会继续画官方女仆。
//
// `--import` 预加载时 DSH_HOME / DSH_PROFILE_DIR 常常还没设
// （dsh bin 稍后才 resolveDshHome）。必须同时扫 `~/.dsh`。

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

export function collectTuiRootCandidates(env = process.env, {
  home = homedir(),
  argv1 = process.argv[1],
  cwd = process.cwd(),
} = {}) {
  const candidates = []
  if (env.APPDATA) {
    candidates.push(join(env.APPDATA, 'npm', 'node_modules',
      '@deepseek-harness-tui', 'dsh-tui'))
  }

  if (env.DSH_PROFILE_DIR) {
    candidates.push(join(env.DSH_PROFILE_DIR, 'node_modules',
      '@deepseek-harness-tui', 'dsh-tui'))
  }

  const homes = []
  if (typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim()) {
    homes.push(env.DSH_HOME.trim())
  }
  homes.push(join(home, '.dsh'))

  for (const dshHome of new Set(homes)) {
    const profiles = join(dshHome, 'profiles')
    if (!existsSync(profiles)) continue
    try {
      for (const name of readdirSync(profiles)) {
        candidates.push(join(profiles, name, 'node_modules',
          '@deepseek-harness-tui', 'dsh-tui'))
      }
    } catch { /* 列目录失败就只用下面的解析 */ }
  }

  try {
    const req = createRequire(argv1 || join(cwd, 'noop.js'))
    candidates.push(dirname(req.resolve('@deepseek-harness-tui/dsh-tui/package.json')))
  } catch { /* 当前进程没装 dsh-tui */ }

  return candidates
}

export function tuiPackageRoots() {
  return [...new Set(collectTuiRootCandidates())].filter((r) => existsSync(r))
}

/** 给某个 root 起个人能看懂的名字，用于日志。 */
export function tuiRootTag(root) {
  if (root.includes('dsh-tui-safe')) return 'dsh-tui-safe'
  if (root.includes('cc-bridge-tui')) return 'cc-bridge-tui'
  const appdata = process.env.APPDATA
  if (appdata && root.startsWith(appdata)) return 'npm 全局'
  const m = root.match(/profiles[\\/]([^\\/]+)[\\/]/)
  if (m) return `profile ${m[1]}`
  return 'dsh-tui'
}
