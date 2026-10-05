/* 拍门检修领域规则的自动化验证：node 下用 localStorage 垫片跑，esbuild 打包后由 node 执行。
 * 覆盖需求：持久化、同泵站重号拦截、待检修→正常时间戳、换泵站历史留档、
 *           与泵组运行冲突以检修记录为准、待更换台账、重复提交只收先到一版。 */

const mem = new Map<string, string>()
const localStorageMock = {
  getItem: (k: string) => (mem.has(k) ? (mem.get(k) as string) : null),
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
}
;(globalThis as any).window = { localStorage: localStorageMock }
;(globalThis as any).localStorage = localStorageMock

import assert from 'node:assert'
import {
  createSluiceEntry,
  isFrozen,
  listSluiceEntries,
  reconcileLedger,
  runSluiceAction,
  updateSluiceEntry,
} from '@/api/sluice-service'
import { listRows, __resetCacheForTest, __clearStorageForTest } from '@/data/local-store'

let passed = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    console.error(`  ✗ ${name}`)
    console.error(error)
    process.exitCode = 1
  }
}

function fresh() {
  __clearStorageForTest()
}

function getSluice(id: number) {
  return listRows('sluice').find((r) => Number(r.id) === id)!
}
function openLedgerFor(gateId: number) {
  return listRows('pumprun').filter(
    (r) => String(r.台账类型) === '拍门待更换台账'
      && String(r.台账状态) === '待更换'
      && Number(r.来源检修ID) === gateId,
  )
}
function allLedgerFor(gateId: number) {
  return listRows('pumprun').filter(
    (r) => String(r.台账类型) === '拍门待更换台账' && Number(r.来源检修ID) === gateId,
  )
}

// 1) 密封状况改 → 拍门状态联动；刷新/重进仍是改后的值
check('密封状况改过后刷新（清内存重读 localStorage）仍是改后的值，且拍门状态联动', () => {
  fresh()
  // seed id=2：检修中 / 轻微渗漏 → 改成密封失效，联动为需更换
  const res = updateSluiceEntry(2, {
    所属泵站: '阳光立交泵站',
    拍门编号: 'SLUI-0002',
    密封状况: '密封失效',
    检修方式: '整体更换',
    检修人: '孙立军',
    检修日期: '2026-09-04',
  }, 1)
  assert.equal(res.ok, true, res.message)
  assert.equal(getSluice(2).status, '需更换')
  assert.equal(getSluice(2).拍门状态, '需更换')

  // 模拟刷新：丢掉内存缓存，强制从 localStorage 重新读
  __resetCacheForTest()
  const afterReload = listSluiceEntries().find((r) => Number(r.id) === 2)!
  assert.equal(afterReload.密封状况, '密封失效')
  assert.equal(afterReload.status, '需更换')
  assert.equal(afterReload.拍门状态, '需更换')
})

// 2) 同一泵站拍门编号不能重号；撞号要指出跟谁撞了
check('同泵站重号提交被挡下，并指出撞号的检修编号', () => {
  fresh()
  const res = createSluiceEntry({
    所属泵站: '阳光立交泵站',
    拍门编号: 'SLUI-0001',
    密封状况: '密封良好',
  })
  assert.equal(res.ok, false)
  assert.match(res.message, /SLUI-0001/)
  assert.match(res.message, /撞号/)
})
check('不同泵站允许相同拍门编号', () => {
  fresh()
  const res = createSluiceEntry({
    所属泵站: '滨河东路泵站',
    拍门编号: 'SLUI-0001',
    密封状况: '密封良好',
  })
  assert.equal(res.ok, true, res.message)
})

