import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 拍门检修领域服务：
// - 登记 / 编辑 / 状态流转都在这里落库（localStorage），刷新、退出再进来改动不丢；
// - 同一泵站下拍门编号唯一，重号提交拦下并指出撞了谁；
// - 进入「状态正常」记录正常确认时间戳；
// - 所属泵站变更：原记录冻结为原泵站历史，不跟着搬，新记录在新泵站另立编号；
// - 需更换的拍门同步到泵组运行的待更换台账，台账始终以检修记录为准。

export const SLUICE_KEY = 'sluice'
export const PUMPRUN_KEY = 'pumprun'

export const SEAL_OPTIONS = ['良好', '渗漏', '破损']
export const GATE_STATUS_OPTIONS = ['待检修', '检修中', '状态正常', '需更换']
const TERMINAL_STATUS = '状态正常'
const REPLACE_STATUS = '需更换'

// 待更换台账在泵组运行表里的标记：带这个键的行是由检修记录对账生成的，不能被手动改偏。
export const LEDGER_FLAG = '__sluiceLedger'
export const LEDGER_KEY_FIELD = '__ledgerKey'
// 命中的是泵组运行原有行时，把被覆盖的字段存成快照；拍门恢复后原样还回，不丢原运行记录。
const LEDGER_RESTORE_FIELD = '__restoreSnapshot'

export type SluiceStatus = (typeof GATE_STATUS_OPTIONS)[number]

export type SluiceForm = {
  id: number | null // null 表示登记新记录
  version: number // 乐观锁：只接受先到的那一版
  检修编号: string
  所属泵站: string
  拍门编号: string
  密封状况: string
  检修方式: string
  检修人: string
  检修日期: string
  拍门状态: string
  正常确认时间: string
}

export type SluiceMutationResult = ActionResult & {
  active?: EntryRow // 改后落在新泵站/原泵站的当前记录
  archived?: EntryRow // 换泵站时被冻结的原泵站历史记录
}

// 密封状况 → 拍门状态：密封状况改过，拍门状态跟着变。
export function statusFromSeal(seal: string): SluiceStatus {
  if (seal === '良好') return '状态正常'
  if (seal === '渗漏') return '检修中'
  if (seal === '破损') return '需更换'
  return '待检修'
}

function normalize(row: EntryRow): EntryRow {
  return {
    ...row,
    version: typeof row.version === 'number' ? row.version : 1,
    正常确认时间: typeof row['正常确认时间'] === 'string' ? row['正常确认时间'] : '',
    拍门状态: typeof row['拍门状态'] === 'string' && row['拍门状态'] ? row['拍门状态'] : row.status,
  }
}

/** 拍门检修记录：历史记录排在最后，其余按编号排序。 */
export function listSluiceRows(): EntryRow[] {
  return listRows(SLUICE_KEY)
    .map(normalize)
    .sort((a, b) => {
      if (Boolean(a.historical) !== Boolean(b.historical)) {
        return a.historical ? 1 : -1
      }
      return String(a['检修编号']).localeCompare(String(b['检修编号']))
    })
}

function persist(rows: EntryRow[]): void {
  saveRows(SLUICE_KEY, rows.map(normalize))
}

export function activeRows(rows: EntryRow[] = listSluiceRows()): EntryRow[] {
  return rows.filter((row) => !row.historical)
}

function nextServiceNo(rows: EntryRow[]): string {
  let max = 0
  for (const row of rows) {
    const matched = /^SLUI-(\d+)$/.exec(String(row['检修编号'] ?? ''))
    if (matched) {
      max = Math.max(max, Number(matched[1]))
    }
  }
  return `SLUI-${String(max + 1).padStart(4, '0')}`
}

function duplicateInStation(
  rows: EntryRow[],
  station: string,
  gateNo: string,
  excludeId: number | null,
): EntryRow | undefined {
  return activeRows(rows).find(
    (row) =>
      Number(row.id) !== Number(excludeId) &&
      String(row['所属泵站'] ?? '').trim() === station.trim() &&
      String(row['拍门编号'] ?? '').trim() === gateNo.trim(),
  )
}

function nowStamp(): string {
  return new Date().toISOString()
}

function stampForStatus(previous: string, next: string, previousStamp: string): string {
  // 一台拍门走到「状态正常」要留时间戳；之后离开再回来，刷新为新的确认时间。
  if (next === TERMINAL_STATUS && previous !== TERMINAL_STATUS) {
    return nowStamp()
  }
  if (next === TERMINAL_STATUS) {
    return previousStamp || nowStamp()
  }
  return previousStamp
}

