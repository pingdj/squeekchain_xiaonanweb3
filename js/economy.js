/* ============================================================
   Squeekchain Health Monitor - js/economy.js
   区块 4：SQK 经济 + 等级表 + 合并金字塔（/v1/economy/state）
   - 首次渲染 + 30 秒轮询
   - 处理 unavailable / 错误
   ============================================================ */

import { api } from './api.js';
import {
    toBig,
    esc,
    thousands,
    formatSqk,
    percent,
} from './format.js';

const POLL_INTERVAL_MS = 30000;   // 缓存 5 秒，30 秒轮询足够

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

/* ==================== 供应进度百分比（BigInt 计算） ==================== */
function calcPercent(minted, cap) {
    const m = toBig(minted);
    const c = toBig(cap);
    if (c === 0n) return 0;
    const scaled = (m * 10000n) / c;   // 保留 2 位小数
    return Number(scaled) / 100;
}

/* ==================== 主渲染 ==================== */
function render(result) {
    const lifecycleEl = document.getElementById('economyLifecycle');

    if (result.status === 'unavailable') {
        if (lifecycleEl) {
            lifecycleEl.textContent = 'Unavailable: ' + (result.reason || 'unknown');
            lifecycleEl.style.color = 'var(--yellow)';
        }
        clearEconomy();
        return;
    }

    const d = result.data || {};
    lastData = d;

    const supply = d.supply || {};
    const nft = d.nft || {};
    const lifecycle = d.lifecycle || {};

    /* ---------- 副标题：lifecycle ---------- */
    if (lifecycleEl) {
        const parts = [];
        if (lifecycle.stage) parts.push(lifecycle.stage);
        if (lifecycle.currentRound !== undefined && lifecycle.currentRound !== null) {
            parts.push('round #' + lifecycle.currentRound);
        }
        if (lifecycle.paused === true) {
            parts.push('paused');
        }
        lifecycleEl.textContent = parts.join(' · ') || '—';
        lifecycleEl.style.color = lifecycle.paused ? 'var(--red)' : 'var(--text-muted)';
    }

    /* ---------- 供应 ---------- */
    const minted = toBig(supply.totalMintedBaseUnits);
    const cap = toBig(supply.capBaseUnits);
    const remaining = toBig(supply.unmintedCapacityBaseUnits);

    setText('economyMinted', formatSqk(minted, 2));
    setText('economyCap', formatSqk(cap, 0));
    setText('economyRemaining', formatSqk(remaining, 2));

    const pct = calcPercent(minted, cap);
    setText('economySupplyPct', pct.toFixed(2) + '%');
    const bar = document.getElementById('economySupplyBar');
    if (bar) {
        bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
    }

    /* ---------- NFT 计数 ---------- */
    setText('economyNftIssued', thousands(String(toBig(nft.issued))));
    setText('economyNftBurned', thousands(String(toBig(nft.burned))));
    setText('economyNftLive', thousands(String(toBig(nft.live))));
    setText('economyMaxLevel', String(nft.maximumLevel !== undefined ? nft.maximumLevel : '—'));

    /* ---------- 等级表 ---------- */
    const basePower = Array.isArray(nft.basePower) ? nft.basePower : [];
    const cooldown = Array.isArray(nft.cooldownBlocks) ? nft.cooldownBlocks : [];

    if (basePower.length === 0) {
        setHtml('levelsTableBody',
            '<tr><td colspan="3" class="empty">No level data</td></tr>');
    } else {
        const rows = basePower.map((p, i) => {
            const level = i + 1;
            const power = toBig(p);
            const cd = cooldown.length > i ? toBig(cooldown[i]) : 0n;
            return (
                '<tr>' +
                    '<td>' + level + '</td>' +
                    '<td>' + thousands(power.toString()) + '</td>' +
                    '<td>' + (cd === 0n ? '—' : cd.toString()) + '</td>' +
                '</tr>'
            );
        }).join('');
        setHtml('levelsTableBody', rows);
    }

    /* ---------- 合并金字塔 ---------- */
    renderPyramid(basePower);
}

/* ==================== 合并金字塔 ==================== */
// 每级需要的 Level 1 数量 = 2^(level-1)
// L1=1, L2=2, L3=4, ..., L10=512
function renderPyramid(basePower) {
    const el = document.getElementById('pyramidChart');
    if (!el) return;

    if (!Array.isArray(basePower) || basePower.length === 0) {
        el.innerHTML = '<div class="empty">No level data</div>';
        return;
    }

    const maxLevel = basePower.length;
    // 从最高级往下渲染（顶部最窄，底部最宽）
    const levels = [];
    for (let lv = maxLevel; lv >= 1; lv--) {
        levels.push(lv);
    }

    const maxCount = Math.pow(2, maxLevel - 1);   // 最底层（L1）的数量

    const rows = levels.map(lv => {
        const count = Math.pow(2, lv - 1);         // 升到 L{lv} 需要的 L1 数量
        const widthPct = (count / maxCount) * 100; // 宽度按比例
        // 最少给 8% 宽度，避免高等级太窄看不见
        const w = Math.max(8, widthPct);

        return (
            '<div class="pyramid-level" style="width:' + w + '%;">' +
                '<span class="lv">L' + lv + '</span>' +
                '<span class="qty">' + thousands(String(count)) + ' × L1</span>' +
            '</div>'
        );
    }).join('');

    el.innerHTML = rows;
}

/* ==================== 清空 ==================== */
function clearEconomy() {
    setText('economyMinted', 'Unavailable');
    setText('economyCap', 'Unavailable');
    setText('economyRemaining', 'Unavailable');
    setText('economySupplyPct', 'Unavailable');
    setText('economyNftIssued', 'Unavailable');
    setText('economyNftBurned', 'Unavailable');
    setText('economyNftLive', 'Unavailable');
    setText('economyMaxLevel', 'Unavailable');

    const bar = document.getElementById('economySupplyBar');
    if (bar) bar.style.width = '0%';

    setHtml('levelsTableBody', '<tr><td colspan="3" class="empty">Unavailable</td></tr>');
    setHtml('pyramidChart', '<div class="empty">Unavailable</div>');
}

/* ==================== 单次拉取 ==================== */
async function pull() {
    try {
        const result = await api.economyState();
        render(result);
    } catch (e) {
        const lifecycleEl = document.getElementById('economyLifecycle');
        if (lifecycleEl) {
            lifecycleEl.textContent = 'Request failed: ' + e.message;
            lifecycleEl.style.color = 'var(--red)';
        }
        clearEconomy();
    }
}

/* ==================== 对外：启动 / 停止 ==================== */
export function startEconomy() {
    if (running) return;
    running = true;
    pull();
    timer = setInterval(pull, POLL_INTERVAL_MS);
}

export function stopEconomy() {
    if (!running) return;
    running = false;
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}

/* ==================== 对外：取最近一次数据 ==================== */
export function getLastEconomy() {
    return lastData;
}