// 3) 待检修 → 状态正常留时间戳
check('新建后判定正常：待检修时间与状态正常时间都有戳', () => {
  fresh()
  const created = createSluiceEntry({
    所属泵站: '测试泵站',
    拍门编号: 'TG-1001',
    密封状况: '轻微渗漏',
    检修日期: '2026-10-05',
  })
  assert.equal(created.ok, true)
  const id = Number(listRows('sluice').at(-1)!.id)
  const before = getSluice(id)
  const startedAt = String(before.待检修时间)
  assert.ok(startedAt.length > 0, '待检修时间应有值')
  assert.equal(before.状态正常时间, '')

  const normal = runSluiceAction(id, '提交检修')
  assert.equal(normal.ok, true)
  const ok = runSluiceAction(id, '判定正常')
  assert.equal(ok.ok, true)
  const row = getSluice(id)
  assert.equal(row.status, '状态正常')
  assert.ok(String(row.状态正常时间).length > 0, '状态正常时间应被记录')
  assert.equal(row.待检修时间, startedAt, '待检修时间应保留建档时的戳')
})
check('密封状况改为密封良好同样补上状态正常时间戳', () => {
  fresh()
  // seed id=2 检修中 → 编辑密封良好
  const res = updateSluiceEntry(2, {
    所属泵站: '阳光立交泵站',
    拍门编号: 'SLUI-0002',
    密封状况: '密封良好',
  }, 1)
  assert.equal(res.ok, true)
  assert.equal(getSluice(2).status, '状态正常')
  assert.ok(String(getSluice(2).状态正常时间).length > 0)
})

// 4) 换所属泵站：原编号与记录留原泵站历史，不跟着搬
check('换泵站后老记录留原泵站历史（编号不变、标记转出），新泵站生成新编号新记录', () => {
  fresh()
  const old = getSluice(1)
  const oldCode = old.检修编号
  const res = updateSluiceEntry(1, {
    所属泵站: '滨河东路泵站',
    拍门编号: 'SLUI-0001',
    密封状况: '密封良好',
  }, 3)
  assert.equal(res.ok, true, res.message)

  const oldRecord = getSluice(1)
  assert.equal(oldRecord.检修编号, oldCode, '老编号保持不变')
  assert.equal(oldRecord.所属泵站, '阳光立交泵站', '老记录仍挂原泵站')
  assert.equal(isFrozen(oldRecord), true, '老记录应标记转出留档')

  const moved = listRows('sluice').find((r) => r.转出来源 === '阳光立交泵站')!
  assert.ok(moved, '应生成转入新泵站的新记录')
  assert.equal(moved.所属泵站, '滨河东路泵站')
  assert.notEqual(moved.检修编号, oldCode)
  assert.equal(moved.status, '待检修')
  assert.equal(isFrozen(moved), false)
})
check('转出留档的老记录不能再被编辑或流转', () => {
  fresh()
  updateSluiceEntry(1, {
    所属泵站: '滨河东路泵站',
    拍门编号: 'SLUI-0001',
    密封状况: '密封良好',
  }, 3)
  const edit = updateSluiceEntry(1, {
    所属泵站: '阳光立交泵站',
    拍门编号: 'SLUI-0001',
    密封状况: '轻微渗漏',
  })
  assert.equal(edit.ok, false)
  const act = runSluiceAction(1, '提出更换')
  assert.equal(act.ok, false)
})

// 5) 拍门状态与泵组运行对不上：以检修记录为准（对账纠偏台账）
check('泵组运行台账若错误地没有待更换条目，对账后按检修记录补上', () => {
  fresh()
  // seed id=3 为需更换，且 seed 台账已有一条 PM-0004，应只保留一条
  reconcileLedger()
  const opens = openLedgerFor(3)
  assert.equal(opens.length, 1)
  assert.equal(opens[0].所属泵站, '滨河东路泵站')
  assert.equal(opens[0].拍门编号, 'SLUI-0003')
})
check('台账里挂着待更换但检修记录已正常 → 对账关闭，以检修记录为准', () => {
  fresh()
  assert.equal(openLedgerFor(3).length, 1)
  // 需更换 → 判定正常（允许需更换回正常：检修后恢复）
  const res = runSluiceAction(3, '判定正常', 2)
  assert.equal(res.ok, true, res.message)
  assert.equal(getSluice(3).status, '状态正常')
  const open = openLedgerFor(3)
  assert.equal(open.length, 0, '待更换台账应关闭')
  const closed = allLedgerFor(3).filter((r) => String(r.台账状态) === '已关闭')
  assert.equal(closed.length, 1)
  assert.ok(String(closed[0].关闭时间).length > 0)
})