function withStatus(row: EntryRow, status: string): EntryRow {
  const next = normalize(row)
  const nextStatus = status as SluiceStatus
  return {
    ...next,
    status: nextStatus,
    拍门状态: nextStatus,
    pending: nextStatus !== TERMINAL_STATUS,
    正常确认时间: stampForStatus(String(next.status), nextStatus, String(next['正常确认时间'] ?? '')),
    提报时间: typeof next['提报时间'] === 'string' && next['提报时间'] ? next['提报时间'] : nowStamp(),
    version: Number(next.version) + 1,
  }
}

function buildRowFromForm(form: SluiceForm, id: number, base?: EntryRow): EntryRow {
  const previous = base ? normalize(base) : undefined
  const nextStatus = form.拍门状态 as SluiceStatus
  return {
    id,
    status: nextStatus,
    pending: nextStatus !== TERMINAL_STATUS,
    abnormal: false,
    version: Number(form.version) + 1,
    historical: false,
    检修编号: form.检修编号,
    所属泵站: form.所属泵站,
    拍门编号: form.拍门编号,
    密封状况: form.密封状况,
    检修方式: form.检修方式,
    检修人: form.检修人,
    检修日期: form.检修日期,
    拍门状态: nextStatus,
    正常确认时间: stampForStatus(
      String(previous?.status ?? ''),
      nextStatus,
      String(form.正常确认时间 ?? ''),
    ),
    提报时间: previous && previous['提报时间'] ? previous['提报时间'] : nowStamp(),
  }
}

/**
 * 登记或保存拍门检修记录。
 * - 同泵站拍门编号重号：拦截，并指出与哪条记录（检修编号）撞号；
 * - 编辑时所属泵站被换掉：原记录冻结为原泵站历史，改动后的记录带着新编号进新泵站；
 * - version 对不上说明有人先提交过：只接受先到的那一版。
 */
export function saveSluiceRecord(form: SluiceForm): SluiceMutationResult {
  const station = form.所属泵站.trim()
  const gateNo = form.拍门编号.trim()
  if (!station) {
    return { ok: false, message: '所属泵站不能为空' }
  }
  if (!gateNo) {
    return { ok: false, message: '拍门编号不能为空' }
  }

  const rows = listSluiceRows()
  const base = form.id === null ? undefined : rows.find((row) => Number(row.id) === Number(form.id))

  if (form.id !== null) {
    if (!base) {
      return { ok: false, message: `没有找到编号为 ${form.id} 的拍门检修记录` }
    }
    if (base.historical) {
      return { ok: false, message: '该记录已归为原泵站历史，历史记录不能再修改' }
    }
    if (Number(base.version) !== Number(form.version)) {
      return {
        ok: false,
        message: `这条记录已被其他人先改过（当前第 ${base.version} 版），你这版提交被挡下，请刷新后按最新值重新修改`,
      }
    }
  }

  const collision = duplicateInStation(rows, station, gateNo, form.id)
  if (collision) {
    return {
      ok: false,
      message: `泵站「${station}」下拍门编号「${gateNo}」已被检修记录 ${collision['检修编号']} 占用，不能重号，请换编号或核对泵站`,
    }
  }

  // 换泵站：旧记录留在原泵站，冻结成历史；当前改动另立新记录、另立检修编号。
  if (base && String(base['所属泵站'] ?? '').trim() !== station) {
    const archived = normalize({
      ...base,
      historical: true,
      pending: false,
      version: Number(base.version) + 1,
    })
    const nextId = rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
    const moved = buildRowFromForm(
      { ...form, 检修编号: nextServiceNo(rows) },
      nextId,
      undefined,
    )
    persist(rows.map((row) => (Number(row.id) === Number(base.id) ? archived : row)).concat(moved))
    syncReplacementLedger()
    return {
      ok: true,
      message: `所属泵站已从「${base['所属泵站']}」改为「${station}」：原检修编号 ${base['检修编号']} 与记录保留为原泵站历史，新记录编号 ${moved['检修编号']}`,
      active: moved,
      archived,
    }
  }

  if (base) {
    const updated = buildRowFromForm(form, Number(base.id), base)
    persist(rows.map((row) => (Number(row.id) === Number(base.id) ? updated : row)))
    syncReplacementLedger()
    return { ok: true, message: `拍门检修记录 ${updated['检修编号']} 已保存`, active: updated }
  }

  const id = rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
  const created = buildRowFromForm({ ...form, 检修编号: nextServiceNo(rows) }, id, undefined)
  persist(rows.concat(created))
  syncReplacementLedger()
  return { ok: true, message: `拍门检修记录 ${created['检修编号']} 已登记`, active: created }
}

