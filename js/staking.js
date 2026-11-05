/* ============================================================
   Squeekchain Health Monitor - js/staking.js
   Block 5: Staking
   - Reads /v1/economy/state, extracts staking object
   - 30s poll (same endpoint as economy.js, in-flight dedup in api.js)
   ============================================================ */

import { api } from './api.js';
import {
    toBig,
    thousands,
    formatSqk,
    formatUnits,
    unixToLocal,
} from './format.js';

const POLL_INTERVAL_MS = 30000;

// Power is 18-decimal fixed point (same scale as SQK)
const POWER_UNIT = 10n ** 18n;

let timer = null;
let running = false;
let lastData = null;

/* ==================== 工具 ==================== */
function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

/* ==================== 清空 ==================== */
const ALL_IDS = [
    'stakingTotalStaked', 'stakingFreshPrincipal', 'stakingNftPower', 'stakingSqkPower',
    'stakingRewardsFunded', 'stakingRewardsPaid', 'stakingRewardsRemaining', 'stakingPaidPct',
    'stakingSqkPerPower', 'stakingReferencePower', 'stakingFreshUntilRound',
    'stakingStreamRate', 'stakingStreamEnds', 'stakingExitMin', 'stakingExitMax',
    'stakingExitSat', 'stakingExitWindow', 'stakingExitFloor',
];

function clearStaking() {
    ALL_IDS.forEach(id => setText(id, '—'));
    const bar = document.getElementById('stakingPaidBar');
    if (bar) bar.style.width = '0%';
}

/* ==================== 百分比（BigInt 整数） ==================== */
function calcPct(part, whole) {
    const p = toBig(part);
    const w = toBig(whole);
    if (w === 0n) return 0;
    const scaled = (p * 10000n) / w;
    return Number(scaled) / 100;
}

