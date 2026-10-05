import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 拍门检修的领域规则集中在这一层，页面只管取数与渲染：
// 1) 所有改动统一经这里写入 localStorage，刷新/重进仍是改后的值；
// 2) 同一泵站下拍门编号不得重号，撞号拦下并指出撞了谁；
// 3) 待检修 -> 状态正常留存时间戳；
// 4) 更换所属泵站时老记录（检修编号、记录内容）留在原泵站做历史，不跟着搬；
// 5) 拍门状态与泵组运行对不上时，以本检修记录为准；
// 6) 拍门判定需更换 -> 落入泵组运行的「拍门待更换台账」；恢复正常 -> 台账关闭；
// 7) version 乐观锁：同一台拍门的重复/过期提交只接受先到的一版。

const SLUICE_KEY = 'sluice'
const PUMPRUN_KEY = 'pumprun'

export const SLUICE_STATUSES = ['待检修', '检修中', '状态正常', '需更换'] as const
export const SEAL_OPTIONS = ['密封良好', '轻微渗漏', '密封失效'] as const

// 密封状况 -> 拍门状态：密封改了，拍门状态跟着变。
const SEAL_TO_STATUS: Record<string, (typeof SLUICE_STATUSES)[number]> = {
  密封良好: '状态正常',
  轻微渗漏: '检修中',
  密封失效: '需更换',
}

export type SluiceInput = {
  所属泵站: string
  拍门编号: string
  密封状况: string
  检修方式?: string
  检修人?: string
  检修日期?: string
}

function nowStamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}

function nextCode(rows: EntryRow[], prefix: string, field: string): string {
  let max = 0
  for (const row of rows) {
    const code = String(row[field] ?? '')
    const hit = code.match(new RegExp(`^${prefix}-(\\d+)$`))
    if (hit) {
      max = Math.max(max, Number(hit[1]))
    }
  }
  return `${prefix}-${String(max + 1).padStart(4, '0')}`
}

// 转出的老记录只作为原泵站历史保留，不再参与状态流转、重号判定与统计。
export function isFrozen(row: EntryRow): boolean {
  return String(row.历史标记 ?? '') === '已转出'
}

// 「待处理」口径：转出留档的历史记录不算待处理。
function pendingFor(status: string): boolean {
  return status === '待检修' || status === '检修中' || status === '需更换'
}

function activeRows(rows: EntryRow[]): EntryRow[] {
  return rows.filter((row) => !isFrozen(row))
}

function findRowIndex(rows: EntryRow[], id: number): number {
  return rows.findIndex((row) => Number(row.id) === id)
}

// 同泵站重号校验：返回与之撞号的在役记录，转出留档的历史不参与。
function findDuplicate(
  rows: EntryRow[],
  station: string,
  gateCode: string,
  excludeId?: number,
): EntryRow | undefined {
  return activeRows(rows).find(
    (row) =>
      Number(row.id) !== excludeId &&
      String(row.所属泵站 ?? '').trim() === station.trim() &&
      String(row.拍门编号 ?? '').trim() === gateCode.trim(),
  )
}

function validateInput(input: SluiceInput): string | null {
  if (!input.所属泵站?.trim()) return '所属泵站不能为空'
  if (!input.拍门编号?.trim()) return '拍门编号不能为空'
  if (!input.密封状况?.trim()) return '密封状况不能为空'
  if (!SEAL_OPTIONS.includes(input.密封状况 as (typeof SEAL_OPTIONS)[number])) {
    return `密封状况只允许：${SEAL_OPTIONS.join('、')}`
  }
  return null
}

function versionOf(row: EntryRow): number {
  const v = Number(row.version)
  return Number.isFinite(v) ? v : 0
}

function ensureStampFields(row: EntryRow): void {
  if (row.待检修时间 === undefined) row.待检修时间 = ''
  if (row.状态正常时间 === undefined) row.状态正常时间 = ''
}

// ── 泵组运行：拍门待更换台账 ────────────────────────────────────────────────

export const LEDGER_TYPE = '拍门待更换台账'
const LEDGER_CODE_PREFIX = 'PM'

function ledgerRows(pumpRows: EntryRow[]): EntryRow[] {
  return pumpRows.filter((row) => String(row.台账类型 ?? '') === LEDGER_TYPE)
}

