/* ============================================================
   Squeekchain Health Monitor - js/account.js
   查询区：账户 + 账户历史
   - /v1/accounts/{address}          账户摘要 + Squeek 列表（分页）
   - /v1/accounts/{address}/activity 活动历史（分页）
   - 地址格式校验
   - 409 cursor_invalidated → 从第一页重来
   - 处理 unavailable / 错误
   ============================================================ */

import { api, ApiError } from './api.js';
import {
    esc,
    toBig,
    thousands,
    formatSqk,
    formatUnits,
    timeAgo,
    isoToLocal,
    shortAddr,
    blockscoutTx,
    formatTokenId,
    mergeStateLabel,
    mergeStateClass,
    activityKindLabel,
    powerForLevel,
} from './format.js';

const POWER_UNIT = 10n ** 18n;
/* ==================== 状态 ==================== */
const accountState = {
    address: '',
    tokens: [],
    cursor: null,
    summary: null,
    loading: false,
};

const activityState = {
    address: '',
    items: [],
    cursor: null,
    total: 0,
    loading: false,
};

const PAGE_LIMIT = 25;

/* ==================== 工具 ==================== */
function setHtml(id, html) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
}

function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

/* 地址格式校验：0x + 40 hex */
function isValidAddress(addr) {
    if (!addr) return false;
    const s = String(addr).trim();
    return /^0x[a-fA-F0-9]{40}$/.test(s);
}

/* ==================== 账户摘要渲染 ==================== */
function renderAccountSummary(data) {
    const rewards = data.rewards || {};
    const power = data.power || {};
    const counts = data.tokenCounts || {};
    const economy = data.economy || {};

    const claimable = formatSqk(rewards.claimableBaseUnits, 4);
    const nftPower = thousands(formatUnits(power.nftPower, POWER_UNIT, 0));
    const sqkPower = thousands(formatUnits(power.sqkPower, POWER_UNIT, 0));
    const walletCount = String(counts.wallet || 0);
    const stakingCount = String(counts.staking || 0);

    return (
        '<div class="account-summary">' +
            '<div class="stat-tile">' +
                '<div class="stat-label">Claimable</div>' +
                '<div class="stat-value" style="color:var(--gold)">' + esc(claimable) + '</div>' +
            '</div>' +
            '<div class="stat-tile">' +
                '<div class="stat-label">Squeeks in Wallet</div>' +
                '<div class="stat-value">' + esc(walletCount) + '</div>' +
            '</div>' +
            '<div class="stat-tile">' +
                '<div class="stat-label">Squeeks Staked</div>' +
                '<div class="stat-value">' + esc(stakingCount) + '</div>' +
            '</div>' +
            '<div class="stat-tile">' +
                '<div class="stat-label">NFT Power</div>' +
                '<div class="stat-value">' + esc(nftPower) + '</div>' +
            '</div>' +
        '</div>' +
        '<div class="account-meta" style="display:flex;flex-wrap:wrap;gap:16px;font-size:12px;color:var(--text-secondary);padding:10px 0;border-bottom:1px dashed var(--border);margin-bottom:12px;">' +
            '<span>SQK Power: <b style="font-family:var(--font-mono);color:var(--text-primary);">' + esc(sqkPower) + '</b></span>' +
            '<span>Lifetime Paid: <b style="font-family:var(--font-mono);color:var(--text-primary);">' + esc(formatSqk(rewards.lifetimePaidBaseUnits, 2)) + '</b></span>' +
            '<span>Core Height: <b style="font-family:var(--font-mono);color:var(--text-primary);">' + esc(String(economy.coreBlockHeight !== undefined ? economy.coreBlockHeight : '—')) + '</b></span>' +
            '<span>Max Level: <b style="font-family:var(--font-mono);color:var(--text-primary);">L' + esc(String(economy.maximumLevel !== undefined ? economy.maximumLevel : '—')) + '</b></span>' +
            (data.claimRecipient ? '<span>Claim Recipient: <b style="font-family:var(--font-mono);">' + esc(shortAddr(data.claimRecipient)) + '</b></span>' : '') +
        '</div>'
    );
}

