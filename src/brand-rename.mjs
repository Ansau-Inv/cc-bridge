// 把 dsh-TUI 界面里的品牌名换掉：`DeepSeek` → `Claude`，`鲸鱼娘` → `Claude娘`。
//
// ════════════════════════════════════════════════════════════════════
// 为什么能做：i18n 字典是可变对象
// ════════════════════════════════════════════════════════════════════
//
// 文案都在 `lib/types/i18n.js` 的字典里：
//
//     const dict = {
//       'interrupted-ask-next': { zh: '· 接下来想让 DeepSeek 做什么？', en: '...' },
//     }
//     export const i18nDict = dict;     // ← 导出的是同一个对象引用
//
// `t()` 内部读 `dict`，而 `i18nDict` 导出的是**同一个对象** —— 所以原地改
// 条目属性就能生效（`welcome-tagline.mjs` 已实测确认这条路）。
//
// ════════════════════════════════════════════════════════════════════
// 只改**展示文案**，不碰标识符
// ════════════════════════════════════════════════════════════════════
//
// 这是本模块最重要的约束。i18n 字典里有 32 处 `DeepSeek`，但**不能全改**：
//
//   该改（纯展示，说错了会误导）：
//     · 'interrupted-ask-next'   「接下来想让 DeepSeek 做什么？」
//     · 'logo-star-*'            「鲸鱼娘…」
//
//   **明确不能改**（这些功能真的属于 DeepSeek 账户体系）：
//     · `/balance` 一整套      —— 查的是 **DeepSeek 平台**的余额，
//                                  改成「Claude 余额」会让人以为在查 Anthropic
//     · `/login`、`/logout`    —— DeepSeek 凭据
//     · `doctor-key-missing`   —— 提到 `DEEPSEEK_API_KEY` 这个真实环境变量
//     · `model-usage`          —— 例子是 `deepseek/deepseek-flash` 这个真实路由
//     · `doctor-route-hint`    —— 提到 `llm-deepseek` 这个真实配置段名
//
// 所以策略是**跳过列表 + 标识符检测**双保险：
//   ① `SKIP_KEYS` 精确列出不该动的词条
//   ② `isReplaceable()` 再挡一道（环境变量名、provider id、反引号代码）
//
// 宁可少改，也不要改出错误信息。
//
// ════════════════════════════════════════════════════════════════════
// 「鲸鱼娘」→「Claude娘」
// ════════════════════════════════════════════════════════════════════
//
// 只有 4 条（星标提示相关），都是纯展示，全改。

/** 展示文案里要替换的词。顺序有意义（长的先替换，避免部分匹配）。 */
const WORD_MAP = [
  ['DeepSeek', 'Claude'],
  ['鲸鱼娘', 'Claude娘'],
  ['whale girl', 'Claude girl'],   // 英文对应
]

/**
 * **不该替换**的词条名（前缀匹配）。
 *
 * 这些都是"功能确实属于 DeepSeek 账户体系"的文案 —— 改成 Claude 会让
 * 用户以为在操作 Anthropic 的账户，比不改更糟。
 *
 * ⚠️ 这里踩过两个坑，都是**前缀写窄了**：
 *   · `balance-` 匹配不到 `cmd-desc-balance`（前缀不是 balance-）
 *     —— 那是「查看 DeepSeek 账户余额」，漏网后会被改成「查看 Claude 账户余额」
 *   · `coupon-modal-received`（「DeepSeek 送你的 … 鲸鱼券到账啦」）
 *     也没被任何前缀覆盖 —— 鲸鱼券确实是 DeepSeek 发的
 * 所以改词条名时要**对着 grep 结果逐个核**，别凭印象写前缀。
 */
const SKIP_PREFIXES = [
  'balance-',        // /balance 系列：查 DeepSeek 平台余额
  'cmd-desc-balance', // /balance 的命令说明（前缀不是 balance-，单独列）
  'coupon-',         // 鲸鱼券：DeepSeek 发的优惠券
  'login-',          // /login：DeepSeek 凭据状态
  'logout-',         // /logout
  'doctor-',         // /doctor：环境检查，会点名 DEEPSEEK_API_KEY
  'model-usage',     // 例子是 deepseek/deepseek-flash 这个真实路由
  'cost-note',       // 「以 DeepSeek 平台为准」—— 账单确实在那边
  'update-',         // 提到 `@deepseek-harness-tui/dsh-tui` 这个真实包名
]

/** 该词条是否在跳过列表里。 */
function isSkipped(key) {
  return SKIP_PREFIXES.some((p) => key.startsWith(p))
}

/**
 * 判断某个字符串**是否该替换**。
 *
 * 跳过含下列内容的值 —— 那些指向真实的环境变量、provider id、配置段名，
 * 改了会让人以为要写 `CLAUDE_API_KEY`，反而误导。
 */
