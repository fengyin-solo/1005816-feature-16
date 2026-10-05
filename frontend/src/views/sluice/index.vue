<template>
  <section class="page" data-module="sluice">
    <header class="page-head">
      <div>
        <h2>拍门检修管理</h2>
        <p class="page-desc">维护拍门检修记录，围绕检修编号、所属泵站、拍门编号、密封状况做登记、筛选与状态流转。</p>
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
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ? displayValue(column, row) : '—' }}</td>
          <td>
            {{ row.status }}
            <span v-if="row.historical" class="tag tag-history">原泵站历史</span>
          </td>
          <td class="row-actions">
            <button class="link" type="button" @click="openEdit(row)">编辑</button>
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              :disabled="!!row.historical"
              :title="row.historical ? '历史记录不能再流转' : ''"
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
      <span>共 {{ total }} 条拍门检修记录（含 {{ historyCount }} 条换泵站后保留的原泵站历史）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="modalOpen" class="modal-mask" @click.self="closeModal">
      <div class="modal">
        <div class="modal-head">
          <h3>{{ form.id === null ? '登记拍门检修记录' : `编辑拍门检修记录 ${form.检修编号}` }}</h3>
          <button class="link" type="button" @click="closeModal">关闭</button>
        </div>
        <form class="modal-body" @submit.prevent="submitForm">
          <label class="form-item">
            <span>检修编号</span>
            <input v-model="form.检修编号" readonly placeholder="保存时自动生成；换泵站会另立新编号" />
          </label>
          <label class="form-item">
            <span>所属泵站</span>
            <input v-model="form.所属泵站" required placeholder="如：城东泵站" />
          </label>
          <label class="form-item">
            <span>拍门编号</span>
            <input v-model="form.拍门编号" required placeholder="同一泵站下不能重号" />
          </label>
          <label class="form-item">
            <span>密封状况</span>
            <select v-model="form.密封状况" @change="onSealChange">
              <option v-for="option in sealOptions" :key="option" :value="option">{{ option }}</option>
            </select>
          </label>
          <label class="form-item">
            <span>检修方式</span>
            <input v-model="form.检修方式" />
          </label>
          <label class="form-item">
            <span>检修人</span>
            <input v-model="form.检修人" />
          </label>
          <label class="form-item">
            <span>检修日期</span>
            <input v-model="form.检修日期" type="date" />
          </label>
          <label class="form-item">
            <span>拍门状态</span>
            <select v-model="form.拍门状态">
              <option v-for="option in gateStatusOptions" :key="option" :value="option">{{ option }}</option>
            </select>
          </label>
          <label class="form-item form-item-full">
            <span>正常确认时间（首次走到「状态正常」时自动记录）</span>
            <input :value="form.正常确认时间 ? formatStamp(form.正常确认时间) : '—'" readonly />
          </label>
          <p class="form-hint">
            密封状况改动会带动拍门状态：良好→状态正常，渗漏→检修中，破损→需更换；状态可再手动调整。
          </p>
          <p v-if="formError" class="error-text">{{ formError }}</p>
          <div class="modal-actions">
            <button class="btn ghost" type="button" @click="closeModal">取消</button>
            <button class="btn primary" type="submit" :disabled="submitting">
              {{ submitting ? '提交中…' : '保存' }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'

import { downloadEntries } from '@/api/local-service'
import {
  advanceSluiceStatus,
  emptyForm,
  formFromRow,
  formatStamp,
  GATE_STATUS_OPTIONS,
  listSluiceRows,
  saveSluiceRecord,
  SEAL_OPTIONS,
  type SluiceForm,
} from '@/api/sluice-service'
import type { EntryRow } from '@/data/types'

const columns = ["检修编号", "所属泵站", "拍门编号", "密封状况", "检修方式", "检修人", "检修日期", "拍门状态", "正常确认时间"]
const actions = ["提交检修", "判定正常", "提出更换"]
const statuses = ["待检修", "检修中", "状态正常", "需更换"]
const actionTargets: Record<string, string> = {
  提交检修: "检修中",
  判定正常: "状态正常",
  提出更换: "需更换",
}
const sealOptions = SEAL_OPTIONS
const gateStatusOptions = GATE_STATUS_OPTIONS

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const activeRowsOnly = computed(() => rows.value.filter((row) => !row.historical))
const historyCount = computed(() => rows.value.length - activeRowsOnly.value.length)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: activeRowsOnly.value.filter((row) => String(row.status) === status).length,
  })),
)
const stats = computed(() => [
  { label: "待检修拍门", value: activeRowsOnly.value.filter((row) => row.status === '待检修').length },
  { label: "状态正常拍门", value: activeRowsOnly.value.filter((row) => row.status === '状态正常').length },
  { label: "需更换拍门", value: activeRowsOnly.value.filter((row) => row.status === '需更换').length },
])

const modalOpen = ref(false)
const submitting = ref(false)
const formError = ref('')
const form = reactive<SluiceForm>(emptyForm(new Date().toISOString().slice(0, 10)))

function displayValue(column: string, row: EntryRow): string {
  if (column === '正常确认时间') {
    return formatStamp(String(row[column] ?? ''))
  }
  return String(row[column])
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries('sluice')
}

function openCreate() {
  Object.assign(form, emptyForm(new Date().toISOString().slice(0, 10)))
  formError.value = ''
  modalOpen.value = true
}

function openEdit(row: EntryRow) {
  if (row.historical) {
    errorMessage.value = `记录 ${row['检修编号']} 已归为原泵站历史，只能查看不能修改`
    return
  }
  Object.assign(form, formFromRow(row))
  formError.value = ''
  modalOpen.value = true
}

function closeModal() {
  if (submitting.value) {
    return
  }
  modalOpen.value = false
}

// 密封状况改过，拍门状态跟着变（用户之后仍可手动再调）。
function onSealChange() {
  const seal = form.密封状况
  if (seal === '良好') form.拍门状态 = '状态正常'
  else if (seal === '渗漏') form.拍门状态 = '检修中'
  else if (seal === '破损') form.拍门状态 = '需更换'
}

function submitForm() {
  if (submitting.value) {
    return
  }
  formError.value = ''
  submitting.value = true
  try {
    const result = saveSluiceRecord({ ...form })
    if (!result.ok) {
      formError.value = result.message
      // 被挡下（重号/版本过期）后重新读取列表，让页面上始终是最新版本号。
      reload()
      if (result.active) {
        Object.assign(form, formFromRow(result.active))
      }
      return
    }
    modalOpen.value = false
    errorMessage.value = ''
    reload()
  } finally {
    submitting.value = false
  }
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const target = actionTargets[action]
  const result = advanceSluiceStatus(Number(row.id), target, Number(row.version))
  if (!result.ok) {
    errorMessage.value = result.message
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    let matched = listSluiceRows()
    const pairs = Object.entries(filters.value).filter(([, value]) => value.trim() !== '')
    if (pairs.length) {
      matched = matched.filter((row) =>
        pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
      )
    }
    rows.value = matched
    total.value = matched.length
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '拍门检修列表读取失败'
  }
}

watch(modalOpen, (open) => {
  if (!open) {
    formError.value = ''
  }
})

onMounted(reload)
</script>
