#!/usr/bin/env node
/**
 * dsh-quality-gauge 构建后自检（防再发护栏，见 src/index.ts assertSchemaParse 注释）。
 * 用法：npm run build && npm run selftest（注入前跑）。
 * 检查项：
 *   1. 编译产物不引用 schemastery（可调用式 schema 无 .parse，曾致会话恢复崩溃）
 *   2. 导出的 Config 是带 .parse 的 zod schema 且能正常解析
 * 失败时非零退出，禁止注入。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const libPath = join(root, 'lib', 'index.js')
const lib = readFileSync(libPath, 'utf8')
const failures = []

// 1. schemastery 残留检查
if (/from\s*['"]schemastery['"]/.test(lib) || /require\(['"]schemastery['"]\)/.test(lib)) {
  failures.push('lib/index.js 仍引用 schemastery（必须用 zod，schemastery schema 无 .parse）')
}

// 2. Config.parse 检查
try {
  const { name, Config } = await import(libPath)
  if (typeof Config?.parse !== 'function') {
    failures.push(`Config.parse 不是函数（typeof=${typeof Config?.parse}）——投影 schema 必须有 .parse`)
  } else {
    const v = Config.parse({})
    if (typeof v !== 'object' || v === null) failures.push('Config.parse({}) 结果异常')
    else console.log(`selftest OK: ${name} Config.parse 正常（judgeSamples=${v.judgeSamples}）`)
  }
} catch (e) {
  failures.push(`import lib 失败: ${e instanceof Error ? e.message : String(e)}`)
}

if (failures.length > 0) {
  console.error('selftest FAILED:')
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log('selftest PASSED — 可以注入')
