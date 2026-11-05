/* ============================================================
   Squeekchain Health Monitor - js/stats.js
   区块 7：测量统计（/v1/measurement/stats?range=7d|30d）
   - 点击加载，不自动轮询
   - 两个 Chart.js 图：每日活跃 work / 每日距离
   - 展示 lifetime 和 activity.summary 摘要
   - 处理 unavailable / 错误
   - 缓存 60 秒，同一 range 60 秒内不重复拉取
   ============================================================ */

import { api } from './api.js';
import {
    esc,
    toBig,
    thousands,
    percent,
    timeAgo,
} from './format.js';

const CACHE_TTL_MS = 60000;   // 文档：带 range 的响应缓存 60 秒

// Chart.js 实例（避免重复创建）
let chartActivity = null;
let chartDistance = null;

// 缓存：{ '7d': { ts, data }, '30d': { ts, data } }
const cache = {};
let currentRange = null;
let loading = false;

/* ==================== 工具 ==================== */
function setHtml(id, html) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
}

function show(el, visible) {
    if (!el) return;
    el.style.display = visible ? '' : 'none';
}

/* ==================== Chart.js 默认样式 ==================== */
const CHART_COLORS = {
    gold: 'rgba(251, 191, 36, 0.85)',
    goldFill: 'rgba(251, 191, 36, 0.15)',
    blue: 'rgba(59, 130, 246, 0.85)',
    blueFill: 'rgba(59, 130, 246, 0.15)',
    grid: 'rgba(31, 42, 61, 0.8)',
    text: '#8b9bb4',
};

function baseChartOptions(yTitle) {
    return {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
            legend: { display: false },
            tooltip: {
                backgroundColor: 'rgba(17, 24, 39, 0.95)',
                borderColor: '#2d3d57',
                borderWidth: 1,
                titleColor: '#e5ecf5',
                bodyColor: '#cbd5e1',
                padding: 10,
                displayColors: false,
            },
        },
        scales: {
            x: {
                grid: { color: CHART_COLORS.grid, drawBorder: false },
                ticks: {
                    color: CHART_COLORS.text,
                    font: { size: 10, family: 'Consolas, monospace' },
                    maxRotation: 0,
                    autoSkip: true,
                    maxTicksLimit: 10,
                },
            },
            y: {
                grid: { color: CHART_COLORS.grid, drawBorder: false },
                ticks: {
                    color: CHART_COLORS.text,
                    font: { size: 10, family: 'Consolas, monospace' },
                    callback: (v) => {
                        if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(1) + 'B';
                        if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + 'M';
                        if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + 'K';
                        return v;
                    },
                },
                title: yTitle ? {
                    display: true,
                    text: yTitle,
                    color: CHART_COLORS.text,
                    font: { size: 11 },
                } : undefined,
            },
        },
    };
}

/* ==================== 销毁旧图表 ==================== */
function destroyCharts() {
    if (chartActivity) { chartActivity.destroy(); chartActivity = null; }
    if (chartDistance) { chartDistance.destroy(); chartDistance = null; }
}

/* ==================== 渲染图表 ==================== */
function renderCharts(days) {
    if (typeof Chart === 'undefined') {
        const hintEl = document.getElementById('statsHint');
        if (hintEl) {
            hintEl.style.display = '';
            hintEl.textContent = 'Chart.js failed to load. Check network or swap CDN in index.html.';
            hintEl.style.color = 'var(--red)';
        }
        return;
    }

    const labels = days.map(d => d.date || '');
    const workData = days.map(d => Number(toBig(d.observedWorkUnits)));
    const distData = days.map(d => Number(toBig(d.distanceMm)) / 1000);   // mm → m

    // ---------- 活跃 work ----------
    const canvasA = document.getElementById('chartActivity');
    if (canvasA) {
        destroyIfExists('activity');
        chartActivity = new Chart(canvasA.getContext('2d'), {
            type: 'bar',
            data: {
                labels,
                datasets: [{
                    data: workData,
                    backgroundColor: CHART_COLORS.gold,
                    borderColor: 'rgba(251, 191, 36, 1)',
                    borderWidth: 1,
                    borderRadius: 3,
                }],
            },
            options: baseChartOptions('work units'),
        });
    }

    // ---------- Daily distance ----------
    const canvasD = document.getElementById('chartDistance');
    if (canvasD) {
        destroyIfExists('distance');
        chartDistance = new Chart(canvasD.getContext('2d'), {
            type: 'line',
            data: {
                labels,
                datasets: [{
                    data: distData,
                    borderColor: CHART_COLORS.blue,
                    backgroundColor: CHART_COLORS.blueFill,
                    borderWidth: 2,
                    pointRadius: 2,
                    pointHoverRadius: 4,
                    fill: true,
                    tension: 0.25,
                }],
            },
            options: baseChartOptions('meters (m)'),
        });
    }
}

function destroyIfExists(which) {
    if (which === 'activity' && chartActivity) {
        chartActivity.destroy();
        chartActivity = null;
    }
    if (which === 'distance' && chartDistance) {
        chartDistance.destroy();
        chartDistance = null;
    }
}