/* ==================== Squeek 列表渲染 ==================== */
function renderTokenRow(t) {
    const tokenId = t.tokenId !== undefined ? formatTokenId(t.tokenId) : '—';
    const level = t.level !== undefined ? String(t.level) : '—';
    const power = t.basePower !== undefined
        ? thousands(String(toBig(t.basePower)))
        : '—';
    const nextMerge = t.nextMergeHeight !== undefined && t.nextMergeHeight !== null
        ? String(t.nextMergeHeight)
        : '—';
    const state = t.mergeState || '';
    const stateLabel = mergeStateLabel(state);
    const stateCls = mergeStateClass(state);
    const custody = t.custody === 'staking' ? 'staking' : (t.custody === 'wallet' ? 'wallet' : (t.custody || '—'));

    return (
        '<div class="account-token-row">' +
            '<span class="token-id">' + esc(tokenId) + '</span>' +
            '<span>L' + esc(level) + '</span>' +
            '<span title="basePower">' + esc(power) + '</span>' +
            '<span title="nextMergeHeight">→ ' + esc(nextMerge) + '</span>' +
            '<span>' +
                '<span class="merge-state ' + esc(stateCls) + '">' + esc(stateLabel) + '</span>' +
                ' <span style="color:var(--text-muted);font-size:10px;">' + esc(custody) + '</span>' +
            '</span>' +
        '</div>'
    );
}

function renderAccountTokens() {
    const el = document.getElementById('accountResult');
    if (!el) return;

    const st = accountState;
    if (!st.summary) {
        el.innerHTML = '<div class="empty">Enter an address and click Query</div>';
        return;
    }

    let html = renderAccountSummary(st.summary);

    // Squeek list
    html += '<div class="account-tokens"><h4>Squeeks (' + st.tokens.length + ' loaded)</h4>';

    if (!st.tokens.length) {
        html += '<div class="empty">This address has no Squeeks</div>';
    } else {
        st.tokens.forEach(t => {
            html += renderTokenRow(t);
        });
    }
    html += '</div>';

    // Load more
    if (st.cursor) {
        html += '<div class="load-more-wrap">' +
            '<button class="btn btn-sm" id="accountLoadMoreBtn">Load More</button>' +
            '</div>';
    }

    el.innerHTML = html;

    // 绑定加载更多
    const moreBtn = document.getElementById('accountLoadMoreBtn');
    if (moreBtn) {
        moreBtn.addEventListener('click', () => loadAccountPage(st.address, true));
    }
}

