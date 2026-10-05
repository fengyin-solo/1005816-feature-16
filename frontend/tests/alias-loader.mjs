// 测试运行用：把源码里的 '@/...' 别名解析到 tsc 产物目录，浏览器环境无需此垫片。
import { pathToFileURL, fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'

function resolveTs(pathWithoutExt) {
  if (existsSync(pathWithoutExt)) return pathWithoutExt
  if (existsSync(`${pathWithoutExt}.js`)) return `${pathWithoutExt}.js`
  if (existsSync(`${pathWithoutExt}.ts`)) return `${pathWithoutExt}.ts`
  const index = resolvePath(pathWithoutExt, 'index.js')
  if (existsSync(index)) return index
  const indexTs = resolvePath(pathWithoutExt, 'index.ts')
  if (existsSync(indexTs)) return indexTs
  return pathWithoutExt
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const target = resolveTs(resolvePath(process.cwd(), '.tmp-test/src', specifier.slice(2)))
    return { url: pathToFileURL(target).href, shortCircuit: true }
  }
  // 编译产物之间的无扩展名相对导入（tsc 不会改写说明符）。
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL) {
    const base = new URL(specifier, context.parentURL)
    const target = resolveTs(fileURLToPath(base))
    return { url: pathToFileURL(target).href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
