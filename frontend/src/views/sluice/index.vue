<template>
  <section class="page" data-module="sluice">
    <header class="page-head">
      <div>
        <h2>拍门检修管理</h2>
        <p class="page-desc">维护拍门检修记录，围绕检修编号、所属泵站、拍门编号、密封状况做登记、筛选与状态流转。改动即保存，刷新、退出再进来仍是改后的值。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记拍门检修记录</button>
        <button class="btn" type="button" @click="exportRows">导出拍门检修清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'history-row': isFrozenRow(row) }">
          <td v-for="column in columns" :key="column">
            <template v-if="column === '检修编号'">
              {{ row[column] }}
              <span v-if="isFrozenRow(row)" class="tag tag-history" :title="`已转至「${row.所属泵站}」，本条留在原泵站历史`">已转出留档</span>
            </template>
            <template v-else-if="column === '所属泵站'">
              {{ row[column] }}
              <span v-if="row.转出来源" class="tag tag-moved" :title="`由「${row.转出来源}」转入`">由{{ row.转出来源 }}转入</span>
            </template>
            <template v-else>{{ row[column] || '—' }}</template>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openEdit(row)">编辑</button>
            <button
              v-for="action in availableActions(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无拍门检修数据，可先登记拍门检修记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条拍门检修记录（含 {{ frozenCount }} 条转出留档历史）</span>
      <span v-if="okMessage" class="ok-text">{{ okMessage }}</span>
      <span v-else-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="dialogOpen" class="modal-mask" @click.self="closeDialog">
      <div class="modal">
        <h3 class="modal-title">{{ dialogMode === 'create' ? '登记拍门检修记录' : `编辑拍门检修记录 ${form.检修编号}` }}</h3>
        <div class="form-grid">
          <label v-if="dialogMode === 'edit'" class="form-item form-wide">
            <span>检修编号</span>
            <input :value="form.检修编号" disabled />
          </label>
          <label class="form-item">
            <span>所属泵站 *</span>
            <input v-model="form.所属泵站" placeholder="如：阳光立交泵站" />
          </label>
          <label class="form-item">
            <span>拍门编号 *</span>
            <input v-model="form.拍门编号" placeholder="同一泵站内不能重号" />
          </label>
          <label class="form-item">
            <span>密封状况 *</span>
            <select v-model="form.密封状况">
              <option value="" disabled>请选择</option>
              <option v-for="opt in sealOptions" :key="opt" :value="opt">{{ opt }}</option>
            </select>
          </label>
          <label class="form-item">
            <span>检修方式</span>
            <input v-model="form.检修方式" placeholder="如：密封胶条更换" />
          </label>
          <label class="form-item">
            <span>检修人</span>
            <input v-model="form.检修人" />
          </label>
          <label class="form-item">
            <span>检修日期</span>
            <input v-model="form.检修日期" placeholder="YYYY-MM-DD" />
          </label>
        </div>
        <p v-if="dialogMode === 'edit'" class="form-hint">
          改密封状况会联动拍门状态：密封良好→状态正常（留存正常时间）；轻微渗漏→检修中；密封失效→需更换（入泵组运行待更换台账）。
          更换所属泵站时，当前检修编号与记录留在原泵站历史，新泵站下重新建档。
        </p>
        <p v-if="dialogError" class="error-text">{{ dialogError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeDialog">取消</button>
          <button class="btn primary" type="button" @click="submitForm">保存</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import {
  createSluiceEntry,
  isFrozen,
  listSluiceEntries,
  reconcileLedger,
  runSluiceAction,
  SEAL_OPTIONS,
  updateSluiceEntry,
  type SluiceInput,
} from '@/api/sluice-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('sluice')
const columns = ["检修编号", "所属泵站", "拍门编号", "密封状况", "检修方式", "检修人", "检修日期", "待检修时间", "状态正常时间"]
const sealOptions = [...SEAL_OPTIONS]
const statuses = ["待检修", "检修中", "状态正常", "需更换"]
const statLabels: Record<string, string> = {
  待检修: '待检修拍门',
  状态正常: '状态正常拍门',
  需更换: '需更换拍门',
}

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const okMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["检修编号", "所属泵站", "拍门编号"]

function activeRows() {
  return rows.value.filter((row) => !isFrozen(row))
}

const frozenCount = computed(() => rows.value.filter((row) => isFrozen(row)).length)

const stats = computed(() =>
  ['待检修', '状态正常', '需更换'].map((status) => ({
    label: statLabels[status],
    value: activeRows().filter((row) => String(row.status) === status).length,
  })),
)

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: activeRows().filter((row) => String(row.status) === status).length,
  })),
)