/* ==================== 账户加载 ==================== */
async function loadAccountPage(address, isAppend) {
    if (accountState.loading) return;

    const el = document.getElementById('accountResult');
    if (!el) return;

    if (!isAppend) {
        accountState.address = address;
        accountState.tokens = [];
        accountState.cursor = null;
        accountState.summary = null;
        el.innerHTML = '<div class="empty">Loading…</div>';
    }

    accountState.loading = true;
    if (isAppend) {
        const btn = document.getElementById('accountLoadMoreBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
    }

    try {
        const result = await api.account(address, accountState.cursor, PAGE_LIMIT);

        if (result.status === 'unavailable') {
            el.innerHTML = '<div class="unavailable-box">Account data unavailable: ' +
                esc(result.reason || 'unknown') + '</div>';
            return;
        }

        const d = result.data || {};
        const tokens = Array.isArray(d.tokens) ? d.tokens : [];

        // Save summary on first request
        if (!accountState.summary) {
            accountState.summary = d;
        }

        accountState.tokens = accountState.tokens.concat(tokens);
        accountState.cursor = d.nextCursor || null;

        renderAccountTokens();
    } catch (e) {
        // 409 cursor_invalidated: restart from page 1
        if (e instanceof ApiError && e.httpStatus === 409 && e.code === 'cursor_invalidated') {
            accountState.cursor = null;
            accountState.tokens = [];
            accountState.loading = false;
            return loadAccountPage(address, false);
        }

        if (isAppend) {
            const btn = document.getElementById('accountLoadMoreBtn');
            if (btn) { btn.disabled = false; btn.textContent = 'Load More'; }
        } else {
            el.innerHTML = '<div class="error-box">Query failed: ' + esc(e.message) + '</div>';
        }
    } finally {
        accountState.loading = false;
    }
}

/* ==================== 活动历史渲染 ==================== */
function renderActivityRow(item) {
    const kind = item.kind || '';
    const kindLabel = activityKindLabel(kind);
    const timeStr = item.source && item.source.blockTimestamp
        ? timeAgo(item.source.blockTimestamp)
        : (item.occurredAt ? timeAgo(item.occurredAt) : '—');
    const timeTitle = item.source && item.source.blockTimestamp
        ? isoToLocal(item.source.blockTimestamp)
        : '';

    // 交易链接
    let txLink = '';
    if (item.source) {
        const txHash = typeof item.source.transaction === 'string'
            ? item.source.transaction
            : (item.source.transaction && item.source.transaction.hash);
        if (txHash) {
            txLink = ' · <a href="' + esc(blockscoutTx(txHash)) + '" target="_blank" rel="noopener">tx</a>';
        }
    }

    // Description
    let desc = '';
    switch (kind) {
        case 'rewards_claimed':
            desc = item.amountBaseUnits !== undefined ? 'claimed ' + formatSqk(item.amountBaseUnits, 4) : '';
            if (item.recipient) desc += ' → ' + shortAddr(item.recipient);
            break;
        case 'rewards_staked':
        case 'sqk_staked':
            desc = item.amountBaseUnits !== undefined ? 'staked ' + formatSqk(item.amountBaseUnits, 4) : '';
            if (item.freshUntilRound !== undefined) desc += ' · until round #' + item.freshUntilRound;
            break;
        case 'sqk_unstaked':
            desc = item.netBaseUnits !== undefined ? 'received ' + formatSqk(item.netBaseUnits, 4) : '';
            if (item.feeBaseUnits !== undefined && toBig(item.feeBaseUnits) > 0n) {
                desc += ' · fee ' + formatSqk(item.feeBaseUnits, 4);
            }
            break;
        case 'nft_deposited':
        case 'nft_withdrawn':
        case 'nft_launch_claimed':
            desc = item.tokenId !== undefined ? '#' + item.tokenId : '';
            if (item.basePower !== undefined) desc += ' · power ' + thousands(String(item.basePower));
            break;
        case 'nft_merged':
            desc = (item.survivorTokenId !== undefined && item.donorTokenId !== undefined)
                ? '#' + item.survivorTokenId + ' ← #' + item.donorTokenId
                : '';
            if (item.level !== undefined) desc += ' · L' + item.level;
            break;
        case 'nft_transferred':
            desc = (item.from && item.to)
                ? shortAddr(item.from) + ' → ' + shortAddr(item.to)
                : '';
            break;
        case 'claim_recipient_set':
            desc = item.recipient ? 'set to ' + shortAddr(item.recipient) : '';
            break;
        default:
            desc = item.amountBaseUnits !== undefined
                ? formatSqk(item.amountBaseUnits, 4)
                : '';
    }

    return (
        '<div class="activity-row">' +
            '<span class="activity-kind">' + esc(kindLabel) + '</span>' +
            '<span class="activity-info" style="color:var(--text-secondary);font-family:var(--font-mono);font-size:11px;">' +
                esc(desc) + txLink +
            '</span>' +
            '<span class="activity-time" title="' + esc(timeTitle) + '">' + esc(timeStr) + '</span>' +
        '</div>'
    );
}

function renderActivityList() {
    const el = document.getElementById('activityResult');
    if (!el) return;

    const st = activityState;
    if (!st.address) {
        el.innerHTML = '<div class="empty">Enter an address and click Query</div>';
        return;
    }

    let html = '<div style="font-size:12px;color:var(--text-secondary);margin-bottom:10px;">' +
        'Total <b style="color:var(--gold);font-family:var(--font-mono);">' + esc(String(st.total)) + '</b> records, ' +
        st.items.length + ' loaded</div>';

    if (!st.items.length) {
        html += '<div class="empty">This address has no activity</div>';
    } else {
        st.items.forEach(item => {
            html += renderActivityRow(item);
        });
    }

    if (st.cursor) {
        html += '<div class="load-more-wrap"><button class="btn btn-sm" id="activityLoadMoreBtn">Load More</button></div>';
    }
    el.innerHTML = html;

    const moreBtn = document.getElementById('activityLoadMoreBtn');
    if (moreBtn) {
        moreBtn.addEventListener('click', () => loadActivityPage(st.address, true));
    }
}

/* ==================== 活动历史加载 ==================== */
async function loadActivityPage(address, isAppend) {
    if (activityState.loading) return;

    const el = document.getElementById('activityResult');
    if (!el) return;

    if (!isAppend) {
        activityState.address = address;
        activityState.items = [];
        activityState.cursor = null;
        activityState.total = 0;
        el.innerHTML = '<div class="empty">Loading…</div>';
    }

    activityState.loading = true;
    if (isAppend) {
        const btn = document.getElementById('activityLoadMoreBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
    }

    try {
        const result = await api.accountActivity(address, activityState.cursor, PAGE_LIMIT);

        if (result.status === 'unavailable') {
            el.innerHTML = '<div class="unavailable-box">Activity data unavailable: ' +
                esc(result.reason || 'unknown') + '</div>';
            return;
        }

        const d = result.data || {};
        const items = Array.isArray(d.activity) ? d.activity : [];

        if (activityState.total === 0 && d.total !== undefined) {
            activityState.total = Number(d.total) || 0;
        }

        activityState.items = activityState.items.concat(items);
        activityState.cursor = d.nextCursor || null;

        renderActivityList();
    } catch (e) {
        if (e instanceof ApiError && e.httpStatus === 409 && e.code === 'cursor_invalidated') {
            activityState.cursor = null;
            activityState.items = [];
            activityState.loading = false;
            return loadActivityPage(address, false);
        }

        if (isAppend) {
            const btn = document.getElementById('activityLoadMoreBtn');
            if (btn) { btn.disabled = false; btn.textContent = 'Load More'; }
        } else {
            el.innerHTML = '<div class="error-box">Query failed: ' + esc(e.message) + '</div>';
        }
    } finally {
        activityState.loading = false;
    }
}

/* ==================== 按钮绑定 ==================== */
function bindAccountQuery() {
    const btn = document.getElementById('accountQueryBtn');
    const input = document.getElementById('accountAddressInput');
    if (!btn || !input) return;
    if (btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';

    const doQuery = () => {
        const addr = input.value.trim();
        if (!isValidAddress(addr)) {
            const el = document.getElementById('accountResult');
            if (el) el.innerHTML = '<div class="error-box">Invalid address (must be 0x + 40 hex chars)</div>';
            return;
        }
        loadAccountPage(addr, false);
    };

    btn.addEventListener('click', doQuery);
    input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') doQuery();
    });
}

function bindActivityQuery() {
    const btn = document.getElementById('activityQueryBtn');
    const input = document.getElementById('activityAddressInput');
    if (!btn || !input) return;
    if (btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';

    const doQuery = () => {
        const addr = input.value.trim();
        if (!isValidAddress(addr)) {
            const el = document.getElementById('activityResult');
            if (el) el.innerHTML = '<div class="error-box">Invalid address (must be 0x + 40 hex chars)</div>';
            return;
        }
        loadActivityPage(addr, false);
    };

    btn.addEventListener('click', doQuery);
    input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') doQuery();
    });
}

/* ==================== 对外：启动 ==================== */
export function startAccount() {
    bindAccountQuery();
    bindActivityQuery();
}

/* ==================== 对外：停止（清空状态，不断请求） ==================== */
export function stopAccount() {
    // 无轮询，无需清理
}