// 以检修记录为准对账泵组运行台账：
// 在役且「需更换」的拍门必须有待更换台账；其余拍门若还挂着待更换台账则关闭。
// 泵组运行页与拍门页的每一处写操作后都调用，保证两边对不上时以检修记录为准。
export function reconcileLedger(): void {
  const sluiceRows = listRows(SLUICE_KEY)
  const pumpRows = listRows(PUMPRUN_KEY)
  let changed = false

  const needing = new Map<number, EntryRow>()
  for (const row of activeRows(sluiceRows)) {
    if (String(row.status) === '需更换') {
      needing.set(Number(row.id), row)
    }
  }

  for (const row of ledgerRows(pumpRows)) {
    if (String(row.台账状态) !== '待更换') continue
    const source = needing.get(Number(row.来源检修ID ?? -1))
    if (source) {
      needing.delete(Number(row.来源检修ID))
      continue
    }
    // 检修记录已不是需更换（或已转出留档）：台账以检修记录为准，关闭。
    row.台账状态 = '已关闭'
    row.status = '已停机'
    row.运行状态 = '已更换'
    row.关闭时间 = nowStamp()
    row.pending = false
    row.abnormal = false
    changed = true
  }

  for (const source of needing.values()) {
    const row: EntryRow = {
      id: pumpRows.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1,
      status: '故障停机',
      pending: true,
      abnormal: true,
      运行编号: nextCode(pumpRows, LEDGER_CODE_PREFIX, '运行编号'),
      所属泵站: String(source.所属泵站 ?? ''),
      泵组编号: `拍门-${source.拍门编号}`,
      运行电流: '',
      出水流量: '',
      值班人: String(source.检修人 ?? ''),
      记录时间: nowStamp(),
      运行状态: '待更换',
      台账类型: LEDGER_TYPE,
      台账状态: '待更换',
      拍门编号: String(source.拍门编号 ?? ''),
      检修编号: String(source.检修编号 ?? ''),
      关闭时间: '',
      来源检修ID: Number(source.id),
    }
    pumpRows.push(row)
    changed = true
  }

  if (changed) {
    saveRows(PUMPRUN_KEY, pumpRows)
  }
}

// ── 拍门检修：读 ────────────────────────────────────────────────────────────

export function listSluiceEntries(filters: Record<string, string> = {}): EntryRow[] {
  const rows = listRows(SLUICE_KEY)
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) return rows
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

// ── 拍门检修：登记 ──────────────────────────────────────────────────────────

export function createSluiceEntry(input: SluiceInput): ActionResult {
  const problem = validateInput(input)
  if (problem) return { ok: false, message: problem }

  const rows = listRows(SLUICE_KEY)
  const clash = findDuplicate(rows, input.所属泵站, input.拍门编号)
  if (clash) {
    return {
      ok: false,
      message: `提交被挡下：${input.所属泵站}下拍门编号「${input.拍门编号}」与检修编号「${clash.检修编号}」撞号，请改用其他编号`,
    }
  }

  const stamp = nowStamp()
  const id = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const row: EntryRow = {
    id,
    status: '待检修',
    pending: true,
    abnormal: false,
    version: 1,
    检修编号: nextCode(rows, 'SLUI', '检修编号'),
    所属泵站: input.所属泵站.trim(),
    拍门编号: input.拍门编号.trim(),
    密封状况: input.密封状况,
    检修方式: input.检修方式?.trim() ?? '',
    检修人: input.检修人?.trim() ?? '',
    检修日期: input.检修日期?.trim() ?? '',
    待检修时间: stamp,
    状态正常时间: '',
    历史标记: '',
    拍门状态: '待检修',
  }
  saveRows(SLUICE_KEY, [...rows, row])
  return { ok: true, message: `拍门检修记录 ${row.检修编号} 已登记，当前状态「待检修」` }
}

// ── 拍门检修：改动提交（含密封状况编辑、所属泵站变更） ────────────────────────

