/* ============================================================
   Squeekchain Health Monitor - js/main.js
   Entry: init, start all modules, top health check, query tab switching
   - Visibility control (pause polling when hidden, resume when visible)
   - API health check (via /v1/status + /v1/core, every 30s)
   - Last refresh clock
   ============================================================ */
import { api } from './api.js';
import { unixToLocal } from './format.js';

import { startStatus, stopStatus } from './status.js';
import { startCore, stopCore } from './core.js';
import { startBlocks, stopBlocks } from './blocks.js';
import { startEconomy, stopEconomy } from './economy.js';
import { startSettlements, stopSettlements } from './settlements.js';
import { startStaking, stopStaking } from './staking.js';
import { startEvents, stopEvents } from './events.js';
import { startStats, stopStats } from './stats.js';
import { startAccount, stopAccount } from './account.js';
import { startSqueek, stopSqueek } from './squeek.js';
/* ==================== Top health check ==================== */
// Do NOT call /healthz or /readyz directly (no CORS on those, browser blocks them).
// Reuse the responses from /v1/status and /v1/core (already polled by the page):
//   both status:'ok'          → green dot  "API OK"
//   any status:'unavailable'  → yellow dot "API backend unavailable"
//   request throws (network)  → red dot    "API unreachable"
const HEALTH_INTERVAL_MS = 30000;
let healthTimer = null;
let healthRunning = false;

function setHealthDot(state, text) {
    const dot = document.getElementById('apiHealthDot');
    const txt = document.getElementById('apiHealthText');
    if (dot) {
        dot.classList.remove('dot-gray', 'dot-green', 'dot-red', 'dot-yellow');
        dot.classList.add(
            state === 'ok' ? 'dot-green' :
            state === 'degraded' ? 'dot-yellow' :
            state === 'down' ? 'dot-red' : 'dot-gray'
        );
    }
    if (txt) txt.textContent = text;
}

async function checkHealth() {
    if (!healthRunning) return;

    try {
        const [statusRes, coreRes] = await Promise.all([
            api.status(),
            api.core(),
        ]);

        const statusOk = statusRes && statusRes.status === 'ok';
        const coreOk = coreRes && coreRes.status === 'ok';

        if (statusOk && coreOk) {
            setHealthDot('ok', 'API OK');
        } else {
            // At least one returned status:'unavailable' — API process alive but data backend down
            setHealthDot('degraded', 'API backend unavailable');
        }
    } catch (e) {
        // Request truly failed (network/timeout) — API unreachable
        setHealthDot('down', 'API unreachable');
    }
}

/* ==================== 最后刷新时间 ==================== */
let refreshTimer = null;

function startRefreshClock() {
    const update = () => {
        const el = document.getElementById('lastRefresh');
        if (el) {
            const d = new Date();
            const pad = (x) => String(x).padStart(2, '0');
            el.textContent =
                pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
        }
    };
    update();
    refreshTimer = setInterval(update, 1000);
}

function stopRefreshClock() {
    if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
    }
}

/* ==================== 查询 Tab 切换 ==================== */
function bindQueryTabs() {
    const tabs = document.querySelectorAll('.query-tab');
    const panels = {
        account: document.getElementById('queryPanelAccount'),
        activity: document.getElementById('queryPanelActivity'),
        squeek: document.getElementById('queryPanelSqueek'),
    };

    tabs.forEach(tab => {
        if (tab.dataset.bound === '1') return;
        tab.dataset.bound = '1';

        tab.addEventListener('click', function () {
            const target = this.dataset.queryTab;

            // Toggle highlight
            tabs.forEach(t => t.classList.remove('active'));
            this.classList.add('active');

            // Toggle panels
            Object.keys(panels).forEach(k => {
                const p = panels[k];
                if (p) p.style.display = (k === target) ? '' : 'none';
            });
        });
    });
}

/* ==================== 页面可见性控制 ==================== */
let modulesRunning = false;

function startAllModules() {
    if (modulesRunning) return;
    modulesRunning = true;

    // Auto-polling modules
    startStatus();
    startCore();
    startBlocks();
    startEconomy();
    startSettlements();
    startStaking();
    startEvents();

    // Click-to-load modules (only bind buttons, no polling)
    startStats();
    startAccount();
    startSqueek();

    // 健康检查
    healthRunning = true;
    checkHealth();
    healthTimer = setInterval(checkHealth, HEALTH_INTERVAL_MS);
}

function stopAllModules() {
    if (!modulesRunning) return;
    modulesRunning = false;

    stopStatus();
    stopCore();
    stopBlocks();
    stopEconomy();
    stopSettlements();
    stopStaking();
    stopEvents();
    stopStats();
    stopAccount();
    stopSqueek();

    healthRunning = false;
    if (healthTimer) {
        clearInterval(healthTimer);
        healthTimer = null;
    }
}

function bindVisibility() {
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            stopAllModules();
        } else {
            startAllModules();
        }
    });
}

/* ==================== 启动 ==================== */
function init() {
    bindQueryTabs();
    bindVisibility();
    startRefreshClock();

    // First start (when page is visible)
    if (!document.hidden) {
        startAllModules();
    } else {
        // If initially hidden, wait for visibilitychange
        setHealthDot('gray', 'Awaiting activation');
    }
}

/* DOM 就绪后初始化 */
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

/* ==================== 全局跳转函数（供事件流使用） ==================== */
window.queryAccountFromEvent = function(address) {
    // 1. 切换到 Account 标签页
    const accountTab = document.querySelector('.query-tab[data-query-tab="account"]');
    if (accountTab) accountTab.click();

    // 2. 填入地址
    const input = document.getElementById('accountAddressInput');
    if (input) {
        input.value = address;
        // 3. 自动触发查询按钮点击
        const btn = document.getElementById('accountQueryBtn');
        if (btn) btn.click();
        
        // 4. 平滑滚动到查询区域
        document.getElementById('sectionQuery').scrollIntoView({ behavior: 'smooth' });
    }
};

/* ==================== 页面卸载时清理（防止导航离开时残留定时器） ==================== */
window.addEventListener('beforeunload', () => {
    stopAllModules();
    stopRefreshClock();
});