/* ==================== 主渲染 ==================== */
function render(result) {
    const subEl = document.getElementById('stakingStatus');

    if (result.status === 'unavailable') {
        if (subEl) {
            subEl.textContent = 'Unavailable: ' + (result.reason || 'unknown');
            subEl.style.color = 'var(--yellow)';
        }
        clearStaking();
        return;
    }

    const d = result.data || {};
    lastData = d;

    const staking = d.staking || null;

    // Staking not yet bound
    if (!staking) {
        if (subEl) {
            subEl.textContent = 'Not yet bound';
            subEl.style.color = 'var(--text-muted)';
        }
        clearStaking();
        return;
    }

    /* ---------- Subtitle: launch + paused ---------- */
    if (subEl) {
        const parts = [];
        parts.push(staking.launchReady ? 'launch ready' : 'launch pending');
        if (staking.paused === true) parts.push('paused');
        subEl.textContent = parts.join(' · ');
        subEl.style.color = staking.paused ? 'var(--red)' : 'var(--green)';
    }

    /* ---------- Top tiles ---------- */
    setText('stakingTotalStaked', formatSqk(staking.totalStakedBaseUnits, 2));
    setText('stakingFreshPrincipal', formatSqk(staking.freshPrincipalBaseUnits, 2));
    setText('stakingNftPower', thousands(formatUnits(staking.totalNftPower, POWER_UNIT, 0)));
    setText('stakingSqkPower', thousands(formatUnits(staking.totalSqkPower, POWER_UNIT, 0)));

    /* ---------- Yield Estimator Setup ---------- */
    const totalNftPower = Number(formatUnits(staking.totalNftPower, POWER_UNIT, 0)) || 0;
    const totalSqkPower = Number(formatUnits(staking.totalSqkPower, POWER_UNIT, 0)) || 0;
    
    // 将总权重挂载到全局，供 HTML 输入框直接调用
    window._totalStakingPower = totalNftPower + totalSqkPower;
    
    // 触发一次计算（更新页面上的数字）
    const wInput = document.getElementById('whatIfPower');
    if (wInput) {
        window.updateYieldEstimate(wInput.value);
    }

    /* ---------- Rewards ---------- */
    const rewards = staking.rewards || {};
    const funded = toBig(rewards.fundedBaseUnits);
    const paid = toBig(rewards.paidBaseUnits);
    const remaining = toBig(rewards.remainingBaseUnits);

    setText('stakingRewardsFunded', formatSqk(funded, 2));
    setText('stakingRewardsPaid', formatSqk(paid, 2));
    setText('stakingRewardsRemaining', formatSqk(remaining, 2));

    const paidPct = calcPct(paid, funded);
    setText('stakingPaidPct', paidPct.toFixed(2) + '%');
    const bar = document.getElementById('stakingPaidBar');
    if (bar) bar.style.width = Math.max(0, Math.min(100, paidPct)) + '%';

    /* ---------- Parameters ---------- */
    setText('stakingSqkPerPower', formatSqk(staking.sqkPerPower, 4));
    setText('stakingReferencePower', thousands(formatUnits(staking.referencePower, POWER_UNIT, 0)));

    const freshUntil = staking.freshUntilRound;
    setText('stakingFreshUntilRound',
        (freshUntil !== undefined && freshUntil !== null && String(freshUntil) !== '0')
            ? '#' + freshUntil
            : '—');

    const streamRate = toBig(rewards.streamRateBaseUnitsPerSecond);
    setText('stakingStreamRate',
        streamRate > 0n ? formatSqk(streamRate, 4) + ' /s' : 'inactive');

    const streamEnds = rewards.streamEndsAt;
    setText('stakingStreamEnds',
        (streamEnds !== undefined && streamEnds !== null && String(streamEnds) !== '0')
            ? unixToLocal(Number(streamEnds))
            : '—');

    /* ---------- Exit policy ---------- */
    const exit = staking.exitPolicy || {};
    setText('stakingExitMin',
        exit.minBps !== undefined ? (Number(exit.minBps) / 100).toFixed(2) + '%' : '—');
    setText('stakingExitMax',
        exit.maxBps !== undefined ? (Number(exit.maxBps) / 100).toFixed(2) + '%' : '—');
    setText('stakingExitSat',
        exit.saturationBps !== undefined ? (Number(exit.saturationBps) / 100).toFixed(2) + '%' : '—');
    setText('stakingExitWindow',
        exit.windowDays !== undefined ? exit.windowDays + ' day(s)' : '—');
    setText('stakingExitFloor',
        exit.pressureFloorBaseUnits !== undefined
            ? formatSqk(exit.pressureFloorBaseUnits, 2)
            : '—');
}

/* ==================== 全局收益计算函数（供 HTML oninput 调用） ==================== */
window.updateYieldEstimate = function(val) {
    const inputPower = Number(val) || 0;
    const res = document.getElementById('whatIfResult');
    if (!res) return;
    
    if (inputPower <= 0) { 
        res.textContent = '0.00'; 
        return; 
    }
    
    // 1 block per 10 mins = 144 blocks/day. 5600 SQK per block.
    const dailyMining = 144 * 5600; 
    const totalPower = window._totalStakingPower || 0;
    
    let share = 0;
    if (totalPower > 0) {
        share = inputPower / (totalPower + inputPower);
    } else {
        share = 1;
    }
    
    res.textContent = (dailyMining * share).toFixed(2);
};

/* ==================== 单次拉取 ==================== */
async function pull() {
    try {
        const result = await api.economyState();
        render(result);
    } catch (e) {
        const subEl = document.getElementById('stakingStatus');
        if (subEl) {
            subEl.textContent = 'Request failed: ' + e.message;
            subEl.style.color = 'var(--red)';
        }
        clearStaking();
    }
}

/* ==================== 对外 ==================== */
export function startStaking() {
    if (running) return;
    running = true;
    pull();
    timer = setInterval(pull, POLL_INTERVAL_MS);
}

export function stopStaking() {
    if (!running) return;
    running = false;
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}

export function getLastStaking() {
    return lastData;
}