export function updateSluiceEntry(
  id: number,
  input: SluiceInput,
  baseVersion?: number,
): ActionResult {
  const problem = validateInput(input)
  if (problem) return { ok: false, message: problem }

  const rows = listRows(SLUICE_KEY)
  const index = findRowIndex(rows, id)
  if (index < 0) return { ok: false, message: `没有找到编号为 ${id} 的拍门检修记录` }

  const current = rows[index]
  if (isFrozen(current)) {
    return { ok: false, message: '该记录已随所属泵站变更留档，不能再改动，如需处理请编辑新泵站下的记录' }
  }

  // 乐观锁：后到的重复提交（拿着旧 version）一律挡下，只接受先到的一版。
  if (baseVersion !== undefined && versionOf(current) !== baseVersion) {
    return { ok: false, message: '改动未保存：这条拍门已有先到的一版改动，请刷新后基于最新值再改' }
  }

  const clash = findDuplicate(rows, input.所属泵站, input.拍门编号, id)
  if (clash) {
    return {
      ok: false,
      message: `提交被挡下：${input.所属泵站}下拍门编号「${input.拍门编号}」与检修编号「${clash.检修编号}」撞号，请改用其他编号`,
    }
  }

  const oldStation = String(current.所属泵站 ?? '').trim()
  const newStation = input.所属泵站.trim()
  const next = [...rows]

  // 所属泵站换了：原检修编号与整条记录留在原泵站做历史，不跟着搬；
  // 新泵站下生成一条新的检修记录（新检修编号、从待检修重新走流程）。
  if (oldStation !== newStation) {
    ensureStampFields(current)
    const oldRecord: EntryRow = {
      ...current,
      历史标记: '已转出',
      pending: false,
    }
    const stamp = nowStamp()
    const newId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
    const newRecord: EntryRow = {
      id: newId,
      status: '待检修',
      pending: true,
      abnormal: false,
      version: 1,
      检修编号: nextCode(rows, 'SLUI', '检修编号'),
      所属泵站: newStation,
      拍门编号: input.拍门编号.trim(),
      密封状况: input.密封状况,
      检修方式: input.检修方式?.trim() ?? '',
      检修人: input.检修人?.trim() ?? '',
      检修日期: input.检修日期?.trim() ?? '',
      待检修时间: stamp,
      状态正常时间: '',
      历史标记: '',
      拍门状态: '待检修',
      转出来源: oldStation,
    }
    next[index] = oldRecord
    next.push(newRecord)
    saveRows(SLUICE_KEY, next)
    reconcileLedger()
    return {
      ok: true,
      message: `已变更所属泵站：原记录 ${oldRecord.检修编号} 留在「${oldStation}」历史；新记录 ${newRecord.检修编号} 已在「${newStation}」从待检修建档`,
    }
  }

  // 同一泵站内：密封状况改过，拍门状态跟着变。
  const updated: EntryRow = {
    ...current,
    所属泵站: newStation,
    拍门编号: input.拍门编号.trim(),
    密封状况: input.密封状况,
    检修方式: input.检修方式?.trim() ?? '',
    检修人: input.检修人?.trim() ?? '',
    检修日期: input.检修日期?.trim() ?? '',
    version: versionOf(current) + 1,
  }
  ensureStampFields(updated)

  if (updated.密封状况 !== String(current.密封状况 ?? '')) {
    const target = SEAL_TO_STATUS[String(updated.密封状况)]
    if (target && String(updated.status) !== target) {
      updated.status = target
      updated.拍门状态 = target
      updated.pending = pendingFor(target)
      updated.abnormal = target === '需更换'
      if (target === '状态正常') {
        updated.状态正常时间 = nowStamp()
      }
    }
  }

  next[index] = updated
  saveRows(SLUICE_KEY, next)
  reconcileLedger()
  return { ok: true, message: `拍门检修记录 ${updated.检修编号} 的改动已保存` }
}

// ── 拍门检修：状态流转动作 ──────────────────────────────────────────────────

export function runSluiceAction(
  id: number,
  action: string,
  baseVersion?: number,
): ActionResult {
  const targetMap: Record<string, string> = {
    提交检修: '检修中',
    判定正常: '状态正常',
    提出更换: '需更换',
  }
  const target = targetMap[action]
  if (!target) {
    return { ok: false, message: `拍门检修没有登记「${action}」这个动作` }
  }

  const rows = listRows(SLUICE_KEY)
  const index = findRowIndex(rows, id)
  if (index < 0) return { ok: false, message: `没有找到编号为 ${id} 的拍门检修记录` }

  const current = rows[index]
  if (isFrozen(current)) {
    return { ok: false, message: '该记录是转出留档的历史记录，状态不再流转' }
  }
  if (baseVersion !== undefined && versionOf(current) !== baseVersion) {
    return { ok: false, message: '操作未生效：这条拍门已有先到的一版改动，请刷新后基于最新值再操作' }
  }

  const currentStatus = String(current.status)
  if (currentStatus === target) {
    return { ok: false, message: `拍门已经是「${target}」，不用重复操作` }
  }
  // 状态只往前走，不回退；但需更换的拍门检修/更换完成后可恢复为状态正常。
  // 若确需把正常/检修中的拍门改判，请走编辑改密封状况联动。
  const allowedTargets: Record<string, string[]> = {
    待检修: ['检修中'],
    检修中: ['状态正常', '需更换'],
    状态正常: [],
    需更换: ['状态正常'],
  }
  if (!allowedTargets[currentStatus]?.includes(target)) {
    return { ok: false, message: `拍门当前「${currentStatus}」，不能直接${action}到「${target}」；如需改判请编辑密封状况` }
  }

  const stamp = nowStamp()
  const updated: EntryRow = {
    ...current,
    status: target,
    拍门状态: target,
    pending: pendingFor(target),
    abnormal: target === '需更换',
    version: versionOf(current) + 1,
  }
  ensureStampFields(updated)
  if (target === '状态正常' && !updated.状态正常时间) {
    updated.状态正常时间 = stamp
  }

  const next = [...rows]
  next[index] = updated
  saveRows(SLUICE_KEY, next)
  reconcileLedger()
  return { ok: true, message: `拍门已${action}，当前状态「${target}」` }
}
