import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (name) => readFileSync(join(root, name), 'utf8')

function topLevelIds(text) {
  return [...text.matchAll(/^- id:\s*(\S+)\s*$/gm)].map((m) => m[1])
}

function hasTopInsert(text) {
  return /^- insert:\s*$/m.test(text)
}

describe('host.patch.yml', () => {
  const text = read('host.patch.yml')

  it('只 insert cc-bridge，不禁 agent-loop，不写死 mode', () => {
    assert.equal(hasTopInsert(text), true)
    assert.equal(text.includes('id: cc-bridge'), true)
    assert.equal(/^- id: agent-loop\s*$/m.test(text), false)
    assert.equal(/^\s+disabled:\s*true\s*$/m.test(text), false)
    assert.equal(/^\s+mode:\s*host\s*$/m.test(text), false)
    assert.equal(/provider:\s*claude-code/.test(text), false)
    assert.equal(text.includes("inject: [agents, sessions, subagents, attachments]"), true)
  })
})

describe('cordis.patch.yml 窗口 overlay', () => {
  const text = read('cordis.patch.yml')

  it('不 insert，覆盖 agent-loop / dsh-tui / cc-bridge', () => {
    assert.equal(hasTopInsert(text), false)
    assert.deepEqual(topLevelIds(text), ['agent-loop', 'dsh-tui', 'cc-bridge'])
    assert.equal(/disabled:\s*true/.test(text), true)
    assert.equal(/mode:\s*(host|window|takeover)/.test(text), false)
  })

  it('覆盖 cc-bridge 时不写 name（避免 file URL 断言失败）', () => {
    const start = text.indexOf('- id: cc-bridge')
    assert.ok(start >= 0)
    const rest = text.slice(start)
    const next = rest.search(/\n- id:/)
    const seg = next >= 0 ? rest.slice(0, next) : rest
    assert.equal(/^\s*name:/m.test(seg), false)
    assert.equal(seg.includes('maidArt:'), true)
  })
})

describe('probe-core-only.yml', () => {
  const text = read('probe-core-only.yml')

  it('覆盖层：禁 loop、takeover、关外观，不 insert', () => {
    assert.equal(hasTopInsert(text), false)
    assert.deepEqual(topLevelIds(text), ['agent-loop', 'cc-bridge'])
    assert.equal(/mode:\s*takeover/.test(text), true)
    assert.equal(/appearance:\s*false/.test(text), true)
  })
})

describe('package.json 组合包', () => {
  const pkg = JSON.parse(read('package.json'))

  it('日常 plugin add 走 host 插入', () => {
    assert.equal(pkg.dsh.bundle.patch, './host.patch.yml')
    assert.equal(pkg.icon, './icon.svg')
    assert.equal(pkg.exports['./locale/*.json'], './locale/*.json')
  })
})

describe('locale', () => {
  it('en/zh 都有 meta.title 和 description', () => {
    for (const file of ['locale/en.json', 'locale/zh.json']) {
      const j = JSON.parse(read(file))
      assert.equal(typeof j.meta.title, 'string')
      assert.ok(j.meta.title.length > 0)
      assert.equal(typeof j.meta.description, 'string')
      assert.ok(j.meta.description.includes('/ccb'))
    }
  })
})

describe('公开文件不带本机痕迹', () => {
  const skipDir = new Set(['node_modules', '.git', '.tmp', '.tmp-plugin-test', '.cc-bridge'])
  // 本文件的黑名单字面量会自命中，不扫。
  const skipFile = new Set(['patches.test.mjs'])
  const textExt = /\.(mjs|js|cjs|json|yml|yaml|md|ps1|svg|txt|html)$/i

  function listPublicFiles() {
    const out = []
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        if (name.startsWith('.tmp')) continue
        if (skipDir.has(name)) continue
        const abs = join(dir, name)
        const st = statSync(abs)
        if (st.isDirectory()) {
          walk(abs)
          continue
        }
        if (skipFile.has(name) || !textExt.test(name)) continue
        out.push(relative(root, abs).replaceAll('\\', '/'))
      }
    }
    walk(root)
    return out
  }

  const banned = [
    /F:\\dsh\\/i,
    /F:\/dsh\//i,
    /F:\\claude_code/i,
    /F:\/claude_code/i,
    /C:\\Users\\安/,
    /Users\/安/,
    /bot-grok-4\.6/i,
    /76a16b0a-ba3b-4bd5-be0f/,
    /session-2e9fecea/,
    /f5c12997/,
    /7816c3e1/,
    /290f93a4/,
    /a7924fc6/,
    /d81f4c8c69b7/,
    /4c153aa25f99/,
    /tools=352/,
    /mcp=4 skills=21/,
    /2\.1\.284/,
    /Search Elixir/,
    /Search Gleam/,
    /sk-ant-/,
    /sk-or-/,
    /ghp_[A-Za-z0-9]/,
    /github_pat_/,
    /ANTHROPIC_API_KEY\s*=\s*\S+/,
    /DEEPSEEK_API_KEY\s*=\s*\S+/,
  ]

  it('源码 / 文档 / 脚本不含本机路径、会话残片或密钥', () => {
    const files = listPublicFiles()
    assert.ok(files.includes('README.md'))
    assert.ok(files.includes('src/index.mjs'))
    const hits = []
    for (const file of files) {
      const text = read(file)
      for (const re of banned) {
        if (re.test(text)) hits.push(`${file} 命中 ${re}`)
      }
    }
    assert.deepEqual(hits, [])
  })
})