/**
 * 动作流转：提交检修 / 判定正常 / 提出更换。
 * 乐观锁 expectedVersion 由页面持有，连点两次只会接受第一下。
 */
export function advanceSluiceStatus(
  id: number,
  target: SluiceStatus,
  expectedVersion: number,
): SluiceMutationResult {
  const rows = listSluiceRows()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的拍门检修记录` }
  }
  const current = rows[index]
  if (current.historical) {
    return { ok: false, message: '历史记录不能再做状态流转' }
  }
  if (Number(current.version) !== Number(expectedVersion)) {
    return {
      ok: false,
      message: `该拍门已有一版改动先提交成功（第 ${current.version} 版），重复提交被挡下，只接受先到的那一版`,
    }
  }
  if (String(current.status) === target) {
    return { ok: false, message: `拍门当前已经是「${target}」，不用重复操作` }
  }
  const updated = withStatus(current, target)
  persist(rows.map((row) => (Number(row.id) === id ? updated : row)))
  syncReplacementLedger()
  const suffix = target === TERMINAL_STATUS && updated['正常确认时间']
    ? `，正常确认时间 ${formatStamp(String(updated['正常确认时间']))}`
    : ''
  return { ok: true, message: `拍门 ${updated['拍门编号']} 已更新为「${target}」${suffix}`, active: updated }
}

function ledgerKeyFor(row: EntryRow): string {
  return `${String(row['所属泵站'] ?? '').trim()}::${String(row['拍门编号'] ?? '').trim()}`
}

/**
 * 以拍门检修记录为准，对账泵组运行的待更换台账：
 * - 当前拍门为「需更换」：台账必须有一条；泵组运行里同泵站同泵组编号的行状态对不上，
 *   以检修记录为准，补/修成「待更换」；
 * - 拍门已不处于需更换（修好/换泵站/成为历史）：对应台账行撤下。
 */
export function syncReplacementLedger(): EntryRow[] {
  const sluiceRows = listSluiceRows()
  const pumpRows = listRows(PUMPRUN_KEY).map((row) => ({ ...row }))

  const replacementKeys = new Set(
    activeRows(sluiceRows)
      .filter((row) => String(row.status) === REPLACE_STATUS)
      .map(ledgerKeyFor),
  )

  const replacementGate = new Map(
    activeRows(sluiceRows)
      .filter((row) => String(row.status) === REPLACE_STATUS)
      .map((row) => [ledgerKeyFor(row), row]),
  )

  const next: EntryRow[] = []

  // 已有的台账行：继续需更换就保留并校正，否则撤下。
  for (const row of pumpRows) {
    if (row[LEDGER_FLAG]) {
      const key = String(row[LEDGER_KEY_FIELD] ?? '')
      const gate = replacementGate.get(key)
      if (gate) {
        next.push(buildLedgerRow(row, gate))
      } else if (row[LEDGER_RESTORE_FIELD]) {
        // 这条原本就是泵组运行记录，拍门恢复后还原成它原来的值。
        next.push(restoreSnapshot(row))
      }
      continue
    }
    next.push(row)
  }

  // 新出现的需更换拍门：先看泵组运行里是否已有同泵站同泵组编号的行，有就以检修记录为准改写，
  // 没有再补台账行。
  for (const [key, gate] of replacementGate) {
    const existingIndex = next.findIndex(
      (row) =>
        !row[LEDGER_FLAG] &&
        `${String(row['所属泵站'] ?? '').trim()}::${String(row['泵组编号'] ?? '').trim()}` === key,
    )
    if (existingIndex >= 0) {
      next[existingIndex] = buildLedgerRow(next[existingIndex], gate)
      continue
    }
    const ledgerExists = next.some((row) => row[LEDGER_FLAG] && String(row[LEDGER_KEY_FIELD]) === key)
    if (!ledgerExists) {
      const id = next.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
      next.push(buildLedgerRow({ id } as EntryRow, gate))
    }
  }

  saveRows(PUMPRUN_KEY, next)
  return next
}

const SNAPSHOT_FIELDS = ['status', 'pending', 'abnormal', '运行编号', '运行电流', '出水流量', '值班人', '记录时间', '运行状态']

function restoreSnapshot(row: EntryRow): EntryRow {
  const snapshot = (row[LEDGER_RESTORE_FIELD] ?? {}) as unknown as Record<
    string,
    string | number | boolean
  >
  const restored: EntryRow = { ...row }
  delete restored[LEDGER_FLAG]
  delete restored[LEDGER_KEY_FIELD]
  delete restored[LEDGER_RESTORE_FIELD]
  for (const field of SNAPSHOT_FIELDS) {
    if (field in snapshot) {
      restored[field] = snapshot[field]
    }
  }
  return restored
}

function buildLedgerRow(row: Partial<EntryRow>, gate: EntryRow): EntryRow {
  const key = ledgerKeyFor(gate)
  const alreadyLedger = Boolean(row[LEDGER_FLAG])
  const previousStamp =
    typeof row['提报时间'] === 'string' && alreadyLedger
      ? String(row['提报时间'])
      : String(gate['提报时间'] ?? nowStamp())
  const base: EntryRow = {
    id: Number(row.id),
    status: '待更换',
    pending: true,
    abnormal: false,
    [LEDGER_FLAG]: true,
    [LEDGER_KEY_FIELD]: key,
    运行编号: row['运行编号'] ? String(row['运行编号']) : `REPL-${String(gate['检修编号'] ?? '').replace(/^SLUI-/, '')}`,
    所属泵站: String(gate['所属泵站'] ?? ''),
    泵组编号: String(gate['拍门编号'] ?? ''),
    运行电流: '—',
    出水流量: '—',
    值班人: String(gate['检修人'] ?? ''),
    记录时间: String(gate['检修日期'] ?? ''),
    运行状态: '待更换',
    提报时间: previousStamp,
  }
  // 覆盖的是一条原有的泵组运行行：存好原始字段快照，拍门恢复后能原样还原，不丢记录。
  // 已经是台账行时，之前存下的快照要继续带着，不能在刷新对账时丢掉。
  if (alreadyLedger && row[LEDGER_RESTORE_FIELD] !== undefined) {
    ;(base as unknown as Record<string, unknown>)[LEDGER_RESTORE_FIELD] = row[LEDGER_RESTORE_FIELD]
  } else if (!alreadyLedger && row.id !== undefined && row.status !== undefined) {
    const snapshot: Record<string, string | number | boolean> = {}
    for (const field of SNAPSHOT_FIELDS) {
      if (row[field] !== undefined) {
        snapshot[field] = row[field] as string | number | boolean
      }
    }
    ;(base as unknown as Record<string, unknown>)[LEDGER_RESTORE_FIELD] = snapshot
  }
  return base
}

/** 泵组运行页读取前先对账：拍门状态与泵组运行对不上时，始终以检修记录为准。 */
export function listPumprunReconciled(): EntryRow[] {
  return syncReplacementLedger()
}

export function isLedgerRow(row: EntryRow): boolean {
  return Boolean(row[LEDGER_FLAG])
}

export function emptyForm(today: string): SluiceForm {
  return {
    id: null,
    version: 0,
    检修编号: '',
    所属泵站: '',
    拍门编号: '',
    密封状况: '渗漏',
    检修方式: '现场检修',
    检修人: '',
    检修日期: today,
    拍门状态: '待检修',
    正常确认时间: '',
  }
}

export function formFromRow(row: EntryRow): SluiceForm {
  const normalized = normalize(row)
  return {
    id: Number(normalized.id),
    version: Number(normalized.version),
    检修编号: String(normalized['检修编号'] ?? ''),
    所属泵站: String(normalized['所属泵站'] ?? ''),
    拍门编号: String(normalized['拍门编号'] ?? ''),
    密封状况: String(normalized['密封状况'] ?? ''),
    检修方式: String(normalized['检修方式'] ?? ''),
    检修人: String(normalized['检修人'] ?? ''),
    检修日期: String(normalized['检修日期'] ?? ''),
    拍门状态: String(normalized.status ?? ''),
    正常确认时间: String(normalized['正常确认时间'] ?? ''),
  }
}

export function formatStamp(stamp: string): string {
  if (!stamp) {
    return '—'
  }
  const date = new Date(stamp)
  if (Number.isNaN(date.getTime())) {
    return stamp
  }
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`
}
