/* ============================================================
   Squeekchain Health Monitor - js/settlements.js
   区块 5：结算历史（/v1/settlements?range=24h）
   - 首次渲染 + 60 秒轮询
   - 展示 summary / recentSettlements / recentCheckpoints
   - 处理 unavailable / 错误
   ============================================================ */

import { api } from './api.js';
import {
    esc,
    toBig,
    thousands,
    formatSqk,
    isoToLocal,
    timeAgo,
    blockscoutTx,
    shortAddr,
} from './format.js';

const POLL_INTERVAL_MS = 60000;   // 带 range 的响应缓存 60 秒
const RANGE = '24h';

let timer = null;
let running = false;
let lastData = null;

/* ==================== 工具 ==================== */
function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

function setHtml(id, html) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
}

/* ==================== 主渲染 ==================== */
function render(result) {
    const subEl = document.getElementById('settlementsSource');
    const summaryEl = document.getElementById('settlementsSummary');
    const listEl = document.getElementById('settlementsList');
    const cpEl = document.getElementById('checkpointsList');

    if (result.status === 'unavailable') {
        if (subEl) {
            subEl.textContent = 'Unavailable: ' + (result.reason || 'unknown');
            subEl.style.color = 'var(--yellow)';
        }
        if (summaryEl) {
            summaryEl.innerHTML = '<span style="color:var(--yellow)">Settlement data unavailable: ' +
                esc(result.reason || 'unknown') + '</span>';
        }
        if (listEl) listEl.innerHTML = '<div class="empty">Unavailable</div>';
        if (cpEl) cpEl.innerHTML = '<div class="empty">Unavailable</div>';
        return;
    }

    const d = result.data || {};
    lastData = d;

    const summary = d.summary || {};
    const recent = Array.isArray(d.recentSettlements) ? d.recentSettlements : [];
    const mining = d.mining || {};
    const checkpoints = Array.isArray(mining.recentCheckpoints) ? mining.recentCheckpoints : [];

    /* ---------- 副标题：range + mining.status ---------- */
    if (subEl) {
        const parts = ['range=' + RANGE];
        if (mining.status) parts.push('mining: ' + mining.status);
        if (mining.processedThroughRound !== undefined && mining.processedThroughRound !== null) {
            parts.push('processed round #' + mining.processedThroughRound);
        }
        subEl.textContent = parts.join(' · ');
        subEl.style.color = 'var(--text-muted)';
    }

    /* ---------- 摘要 ---------- */
    let summaryHtml = '';
    if (summary.settlementCount !== undefined) {
        summaryHtml +=
            '24h settlements <b>' + esc(String(summary.settlementCount)) + '</b> · ' +
            'active rounds <b>' + esc(String(summary.activeRoundCount || 0)) + '</b> · ' +
            'completed blocks <b>' + esc(String(summary.completedBlockCount || 0)) + '</b> · ' +
            'work added <b>' + esc(thousands(String(summary.workAdded || 0))) + '</b>';
    }

    if (mining.rangeMintedBaseUnits !== undefined && toBig(mining.rangeMintedBaseUnits) > 0n) {
        summaryHtml += ' · minted <b>' + esc(formatSqk(mining.rangeMintedBaseUnits, 2)) + '</b>';
    }
    if (mining.rangeCheckpointCount !== undefined && toBig(mining.rangeCheckpointCount) > 0n) {
        summaryHtml += ' · checkpoints <b>' + esc(String(mining.rangeCheckpointCount)) + '</b>';
    }
    if (mining.miningMintedBaseUnits !== undefined) {
        summaryHtml += '<br>Total minted <b>' + esc(formatSqk(mining.miningMintedBaseUnits, 2)) + '</b>';
    }

    if (summaryEl) summaryEl.innerHTML = summaryHtml || '—';

    /* ---------- 结算列表 ---------- */
    if (!listEl) return;

    if (!recent.length) {
        listEl.innerHTML = '<div class="empty">No settlements completed blocks in 24h</div>';
    } else {
        const rows = recent.map(s => {
            const throughRound = s.throughRound !== undefined
                ? s.throughRound
                : (s.settledThroughRound !== undefined ? s.settledThroughRound : '?');
            const fromRound = s.fromRound !== undefined ? s.fromRound : null;
            const rangeStr = (fromRound !== null && String(fromRound) !== String(throughRound))
                ? '#' + esc(String(fromRound)) + ' → #' + esc(String(throughRound))
                : 'through #' + esc(String(throughRound));

            // API 字段名可能是 completedBlockCount 或 completedBlocks
            const blocksRaw = s.completedBlocks !== undefined
                ? s.completedBlocks
                : (s.completedBlockCount !== undefined ? s.completedBlockCount : null);
            const blocks = blocksRaw !== null ? esc(String(blocksRaw)) : '—';
            const txHash = s.transactionHash || '';
            const txLink = txHash
                ? '<a href="' + esc(blockscoutTx(txHash)) + '" target="_blank" rel="noopener">' +
                    esc(shortAddr(txHash, 8, 6)) + '</a>'
                : '—';

            const timeStr = s.blockTimestamp
                ? esc(timeAgo(s.blockTimestamp))
                : '—';
            const timeTitle = s.blockTimestamp ? esc(isoToLocal(s.blockTimestamp)) : '';

            return (
                '<div class="settlement-row">' +
                    '<div class="settlement-rounds">' + rangeStr + '</div>' +
                    '<div class="settlement-info">' +
                        blocks + ' blocks' +
                        (s.activeRoundCount !== undefined ? ' · ' + esc(String(s.activeRoundCount)) + ' active rounds' : '') +
                        (s.workAdded !== undefined ? ' · work +' + esc(thousands(String(s.workAdded))) : '') +
                    '</div>' +
                    '<div class="settlement-link" title="' + timeTitle + '">' +
                        timeStr + ' · ' + txLink +
                    '</div>' +
                '</div>'
            );
        }).join('');
        let html = rows;
        if (summary.settlementCount !== undefined && Number(summary.settlementCount) > recent.length) {
            html += '<div class="empty" style="font-size:11px;">Showing latest ' + recent.length + ' of ' + summary.settlementCount + ' settlements</div>';
        }
        listEl.innerHTML = html;
    }

    /* ---------- Checkpoints ---------- */
    if (!cpEl) return;

    if (!checkpoints.length) {
        cpEl.innerHTML = '<div class="empty">No checkpoints yet</div>';
    } else {
        const cpRows = checkpoints.map(cp => {
            const after = cp.afterRound !== undefined ? cp.afterRound : (cp.fromRound !== undefined ? cp.fromRound : '?');
            const through = cp.throughRound !== undefined ? cp.throughRound : (cp.settledThroughRound !== undefined ? cp.settledThroughRound : '?');
            const rangeStr = '#' + esc(String(after)) + ' → #' + esc(String(through));

            const blocks = cp.completedBlockCount !== undefined ? esc(String(cp.completedBlockCount)) : '—';
            const amount = cp.amountBaseUnits !== undefined ? esc(formatSqk(cp.amountBaseUnits, 2)) : '—';
            const txHash = cp.transactionHash || '';
            const txLink = txHash
                ? '<a href="' + esc(blockscoutTx(txHash)) + '" target="_blank" rel="noopener">' +
                    esc(shortAddr(txHash, 8, 6)) + '</a>'
                : '—';

            const timeStr = cp.blockTimestamp
                ? esc(timeAgo(cp.blockTimestamp))
                : '';

            return (
                '<div class="checkpoint-row">' +
                    '<div class="checkpoint-rounds">' + rangeStr + '</div>' +
                    '<div class="checkpoint-info">' +
                        blocks + ' blocks · minted ' + amount +
                    '</div>' +
                    '<div class="checkpoint-link">' +
                        (timeStr ? timeStr + ' · ' : '') + txLink +
                    '</div>' +
                '</div>'
            );
        }).join('');
        cpEl.innerHTML = cpRows;
    }
}

/* ==================== 单次拉取 ==================== */
async function pull() {
    try {
        const result = await api.settlements(RANGE);
        render(result);
    } catch (e) {
        const subEl = document.getElementById('settlementsSource');
        if (subEl) {
            subEl.textContent = 'Request failed: ' + e.message;
            subEl.style.color = 'var(--red)';
        }
        const summaryEl = document.getElementById('settlementsSummary');
        if (summaryEl) summaryEl.innerHTML = '<span style="color:var(--red)">Request failed</span>';
        const listEl = document.getElementById('settlementsList');
        if (listEl) listEl.innerHTML = '<div class="empty">—</div>';
        const cpEl = document.getElementById('checkpointsList');
        if (cpEl) cpEl.innerHTML = '<div class="empty">—</div>';
    }
}

/* ==================== 对外：启动 / 停止 ==================== */
export function startSettlements() {
    if (running) return;
    running = true;
    pull();
    timer = setInterval(pull, POLL_INTERVAL_MS);
}

export function stopSettlements() {
    if (!running) return;
    running = false;
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}

/* ==================== 对外：取最近一次数据 ==================== */
export function getLastSettlements() {
    return lastData;
}