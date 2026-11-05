/* ============================================================
   Squeekchain Health Monitor - js/core.js
   区块 2：链上核心 + 结算延迟（/v1/core）
   - 首次渲染 + 5 秒轮询
   - 派生：当前轮次（链钟）、滞后轮次、下一块进度百分比
   - 处理 unavailable / 错误
   ============================================================ */

import { api } from './api.js';
import {
    toBig,
    thousands,
    formatBlockHeight,
    unixToLocal,
    timeAgo,
    esc,
} from './format.js';

const POLL_INTERVAL_MS = 5000;

// 滞后轮次颜色阈值（可调）
const LAG_OK_MAX = 10;        // 0–10 轮：绿
const LAG_WARN_MAX = 50;      // 11–50 轮：黄
                              // > 50 轮：红

let timer = null;
let running = false;
let lastData = null;

/* ==================== 工具 ==================== */
function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

function setColor(id, color) {
    const el = document.getElementById(id);
    if (el) el.style.color = color;
}

/* ==================== 滞后等级 ==================== */
function lagClass(lagNum) {
    if (lagNum <= LAG_OK_MAX) return 'lag-ok';
    if (lagNum <= LAG_WARN_MAX) return 'lag-warn';
    return 'lag-critical';
}

/* ==================== 主渲染 ==================== */
function render(result) {
    const subEl = document.getElementById('coreSafeBlock');

    if (result.status === 'unavailable') {
        if (subEl) {
            subEl.textContent = 'Unavailable: ' + (result.reason || 'unknown');
            subEl.style.color = 'var(--yellow)';
        }
        clearCoreValues('Unavailable');
        return;
    }

    const d = result.data || {};
    lastData = d;

    const config = d.configuration || {};
    const core = d.core || {};
    const chain = d.chain || {};
    const source = d.source || {};
    const implementation = d.implementation || {};

    // 顶部副标题：safeThroughBlock + 读取自哪个事件
    if (subEl) {
        const parts = [];
        if (chain.safeThroughBlock !== undefined) {
            parts.push('safe block #' + thousands(String(chain.safeThroughBlock)));
        }
        if (chain.safeBlockTimestamp) {
            parts.push(timeAgo(chain.safeBlockTimestamp));
        }
        if (source.eventName) {
            parts.push(source.eventName);
        }
        subEl.textContent = parts.join(' · ') || '—';
        subEl.style.color = 'var(--text-muted)';
    }

    /* ---------- 计算：当前轮次（链钟） ---------- */
    const genesis = toBig(config.genesisTimestamp);
    const roundDuration = toBig(config.roundDuration || 600);
    const settledRound = toBig(core.settledThroughRound);

    let currentRound = 0n;
    if (genesis > 0n && roundDuration > 0n) {
        const now = BigInt(Math.floor(Date.now() / 1000));
        if (now >= genesis) {
            currentRound = (now - genesis) / roundDuration + 1n;
        }
    }

    /* ---------- 计算：滞后轮次 ---------- */
    let lagRounds = 0n;
    if (currentRound > 0n && settledRound >= 0n) {
        lagRounds = currentRound > settledRound ? (currentRound - settledRound) : 0n;
    }
    const lagNum = Number(lagRounds);

    /* ---------- 渲染：滞后卡片 ---------- */
    const lagWrap = document.getElementById('coreLagWrap');
    if (lagWrap) {
        // 清掉旧的 lag-ok / lag-warn / lag-critical
        lagWrap.classList.remove('lag-ok', 'lag-warn', 'lag-critical');
        lagWrap.classList.add(lagClass(lagNum));
    }
    setText('coreLagRounds', lagNum.toString());

    // 情感化提示
    const lagLabelEl = document.getElementById('coreLagLabel');
    if (lagLabelEl) {
        if (lagNum === 0) {
            lagLabelEl.innerHTML = 'Rounds Behind<br><span style="font-size:10px;color:var(--green)">🐹 Full speed!</span>';
        } else if (lagNum <= 5) {
            lagLabelEl.innerHTML = 'Rounds Behind<br><span style="font-size:10px;color:var(--yellow)">⏳ Catching up...</span>';
        } else {
            lagLabelEl.innerHTML = 'Rounds Behind<br><span style="font-size:10px;color:var(--red)">⚠️ Hamsters tired</span>';
        }
    }

    /* ---------- 渲染：核心字段 ---------- */
    setText('coreSettledRound', thousands(settledRound.toString()));
    setText('coreCurrentRound', currentRound > 0n ? thousands(currentRound.toString()) : '—');

    const blockHeight = toBig(core.blockHeight);
    setText('coreBlockHeight', thousands(blockHeight.toString()));

    const difficulty = toBig(core.workPerThousandBlocks);
    setText('coreDifficulty', thousands(difficulty.toString()));

    const cumulativeWork = toBig(core.cumulativeWork);
    setText('coreCumulativeWork', thousands(cumulativeWork.toString()));

    /* ---------- 下一块进度 ---------- */
    const blockProgress = toBig(core.blockProgress);
    const blockUnitsPerBlock = toBig(config.blockUnitsPerBlock || 1_000_000_000);

    let progressPct = 0;
    if (blockUnitsPerBlock > 0n) {
        // 保留 2 位小数：progress * 10000 / units / 100
        const scaled = (blockProgress * 10000n) / blockUnitsPerBlock;
        progressPct = Number(scaled) / 100;
    }
    setText('coreBlockProgressPct', progressPct.toFixed(2) + '%');

    const bar = document.getElementById('coreBlockProgressBar');
    if (bar) {
        const clamped = Math.max(0, Math.min(100, progressPct));
        bar.style.width = clamped + '%';
    }

    /* ---------- 底部元信息 ---------- */
    setText('coreGenesis',
        config.genesisTimestamp
            ? unixToLocal(config.genesisTimestamp)
            : '—');

    setText('coreRoundDuration',
        config.roundDuration !== undefined
            ? String(config.roundDuration)
            : '—');

    const maxWork = toBig(config.maxWorkPerRound);
    setText('coreMaxWork', thousands(maxWork.toString()));

    const pausedEl = document.getElementById('corePaused');
    if (pausedEl) {
        const paused = !!core.paused;
        pausedEl.textContent = paused ? 'Yes' : 'No';
        pausedEl.style.color = paused ? 'var(--red)' : 'var(--green)';
    }

    /* ---------- 同步到顶部条（可选，main.js 会直接读 lastData） ---------- */
    updateTopBar(currentRound, blockHeight, core.paused);
}