function isReplaceable(value) {
  if (typeof value !== 'string' || value === '') return false
  // 环境变量名、代码样式、provider/model 标识符
  if (/DEEPSEEK_[A-Z_]+/.test(value)) return false
  if (/deepseek\/|llm-deepseek|deepseek-official/i.test(value)) return false
  if (value.includes('`')) return false
  return true
}

/** 替换文本里的词。 */
function rewrite(text) {
  let out = text
  for (const [from, to] of WORD_MAP) {
    if (out.includes(from)) out = out.split(from).join(to)
  }
  return out
}

/**
 * 装上品牌名替换。
 *
 * 幂等：重复调用不会二次替换（`Claude` 里不含 `DeepSeek`）。
 *
 * @param log 日志函数
 * @returns `{ ok, patched, entries, skipped }`
 */
export async function installBrandRename(log = () => {}) {
  const { existsSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const { tuiPackageRoots } = await import('./tui-roots.mjs')

  let patched = 0
  let entries = 0
  let skipped = 0
  const problems = []

  for (const root of tuiPackageRoots()) {
    const i18nPath = join(root, 'lib', 'types', 'i18n.js')
    if (!existsSync(i18nPath)) continue
    try {
      const i18n = await import(pathToFileURL(i18nPath).href)
      const dict = i18n.i18nDict
      if (!dict || typeof dict !== 'object') {
        problems.push('没导出 i18nDict')
        continue
      }
      for (const [key, entry] of Object.entries(dict)) {
        if (!entry || typeof entry !== 'object') continue
        if (isSkipped(key)) { skipped++; continue }
        for (const lang of ['zh', 'en']) {
          const cur = entry[lang]
          if (!isReplaceable(cur)) continue
          const next = rewrite(cur)
          if (next === cur) continue

          // 逐条记日志太吵；只累计条数，末尾汇总。
          entry[lang] = next
          entries++
        }
      }
      patched++
    } catch (err) {
      problems.push(String(err?.message ?? err))
    }

    // ── 设置项的文案也要改 ──────────────────────────────────────────
    //
    // `/settings` 里那些 label / hint 是**另一份硬编码文案**，不在 i18n
    // 字典里。例如 `whaleIdle` 的：
    //
    //     descriptions:    { zh: '鲸鱼娘闲置动画（欢迎期）' }
    //     hintDescriptions:{ zh: '欢迎期闲置行为：开屏后鲸鱼娘摆鱼鳍…' }
    //
    // 不处理的话，`/settings` 里仍会写「鲸鱼娘」。
    //
    // 结构是 `definitions` 对象，每项可能有 `label` / `description` /
    // `hint` / `descriptions` / `hintDescriptions`。递归处理所有字符串值 ——
    // 这个文件里的文案都是面向用户的，不像 i18n 那样混着标识符
    // （所以这里可以宽一点；`isReplaceable` 仍会挡住含反引号/环境变量的）。
    const defsPath = join(root, 'lib', 'types', 'settings', 'definitions.js')
    if (existsSync(defsPath)) {
      try {
        const defsMod = await import(pathToFileURL(defsPath).href)
        // 实测导出名是 `SETTING_DEFINITIONS`；另外几个是防上游改名的兜底。
        const buckets = [
          defsMod.SETTING_DEFINITIONS,
          defsMod.definitions,
          defsMod.SETTING_GROUPS,      // 分组标题也可能带品牌词
        ].filter((x) => x && typeof x === 'object')
        let defsEntries = 0
        const walk = (node, depth) => {
          if (depth > 6 || node === null || typeof node !== 'object') return
          for (const [k, v] of Object.entries(node)) {
            if (typeof v === 'string') {
              if (!isReplaceable(v)) continue
              const next = rewrite(v)
              if (next !== v) { node[k] = next; defsEntries++ }
            } else if (v && typeof v === 'object') {
              walk(v, depth + 1)
            }
          }
        }
        for (const b of buckets) walk(b, 0)
        if (defsEntries > 0) entries += defsEntries
      } catch (err) {
        problems.push('settings/definitions: ' + String(err?.message ?? err))
      }
    }
  }

  if (problems.length > 0) log('  品牌名替换有问题：' + problems.join(' | '))
  if (patched > 0) {
    log(`  品牌名已替换：${entries} 条文案（${patched} 份 dsh-tui）` +
      `  DeepSeek→Claude · 鲸鱼娘→Claude娘` +
      (skipped > 0 ? `；跳过 ${skipped} 条（账户/环境变量相关，改了会误导）` : ''))
    return { ok: true, patched, entries, skipped }
  }
  return { ok: false, reason: problems[0] ?? '没找到 i18n 字典' }
}
