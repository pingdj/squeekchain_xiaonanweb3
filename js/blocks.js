/* ============================================================
   Squeekchain Health Monitor - js/blocks.js
   区块 3：临时块投影（/v1/measurement/blocks）
   - 首次渲染 + 10 秒轮询
   - 展示最近完成的临时块 + 下一块还差多少 work
   - 处理 unavailable / 错误
   ============================================================ */

import { api } from './api.js';
import {
    esc,
    thousands,
    isoToLocal,
    timeAgo,
    freshnessLabel,
} from './format.js';

const POLL_INTERVAL_MS = 10000;   // observations 类限流 2/s，10 秒安全
const MAX_ROWS = 20;

let timer = null;
let running = false;
let lastData = null;

/* ==================== 工具 ==================== */
function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

/* ==================== 主渲染 ==================== */
function render(result) {
    const subEl = document.getElementById('blocksStatus');
    const summaryEl = document.getElementById('blocksSummary');
    const listEl = document.getElementById('blocksList');

    if (!listEl) return;

    if (result.status === 'unavailable') {
        if (subEl) {
            subEl.textContent = 'Unavailable: ' + (result.reason || 'unknown');
            subEl.style.color = 'var(--yellow)';
        }
        if (summaryEl) {
            summaryEl.innerHTML = '<span style="color:var(--yellow)">' +
                esc('Provisional blocks unavailable: ' + (result.reason || 'unknown')) + '</span>';
        }
        listEl.innerHTML = '<div class="empty">Unavailable</div>';
        return;
    }

    const d = result.data || {};
    lastData = d;

    // 副标题：新鲜度 + 状态
    if (subEl) {
        const fresh = freshnessLabel(d.freshness);
        subEl.textContent = fresh;
        subEl.style.color = d.freshness === 'fresh'
            ? 'var(--green)'
            : d.freshness === 'stale' ? 'var(--yellow)' : 'var(--text-muted)';
    }

    /* ---------- 摘要区 ---------- */
    const anchor = d.anchor || {};
    const projected = d.projected || {};

    let summaryHtml = '';
    if (anchor.blockHeight !== undefined && projected.blockHeight !== undefined) {
        const ahead = Number(projected.blockHeight) - Number(anchor.blockHeight);
        summaryHtml =
            'Settled <b>#' + esc(thousands(String(anchor.blockHeight))) + '</b>' +
            ' → projected <b>#' + esc(thousands(String(projected.blockHeight))) + '</b>' +
            ' (<b>' + ahead + '</b> ahead)';
    } else if (projected.blockHeight !== undefined) {
        summaryHtml = 'Projected height <b>#' + esc(thousands(String(projected.blockHeight))) + '</b>';
    } else {
        summaryHtml = '—';
    }

    if (projected.workPerThousandBlocks !== undefined) {
        summaryHtml += ' · projected difficulty <b>' + esc(thousands(String(projected.workPerThousandBlocks))) + '</b>';
    }

    if (d.observedAt) {
        summaryHtml += ' · observed ' + esc(timeAgo(d.observedAt));
    }

    if (summaryEl) summaryEl.innerHTML = summaryHtml;

    /* ---------- 块列表 ---------- */
    const blocks = Array.isArray(d.blocks) ? d.blocks : [];
    if (!blocks.length) {
        const ahead = (projected.blockHeight !== undefined && anchor.blockHeight !== undefined)
            ? Number(projected.blockHeight) - Number(anchor.blockHeight)
            : 0;
        const progress = projected.blockProgress !== undefined
            ? (Number(projected.blockProgress) / 1_000_000_000 * 100).toFixed(1)
            : null;
        let msg = 'No provisional blocks.';
        if (ahead === 0) {
            msg += ' Settlement is caught up with the projected work.';
        } else {
            msg += ' Projected is ' + ahead + ' block(s) ahead of settlement.';
        }
        if (progress !== null) {
            msg += ' Next block progress: ' + progress + '%.';
        }
        listEl.innerHTML = '<div class="empty">' + esc(msg) + '</div>';
        return;
    }

    const rows = blocks.slice(0, MAX_ROWS).map(b => {
        const height = b.height !== undefined ? esc(String(b.height)) : '—';
        const threshold = b.workThreshold !== undefined ? esc(thousands(String(b.workThreshold))) : '—';
        const roundId = b.roundId !== undefined ? esc('round #' + b.roundId) : '';

        // Completion time: prefer completingAt, else placeholder
        let timeStr = '';
        let timeTitle = '';
        if (b.completingAt) {
            timeStr = esc(timeAgo(b.completingAt));
            timeTitle = esc(isoToLocal(b.completingAt));
        } else {
            timeStr = '<span style="color:var(--text-muted)">unknown</span>';
        }

        return (
            '<div class="block-row">' +
                '<div class="block-height">#' + height + '</div>' +
                '<div class="block-threshold" title="workThreshold">work ≥ ' + threshold +
                    (roundId ? ' · ' + roundId : '') +
                '</div>' +
                '<div class="block-round" title="' + timeTitle + '">' + timeStr + '</div>' +
            '</div>'
        );
    }).join('');

    let html = rows;
    if (blocks.length > MAX_ROWS) {
        html += '<div class="empty">Showing latest ' + MAX_ROWS + ' of ' + blocks.length + '</div>';
    }
    listEl.innerHTML = html;
}

/* ==================== 单次拉取 ==================== */
async function pull() {
    try {
        const result = await api.measurementBlocks();
        render(result);
    } catch (e) {
        const subEl = document.getElementById('blocksStatus');
        if (subEl) {
            subEl.textContent = 'Request failed: ' + e.message;
            subEl.style.color = 'var(--red)';
        }
        const summaryEl = document.getElementById('blocksSummary');
        if (summaryEl) summaryEl.innerHTML = '<span style="color:var(--red)">Request failed</span>';
        const listEl = document.getElementById('blocksList');
        if (listEl) listEl.innerHTML = '<div class="empty">—</div>';
    }
}

/* ==================== 对外：启动 / 停止 ==================== */
export function startBlocks() {
    if (running) return;
    running = true;
    pull();
    timer = setInterval(pull, POLL_INTERVAL_MS);
}

export function stopBlocks() {
    if (!running) return;
    running = false;
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}

/* ==================== 对外：取最近一次数据 ==================== */
export function getLastBlocks() {
    return lastData;
}