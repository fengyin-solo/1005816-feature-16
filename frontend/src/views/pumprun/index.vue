<template>
  <section class="page" data-module="pumprun">
    <header class="page-head">
      <div>
        <h2>泵组运行管理</h2>
        <p class="page-desc">维护泵组运行记录，围绕运行编号、所属泵站、泵组编号、运行电流做登记、筛选与状态流转。</p>
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

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'ledger-row': isLedgerRow(row) }">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            {{ row.status }}
            <span v-if="isLedgerRow(row)" class="tag tag-ledger">待更换台账·以检修记录为准</span>
          </td>
          <td class="row-actions">
            <template v-if="!isLedgerRow(row)">
              <button
                v-for="action in actions"
                :key="action"
                class="link"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
            </template>
            <span v-else class="muted-text">由拍门检修记录生成</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无泵组运行数据，可先登记泵组运行记录</td>
        </tr>
      </tbody>
    </table>

    <div class="ledger-panel">
      <h3>待更换台账（拍门检修联动）</h3>
      <p class="page-desc">拍门被判定为「需更换」后自动落入此台账；拍门状态与泵组运行对不上时，以拍门检修记录为准。</p>
      <table class="data-table">
        <thead>
          <tr>
            <th>所属泵站</th>
            <th>拍门/泵组编号</th>
            <th>提报检修人</th>
            <th>入台账时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in ledgerRows" :key="String(row.id)">
            <td>{{ row['所属泵站'] }}</td>
            <td>{{ row['泵组编号'] }}</td>
            <td>{{ row['值班人'] || '—' }}</td>
            <td>{{ formatStamp(String(row['提报时间'] ?? '')) }}</td>
          </tr>
          <tr v-if="!ledgerRows.length">
            <td colspan="4" class="empty-state">暂无待更换拍门</td>
          </tr>
        </tbody>
      </table>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条泵组运行记录，其中 {{ ledgerRows.length }} 条待更换台账由拍门检修记录对账生成</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  runAction as applyAction,
} from '@/api/local-service'
import {
  formatStamp,
  isLedgerRow,
  listPumprunReconciled,
} from '@/api/sluice-service'
import type { EntryRow } from '@/data/types'

const columns = ["运行编号", "所属泵站", "泵组编号", "运行电流", "出水流量", "值班人", "记录时间", "运行状态"]
const actions = ["提交开机", "登记停机", "上报故障"]
const statuses = ["待开机", "运行中", "已停机", "故障停机", "待更换"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const ledgerRows = computed(() => rows.value.filter((row) => isLedgerRow(row)))
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const stats = computed(() => [
  { label: "运行中泵组", value: rows.value.filter((row) => row.status === '运行中' && !isLedgerRow(row)).length },
  { label: "已停机泵组", value: rows.value.filter((row) => row.status === '已停机' && !isLedgerRow(row)).length },
  { label: "故障停机泵组", value: rows.value.filter((row) => row.status === '故障停机' && !isLedgerRow(row)).length },
  { label: "待更换拍门", value: ledgerRows.value.length },
])

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries('pumprun')
}

function openCreate() {
  errorMessage.value = '泵组运行记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  if (isLedgerRow(row)) {
    errorMessage.value = '待更换台账行以拍门检修记录为准，不能在泵组运行里直接改'
    return
  }
  const result = applyAction('pumprun', Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    // 读取前先对账：拍门状态改完的结果随时落回待更换台账，冲突时以检修记录为准。
    let matched = listPumprunReconciled()
    const pairs = Object.entries(filters.value).filter(([, value]) => value.trim() !== '')
    if (pairs.length) {
      matched = matched.filter((row) =>
        pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
      )
    }
    rows.value = matched
    total.value = matched.length
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '泵组运行列表读取失败'
  }
}

onMounted(reload)
</script>