/* ==================== 渲染摘要 ==================== */
function renderSummary(d) {
    const lifetime = d.lifetime || {};
    const summary = (d.activity && d.activity.summary) || {};
    const coverage = (d.activity && d.activity.coverage) || {};

    // Lifetime tiles
    const lifetimeHtml =
        '<div class="stat-tile"><div class="stat-label">Lifetime Work</div><div class="stat-value">' +
            esc(thousands(String(toBig(lifetime.acceptedWorkUnits)))) + '</div></div>' +
        '<div class="stat-tile"><div class="stat-label">Lifetime Distance</div><div class="stat-value">' +
            esc((Number(toBig(lifetime.observedDistanceMm)) / 1000).toFixed(1)) + ' m</div></div>' +
        '<div class="stat-tile"><div class="stat-label">Active Days</div><div class="stat-value">' +
            esc(String(lifetime.activeDayCount || 0)) + '</div></div>' +
        '<div class="stat-tile"><div class="stat-label">Settlements</div><div class="stat-value">' +
            esc(String(lifetime.settlementCount || 0)) + '</div></div>';

    // Window coverage
    let coverageHtml = '';
    if (coverage.coverageBps !== undefined) {
        const pct = (Number(coverage.coverageBps) / 100).toFixed(1);
        coverageHtml =
            '<div style="font-size:12px;color:var(--text-secondary);margin-top:8px;">' +
                'Window coverage: <b style="color:var(--gold);font-family:var(--font-mono);">' + esc(pct) + '%</b>' +
                (coverage.complete === true ? ' · complete' : ' · partial') +
            '</div>';
    }

    // Most active day
    let peakHtml = '';
    if (summary.mostActiveDate) {
        peakHtml =
            '<div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">' +
                'Most active day: <b>' + esc(String(summary.mostActiveDate)) + '</b>' +
            '</div>';
    }

    setHtml('statsSummary', lifetimeHtml + coverageHtml + peakHtml);
}

/* ==================== 主渲染 ==================== */
function render(result, range) {
    const chartsEl = document.getElementById('statsCharts');
    const hintEl = document.getElementById('statsHint');

    if (result.status === 'unavailable') {
        destroyCharts();
        show(chartsEl, false);
        if (hintEl) {
            hintEl.style.display = '';
            hintEl.textContent = 'Stats unavailable: ' + (result.reason || 'unknown');
            hintEl.style.color = 'var(--yellow)';
        }
        return;
    }

    const d = result.data || {};
    const days = (d.activity && Array.isArray(d.activity.days)) ? d.activity.days : [];

    if (!days.length) {
        destroyCharts();
        show(chartsEl, false);
        if (hintEl) {
            hintEl.style.display = '';
            hintEl.textContent = 'No stats data';
            hintEl.style.color = 'var(--text-muted)';
        }
        return;
    }

    show(chartsEl, true);
    if (hintEl) hintEl.style.display = 'none';

    renderCharts(days);
    renderSummary(d);
}

/* ==================== 加载 ==================== */
async function load(range) {
    if (loading) return;

    const chartsEl = document.getElementById('statsCharts');
    const hintEl = document.getElementById('statsHint');

    // 缓存命中
    const cached = cache[range];
    if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
        currentRange = range;
        render(cached.result, range);
        return;
    }

    loading = true;
    currentRange = range;

    if (hintEl) {
        hintEl.style.display = '';
        hintEl.textContent = 'Loading ' + range + ' data…';
        hintEl.style.color = 'var(--text-muted)';
    }
    show(chartsEl, false);

    try {
        const result = await api.measurementStats(range);
        cache[range] = { ts: Date.now(), result };
        // If user clicked another range while loading, only render the current one
        if (currentRange === range) {
            render(result, range);
        }
    } catch (e) {
        if (currentRange === range) {
            destroyCharts();
            show(chartsEl, false);
            if (hintEl) {
                hintEl.style.display = '';
                hintEl.textContent = 'Request failed: ' + e.message;
                hintEl.style.color = 'var(--red)';
            }
        }
    } finally {
        loading = false;
    }
}

/* ==================== 按钮绑定 ==================== */
function bindButtons() {
    const buttons = document.querySelectorAll('[data-stats-range]');
    buttons.forEach(btn => {
        if (btn.dataset.bound === '1') return;
        btn.dataset.bound = '1';
        btn.addEventListener('click', function () {
            const range = this.dataset.statsRange;
            if (!range) return;
            load(range);
        });
    });
}

/* ==================== 对外：启动 / 停止 ==================== */
export function startStats() {
    bindButtons();
    // 不自动加载，等用户点按钮
}

export function stopStats() {
    // 无轮询，无需清理；但销毁图表实例防止内存泄漏
    destroyCharts();
}

/* ==================== 对外：清空缓存 ==================== */
export function clearStatsCache() {
    Object.keys(cache).forEach(k => delete cache[k]);
}