/* ==================== 更新顶部条 ==================== */
function updateTopBar(currentRound, blockHeight, paused) {
    const cr = document.getElementById('currentRound');
    if (cr) cr.textContent = currentRound > 0n ? thousands(currentRound.toString()) : '—';

    const bh = document.getElementById('topBlockHeight');
    if (bh) bh.textContent = thousands(blockHeight.toString());

    const pp = document.getElementById('topPaused');
    if (pp) {
        pp.textContent = paused ? 'Yes' : 'No';
        pp.style.color = paused ? 'var(--red)' : 'var(--green)';
    }
}

/* ==================== 清空为占位 ==================== */
function clearCoreValues(reason) {
    setText('coreLagRounds', reason);
    setText('coreSettledRound', reason);
    setText('coreCurrentRound', reason);
    setText('coreBlockHeight', reason);
    setText('coreDifficulty', reason);
    setText('coreCumulativeWork', reason);
    setText('coreBlockProgressPct', reason);
    setText('coreGenesis', reason);
    setText('coreRoundDuration', reason);
    setText('coreMaxWork', reason);
    setText('corePaused', reason);

    const bar = document.getElementById('coreBlockProgressBar');
    if (bar) bar.style.width = '0%';

    const lagWrap = document.getElementById('coreLagWrap');
    if (lagWrap) {
        lagWrap.classList.remove('lag-ok', 'lag-warn', 'lag-critical');
    }
}

/* ==================== 单次拉取 ==================== */
async function pull() {
    try {
        const result = await api.core();
        render(result);
    } catch (e) {
        const subEl = document.getElementById('coreSafeBlock');
        if (subEl) {
            subEl.textContent = 'Request failed: ' + e.message;
            subEl.style.color = 'var(--red)';
        }
        clearCoreValues('—');
    }
}

/* ==================== 对外：启动 / 停止 ==================== */
export function startCore() {
    if (running) return;
    running = true;
    pull();
    timer = setInterval(pull, POLL_INTERVAL_MS);
}

export function stopCore() {
    if (!running) return;
    running = false;
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}

/* ==================== 对外：取最近一次数据 ==================== */
export function getLastCore() {
    return lastData;
}

/* ==================== 对外：当前滞后阈值（供 UI 提示文案用） ==================== */
export function getLagThresholds() {
    return {
        okMax: LAG_OK_MAX,
        warnMax: LAG_WARN_MAX,
    };
}