function isFrozenRow(row: EntryRow): boolean {
  return isFrozen(row)
}

// 状态只能往前走，转出留档的历史记录不再提供动作。
function availableActions(row: EntryRow): string[] {
  if (isFrozen(row)) return []
  const order = statuses.indexOf(String(row.status))
  const forward: Record<number, string[]> = {
    0: ['提交检修'],
    1: ['判定正常', '提出更换'],
    2: [],
    3: ['判定正常'],
  }
  return forward[order] ?? []
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

// ── 登记 / 编辑弹窗 ─────────────────────────────────────────────────────────

const dialogOpen = ref(false)
const dialogMode = ref<'create' | 'edit'>('create')
const dialogError = ref('')
const editingId = ref<number | null>(null)
const editingVersion = ref(0)

const form = reactive<SluiceInput & { 检修编号?: string }>({
  检修编号: '',
  所属泵站: '',
  拍门编号: '',
  密封状况: '',
  检修方式: '',
  检修人: '',
  检修日期: '',
})

function resetForm() {
  form.检修编号 = ''
  form.所属泵站 = ''
  form.拍门编号 = ''
  form.密封状况 = ''
  form.检修方式 = ''
  form.检修人 = ''
  form.检修日期 = ''
}

function openCreate() {
  flash('')
  dialogMode.value = 'create'
  dialogError.value = ''
  resetForm()
  dialogOpen.value = true
}

function openEdit(row: EntryRow) {
  flash('')
  if (isFrozen(row)) {
    flashError(`记录 ${row.检修编号} 已转出留档，只可查看；新泵站下的记录可继续编辑`)
    return
  }
  dialogMode.value = 'edit'
  dialogError.value = ''
  editingId.value = Number(row.id)
  editingVersion.value = Number(row.version) || 0
  form.检修编号 = String(row.检修编号 ?? '')
  form.所属泵站 = String(row.所属泵站 ?? '')
  form.拍门编号 = String(row.拍门编号 ?? '')
  form.密封状况 = String(row.密封状况 ?? '')
  form.检修方式 = String(row.检修方式 ?? '')
  form.检修人 = String(row.检修人 ?? '')
  form.检修日期 = String(row.检修日期 ?? '')
  dialogOpen.value = true
}

function closeDialog() {
  dialogOpen.value = false
  editingId.value = null
}

function submitForm() {
  const payload: SluiceInput = {
    所属泵站: form.所属泵站,
    拍门编号: form.拍门编号,
    密封状况: form.密封状况,
    检修方式: form.检修方式,
    检修人: form.检修人,
    检修日期: form.检修日期,
  }
  const result =
    dialogMode.value === 'create'
      ? createSluiceEntry(payload)
      : updateSluiceEntry(editingId.value as number, payload, editingVersion.value)
  if (!result.ok) {
    dialogError.value = result.message
    return
  }
  closeDialog()
  reload()
  flash(result.message)
}

// ── 状态流转 ─────────────────────────────────────────────────────────────────

function runAction(action: string, row: EntryRow) {
  flash('')
  // 带着打开时看到的 version 提交：后到的重复操作拿旧 version，会被挡下。
  const result = runSluiceAction(Number(row.id), action, Number(row.version) || 0)
  if (!result.ok) {
    flashError(result.message)
    return
  }
  reload()
  flash(result.message)
}

function flash(message: string) {
  errorMessage.value = ''
  okMessage.value = message
}

function flashError(message: string) {
  okMessage.value = ''
  errorMessage.value = message
}

function reload() {
  try {
    // 泵组运行台账以检修记录为准对账，保证两边对不上时以本页为准。
    reconcileLedger()
    const payload = listSluiceEntries(filters.value)
    rows.value = payload
    total.value = payload.length
  } catch (error) {
    flashError(error instanceof Error ? error.message : '拍门检修列表读取失败')
  }
}

onMounted(() => {
  // 先走一遍通用读取，保证模块键在存储里齐全。
  listEntries(meta.key)
  reload()
})
</script>