// 6) 状态改为需更换 → 落入泵组运行待更换台账（重复对账不重复落账）
check('判定需更换后泵组运行出现待更换台账；重复对账不产生重复条目', () => {
  fresh()
  // id=1 seed 为状态正常 → 反向不允许，因此用新建走流程
  const created = createSluiceEntry({
    所属泵站: '阳光立交泵站',
    拍门编号: 'TG-2002',
    密封状况: '轻微渗漏',
  })
  assert.equal(created.ok, true)
  const id = Number(listRows('sluice').at(-1)!.id)
  runSluiceAction(id, '提交检修', 1)
  const replace = runSluiceAction(id, '提出更换', 2)
  assert.equal(replace.ok, true, replace.message)
  reconcileLedger()
  reconcileLedger()
  const opens = openLedgerFor(id)
  assert.equal(opens.length, 1)
  assert.equal(opens[0].台账类型, '拍门待更换台账')
  assert.equal(opens[0].运行状态, '待更换')
  assert.equal(opens[0].检修编号, getSluice(id).检修编号)
})

// 7) 同一台拍门重复提交改动：只接受先到一版（版本乐观锁）
check('拿着旧版本的重复编辑被挡下，先到的一版保留', () => {
  fresh()
  const first = updateSluiceEntry(2, {
    所属泵站: '阳光立交泵站',
    拍门编号: 'SLUI-0002',
    密封状况: '密封失效',
  }, 1)
  assert.equal(first.ok, true, first.message)
  const stale = updateSluiceEntry(2, {
    所属泵站: '阳光立交泵站',
    拍门编号: 'SLUI-0002',
    密封状况: '密封良好',
  }, 1) // 仍是打开表单时的旧 version
  assert.equal(stale.ok, false)
  assert.match(stale.message, /先到/)
  // 先到的一版仍在
  assert.equal(getSluice(2).密封状况, '密封失效')
  assert.equal(getSluice(2).status, '需更换')
  // 刷新后带着新版本可以正常继续改
  __resetCacheForTest()
  const v = Number(getSluice(2).version)
  const again = updateSluiceEntry(2, {
    所属泵站: '阳光立交泵站',
    拍门编号: 'SLUI-0002',
    密封状况: '密封良好',
  }, v)
  assert.equal(again.ok, true, again.message)
  assert.equal(getSluice(2).status, '状态正常')
})
check('拿着旧版本的重复状态操作被挡下', () => {
  fresh()
  createSluiceEntry({ 所属泵站: '阳光立交泵站', 拍门编号: 'TG-3003', 密封状况: '轻微渗漏' })
  const id = Number(listRows('sluice').at(-1)!.id)
  assert.equal(runSluiceAction(id, '提交检修', 1).ok, true)
  const stale = runSluiceAction(id, '判定正常', 1) // 旧版本
  assert.equal(stale.ok, false)
  assert.equal(getSluice(id).status, '检修中')
})
check('同一状态重复操作直接挡下（幂等）', () => {
  fresh()
  const res = runSluiceAction(1, '判定正常', 3) // seed id=1 已是状态正常
  assert.equal(res.ok, false)
  assert.match(res.message, /重复|已经是/)
})

// 8) 端到端：动作 + 刷新后台账仍在；关闭后刷新仍关闭
check('端到端持久化：需更换台账刷新后仍在，恢复正常关闭后刷新仍关闭', () => {
  fresh()
  // id=2 检修中 → 提出更换
  const r = runSluiceAction(2, '提出更换', 1)
  assert.equal(r.ok, true, r.message)
  __resetCacheForTest()
  assert.equal(openLedgerFor(2).length, 1)
  const v = Number(getSluice(2).version)
  const back = runSluiceAction(2, '判定正常', v)
  assert.equal(back.ok, true, back.message)
  __resetCacheForTest()
  assert.equal(openLedgerFor(2).length, 0)
  assert.equal(getSluice(2).status, '状态正常')
})

console.log(`\n${passed} 项检查通过`)
