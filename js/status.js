/* ============================================================
   Squeekchain Health Monitor - js/status.js
   区块 1：仓鼠轮实时（/v1/status）
   - 首次渲染 + 5 秒轮询
   - 处理 unavailable / 错误
   ============================================================ */

import { api } from './api.js';
import {
    esc,
    freshnessLabel,
    queueStateLabel,
    oracleStateLabel,
    coreStatusLabel,
    isoToLocal,
    timeAgo,
    thousands,
} from './format.js';

const POLL_INTERVAL_MS = 5000;

let timer = null;
let running = false;
let lastData = null;

/* ==================== 工具：安全设置 textContent ==================== */
function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

/* ==================== 主渲染 ==================== */
function render(result) {
    const statusSub = document.getElementById('statusFreshness');

    if (result.status === 'unavailable') {
        if (statusSub) {
            statusSub.textContent = 'Unavailable: ' + (result.reason || 'unknown');
            statusSub.style.color = 'var(--yellow)';
        }
        clearWheelValues('Unavailable');
        return;
    }

    const d = result.data || {};
    lastData = d;

    const measurement = d.measurement || null;
    const builder = d.builder || {};
    const oracle = d.oracle || {};
    const queue = d.settlementQueue || {};

    // Top subtitle: measurement freshness
    if (statusSub) {
        const fresh = measurement ? freshnessLabel(measurement.freshness) : 'No Measurement';
        statusSub.textContent = fresh + (measurement && measurement.observedAt
            ? ' · observed ' + timeAgo(measurement.observedAt)
            : '');
        statusSub.style.color = (measurement && measurement.freshness === 'fresh')
            ? 'var(--green)'
            : (measurement && measurement.freshness === 'stale' ? 'var(--yellow)' : 'var(--text-muted)');
    }

    /* ---------- 6 个统计瓦片 ---------- */
    // 转速：rpmMilli 是千分之一 RPM
    const wheelEl = document.getElementById('hamsterWheel');
    if (measurement && measurement.rpmMilli !== undefined && measurement.rpmMilli !== null) {
        const rpm = Number(measurement.rpmMilli) / 1000;
        setText('wheelRpm', rpm.toFixed(2));
        
        // 动态控制轮子旋转
        if (wheelEl) {
            if (rpm > 0) {
                wheelEl.classList.add('spinning');
                // RPM 越快，转一圈需要的秒数越小
                const duration = Math.max(0.2, 60 / rpm);
                wheelEl.style.animationDuration = duration + 's';
            } else {
                wheelEl.classList.remove('spinning');
            }
        }
    } else {
        setText('wheelRpm', '—');
        if (wheelEl) wheelEl.classList.remove('spinning');
    }


    // 速度：speedMmPerSecond
    if (measurement && measurement.speedMmPerSecond !== undefined && measurement.speedMmPerSecond !== null) {
        setText('wheelSpeed', String(measurement.speedMmPerSecond));
    } else {
        setText('wheelSpeed', '—');
    }

    // 今日距离：distanceMm → 转为米显示（保留 1 位小数）
    if (measurement && measurement.distanceMm !== undefined && measurement.distanceMm !== null) {
        const meters = Number(measurement.distanceMm) / 1000;
        setText('wheelDistance', meters.toFixed(1));
    } else {
        setText('wheelDistance', '—');
    }

    // 设备状态
    if (measurement && measurement.coreStatus) {
        const el = document.getElementById('wheelCoreStatus');
        if (el) {
            el.textContent = coreStatusLabel(measurement.coreStatus);
            el.style.color = measurement.coreStatus === 'ACTIVE'
                ? 'var(--green)'
                : (measurement.coreStatus === 'COUNTER_FAULT' ? 'var(--red)' : 'var(--text-secondary)');
        }
    } else {
        setText('wheelCoreStatus', '—');
    }

    // 投影高度
    if (builder.projected && builder.projected.blockHeight !== undefined) {
        setText('wheelProjectedHeight', thousands(String(builder.projected.blockHeight)));
    } else if (builder.anchor && builder.anchor.blockHeight !== undefined) {
        setText('wheelProjectedHeight', thousands(String(builder.anchor.blockHeight)));
    } else {
        setText('wheelProjectedHeight', '—');
    }

    // 结算队列状态
    if (queue.state) {
        const el = document.getElementById('wheelQueueState');
        if (el) {
            el.textContent = queueStateLabel(queue.state);
            el.style.color = (queue.state === 'ready')
                ? 'var(--green)'
                : (queue.state === 'blocked' || queue.state === 'stale')
                    ? 'var(--red)'
                    : 'var(--text-secondary)';
        }
    } else {
        setText('wheelQueueState', '—');
    }

    /* ---------- 底部附加信息 ---------- */
    // Oracle 状态
    if (oracle.state) {
        const el = document.getElementById('wheelOracleState');
        if (el) {
            el.textContent = oracleStateLabel(oracle.state);
            el.style.color = oracle.state === 'accepted'
                ? 'var(--green)'
                : (oracle.state === 'blocked' || oracle.state === 'unavailable'
                    ? 'var(--red)' : 'var(--yellow)');
        }
    } else {
        setText('wheelOracleState', '—');
    }

    // 队列缓冲轮数
    if (queue.buffered && queue.buffered.roundCount !== undefined) {
        setText('wheelQueueBuffered', String(queue.buffered.roundCount));
    } else {
        setText('wheelQueueBuffered', '—');
    }

    // 测量来源（provenance）
    if (measurement && measurement.provenance) {
        setText('wheelProvenance', String(measurement.provenance));
    } else {
        setText('wheelProvenance', '—');
    }
}

/* ==================== 不可用 / 错误时清空为 "—" ==================== */
function clearWheelValues(reason) {
    setText('wheelRpm', reason);
    setText('wheelSpeed', reason);
    setText('wheelDistance', reason);
    setText('wheelCoreStatus', reason);
    setText('wheelProjectedHeight', reason);
    setText('wheelQueueState', reason);
    setText('wheelOracleState', reason);
    setText('wheelQueueBuffered', reason);
    setText('wheelProvenance', reason);
}

/* ==================== 单次拉取 ==================== */
async function pull() {
    try {
        const result = await api.status();
        render(result);
    } catch (e) {
        const statusSub = document.getElementById('statusFreshness');
        if (statusSub) {
            statusSub.textContent = 'Request failed: ' + e.message;
            statusSub.style.color = 'var(--red)';
        }
        clearWheelValues('—');
    }
}

/* ==================== 对外：启动 / 停止 ==================== */
export function startStatus() {
    if (running) return;
    running = true;
    pull();
    timer = setInterval(pull, POLL_INTERVAL_MS);
}

export function stopStatus() {
    if (!running) return;
    running = false;
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}

/* ==================== 对外：取当前最近一次数据（供 main.js 顶部条用） ==================== */
export function getLastStatus() {
    return lastData;
}