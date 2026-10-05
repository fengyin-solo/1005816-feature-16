<template>
  <section class="page" data-module="pumprun">
    <header class="page-head">
      <div>
        <h2>泵组运行管理</h2>
        <p class="page-desc">维护泵组运行记录；拍门检修判定需更换的拍门自动进入下方「拍门待更换台账」，拍门恢复正常后台账关闭。两边状态对不上时以拍门检修记录为准。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记泵组运行记录</button>
        <button class="btn" type="button" @click="exportRows">导出泵组运行清单</button>
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

    <h3 class="section-title">泵组运行记录</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in runRows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
          <td>{{ row.status }}</td>
        </tr>
        <tr v-if="!runRows.length">
          <td :colspan="columns.length + 1" class="empty-state">暂无泵组运行数据</td>
        </tr>
      </tbody>
    </table>

    <div class="ledger-head">
      <h3 class="section-title">拍门待更换台账</h3>
      <label class="ledger-switch">
        <input v-model="showClosedLedger" type="checkbox" @change="reload" />
        含已关闭历史
      </label>
    </div>
    <table class="data-table ledger-table">
      <thead>
        <tr>
          <th v-for="column in ledgerColumns" :key="column">{{ column }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in ledgerViewRows" :key="String(row.id)" :class="{ 'ledger-closed': row.台账状态 !== '待更换' }">
          <td v-for="column in ledgerColumns" :key="column">{{ row[column] || '—' }}</td>
        </tr>
        <tr v-if="!ledgerViewRows.length">
          <td :colspan="ledgerColumns.length" class="empty-state">暂无待更换拍门，台账为空</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ runRows.length }} 条泵组运行记录 · 待更换拍门 {{ openLedgerRows.length }} 台</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import { reconcileLedger } from '@/api/sluice-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('pumprun')
const columns = ["运行编号", "所属泵站", "泵组编号", "运行电流", "出水流量", "值班人", "记录时间", "运行状态"]
const ledgerColumns = ["运行编号", "所属泵站", "拍门编号", "检修编号", "值班人", "记录时间", "台账状态", "关闭时间"]
const statuses = ["待开机", "运行中", "已停机", "故障停机"]

const rows = ref<EntryRow[]>([])
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const showClosedLedger = ref(false)

function isLedger(row: EntryRow): boolean {
  return String(row.台账类型 ?? '') === '拍门待更换台账'
}

const runRows = computed(() => {
  const pairs = Object.entries(filters.value).filter(([, value]) => value.trim() !== '')
  return rows.value
    .filter((row) => !isLedger(row))
    .filter((row) =>
      pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
    )
})

const ledgerRows = computed(() => rows.value.filter((row) => isLedger(row)))
const openLedgerRows = computed(() => ledgerRows.value.filter((row) => String(row.台账状态) === '待更换'))
const ledgerViewRows = computed(() =>
  showClosedLedger.value
    ? ledgerRows.value
    : ledgerRows.value.filter((row) => String(row.台账状态) === '待更换'),
)

const stats = computed(() => [
  { label: '运行中泵组', value: runRows.value.filter((row) => String(row.status) === '运行中').length },
  { label: '已停机泵组', value: runRows.value.filter((row) => String(row.status) === '已停机').length },
  { label: '故障停机泵组', value: runRows.value.filter((row) => String(row.status) === '故障停机').length },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: runRows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '泵组运行记录登记入口尚未接入审批流'
}

function reload() {
  errorMessage.value = ''
  try {
    // 进页面/刷新先按拍门检修记录对账台账，再读取泵组运行数据。
    reconcileLedger()
    rows.value = listEntries(meta.key).items
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '泵组运行列表读取失败'
  }
}

onMounted(reload)
</script>
