/* ============================================================
   Squeekchain Health Monitor - js/events.js
   Block 6: Event Feed
   ============================================================ */

import { api } from './api.js';
import {
    esc,
    timeAgo,
    isoToLocal,
    blockscoutTx,
    shortAddr,
    eventTypeLabel,
    toBig,
    thousands,
    formatSqk,
} from './format.js';

const POLL_INTERVAL_MS = 15000;
const DEFAULT_LIMIT = 40;

let timer = null;
let running = false;
let lastData = null;
let currentCategory = 'all';

/* ==================== Category to CSS class ==================== */
function categoryClass(type) {
    if (!type) return 'type-protocol';
    if (type.startsWith('system.')) return 'type-protocol';
    if (type.startsWith('account.') || type.startsWith('nft.')) return 'type-players';
    if (type.startsWith('measurement.')) return 'type-measurement';
    return 'type-protocol';
}

/* ==================== Payload summarizer ==================== */
function summarizePayload(type, payload) {
    const p = payload || {};

    switch (type) {
        case 'system.settlement_completed':
            return [
                p.settledThroughRound !== undefined ? 'through #' + p.settledThroughRound : '',
                p.completedBlockCount !== undefined ? p.completedBlockCount + ' blocks' : (p.completedBlocks !== undefined ? p.completedBlocks + ' blocks' : ''),
                p.activeRoundCount !== undefined ? p.activeRoundCount + ' active rounds' : '',
                p.workAdded !== undefined ? 'work +' + thousands(String(p.workAdded)) : '',
            ].filter(Boolean).join(' · ');

        case 'system.mining_checkpointed':
            return [
                (p.afterRound !== undefined && p.throughRound !== undefined) ? '#' + p.afterRound + ' → #' + p.throughRound : '',
                p.completedBlockCount !== undefined ? p.completedBlockCount + ' blocks' : '',
                p.amountBaseUnits !== undefined ? 'minted ' + formatSqk(p.amountBaseUnits, 2) : '',
            ].filter(Boolean).join(' · ');

        case 'account.rewards_claimed':
            return [
                p.account ? shortAddr(p.account, 6, 4) : '',
                p.amountBaseUnits !== undefined ? 'claimed ' + formatSqk(p.amountBaseUnits, 4) : '',
            ].filter(Boolean).join(' · ');

        case 'account.claim_recipient_set':
            return p.recipient ? 'recipient set to ' + shortAddr(p.recipient, 6, 4) : '';

        case 'account.rewards_staked':
        case 'account.sqk_staked':
            return [
                p.amountBaseUnits !== undefined ? 'staked ' + formatSqk(p.amountBaseUnits, 4) : '',
                p.freshUntilRound !== undefined ? 'until round #' + p.freshUntilRound : '',
            ].filter(Boolean).join(' · ');

        case 'account.sqk_unstaked':
            return [
                p.netBaseUnits !== undefined ? 'received ' + formatSqk(p.netBaseUnits, 4) : '',
                p.feeBaseUnits !== undefined && toBig(p.feeBaseUnits) > 0n ? 'fee ' + formatSqk(p.feeBaseUnits, 4) : '',
            ].filter(Boolean).join(' · ');

        case 'nft.deposited':
        case 'nft.withdrawn':
            return [
                p.tokenId !== undefined ? '#' + p.tokenId : '',
                p.basePower !== undefined ? 'power ' + thousands(String(p.basePower)) : '',
            ].filter(Boolean).join(' · ');

        case 'nft.merged':
            return [
                (p.survivorTokenId !== undefined && p.donorTokenId !== undefined)
                    ? '#' + p.survivorTokenId + ' ← #' + p.donorTokenId : '',
                p.level !== undefined ? 'L' + p.level : '',
                p.nftPowerDelta !== undefined ? 'power Δ ' + thousands(String(p.nftPowerDelta)) : '',
            ].filter(Boolean).join(' · ');

        case 'nft.launch_claimed':
            return p.tokenId !== undefined ? '#' + p.tokenId : '';

        case 'measurement.distance_milestone':
            return [
                p.thresholdDistanceMm !== undefined ? 'milestone ' + (Number(p.thresholdDistanceMm) / 1000).toFixed(0) + ' m' : '',
                p.observedLifetimeDistanceMm !== undefined ? 'lifetime ' + (Number(p.observedLifetimeDistanceMm) / 1000).toFixed(1) + ' m' : '',
            ].filter(Boolean).join(' · ');

        case 'measurement.daily_distance_milestone':
            return [
                p.thresholdDistanceMm !== undefined ? 'daily ' + (Number(p.thresholdDistanceMm) / 1000).toFixed(0) + ' m' : '',
                p.utcDate || '',
            ].filter(Boolean).join(' · ');

        case 'measurement.speed_milestone':
            return [
                p.thresholdSpeedMmPerSecond !== undefined ? 'speed ' + (Number(p.thresholdSpeedMmPerSecond) * 3.6).toFixed(1) + ' km/h' : '',
                p.observedSpeedMmPerSecond !== undefined ? 'observed ' + (Number(p.observedSpeedMmPerSecond) * 3.6).toFixed(1) + ' km/h' : '',
            ].filter(Boolean).join(' · ');

        case 'measurement.speed_record':
            return [
                p.recordMmPerSecond !== undefined ? 'new record ' + (Number(p.recordMmPerSecond) * 3.6).toFixed(2) + ' km/h' : '',
                p.previousRecordMmPerSecond !== undefined ? 'prev ' + (Number(p.previousRecordMmPerSecond) * 3.6).toFixed(2) + ' km/h' : '',
            ].filter(Boolean).join(' · ');

        case 'measurement.distance_streak':
            return [
                p.days !== undefined ? p.days + '-day streak' : '',
                p.minimumDailyDistanceMm !== undefined ? 'daily ≥ ' + (Number(p.minimumDailyDistanceMm) / 1000).toFixed(0) + ' m' : '',
            ].filter(Boolean).join(' · ');

        default: {
            const keys = Object.keys(p).slice(0, 3);
            return keys.map(k => k + '=' + String(p[k]).slice(0, 20)).join(' · ');
        }
    }
}

/* ==================== Main render ==================== */
function render(result) {
    const listEl = document.getElementById('eventsList');
    if (!listEl) return;

    if (result.status === 'unavailable') {
        listEl.innerHTML = '<div class="empty" style="color:var(--yellow)">' +
            esc('Event feed unavailable: ' + (result.reason || 'unknown')) + '</div>';
        return;
    }

    const d = result.data || {};
    lastData = d;

    const events = Array.isArray(d.events) ? d.events : [];

    if (!events.length) {
        listEl.innerHTML = '<div class="empty">No events</div>';
        return;
    }

    const rows = events.map(ev => {
        const type = ev.type || '';
        const cls = categoryClass(type);
        const label = esc(eventTypeLabel(type));

        const timeStr = ev.occurredAt
            ? esc(timeAgo(ev.occurredAt))
            : (ev.recordedAt ? esc(timeAgo(ev.recordedAt)) : '—');
        const timeTitle = ev.occurredAt ? esc(isoToLocal(ev.occurredAt)) : '';

        const desc = summarizePayload(type, ev.payload);

        // Transaction link
        let txLink = '';
        const src = ev.source || {};
        if (src.kind === 'chain' && src.transaction) {
            const txHash = typeof src.transaction === 'string'
                ? src.transaction
                : (src.transaction.hash || '');
            if (txHash) {
                txLink = ' · <a href="' + esc(blockscoutTx(txHash)) +
                    '" target="_blank" rel="noopener">tx</a>';
            }
        }

        // One-click address trace
        let accountLink = '';
        if (ev.payload && ev.payload.account) {
            const acc = ev.payload.account;
            accountLink = ' · <a href="javascript:void(0)" onclick="window.queryAccountFromEvent(\'' + acc + '\')" style="color:var(--gold);text-decoration:underline;">query acc</a>';
        }

        return (
            '<div class="event-row">' +
                '<span class="event-type ' + cls + '">' + label + '</span>' +
                '<span class="event-info" style="color:var(--text-secondary);font-family:var(--font-mono);font-size:11px;">' +
                    esc(desc) + txLink + accountLink +
                '</span>' +
                '<span class="event-time" title="' + timeTitle + '">' + timeStr + '</span>' +
            '</div>'
        );
    }).join('');

    listEl.innerHTML = rows;
}

/* ==================== Fetch ==================== */
async function pull() {
    try {
        const result = await api.events(currentCategory, DEFAULT_LIMIT);
        render(result);
    } catch (e) {
        const listEl = document.getElementById('eventsList');
        if (listEl) {
            listEl.innerHTML = '<div class="empty" style="color:var(--red)">' +
                esc('Request failed: ' + e.message) + '</div>';
        }
    }
}

/* ==================== Category selector ==================== */
function bindCategorySelect() {
    const sel = document.getElementById('eventsCategory');
    if (!sel) return;
    if (sel.dataset.bound === '1') return;
    sel.dataset.bound = '1';
    sel.value = currentCategory;
    sel.addEventListener('change', function () {
        currentCategory = this.value;
        pull();
    });
}

/* ==================== Public API ==================== */
export function startEvents() {
    if (running) return;
    running = true;
    bindCategorySelect();
    pull();
    timer = setInterval(pull, POLL_INTERVAL_MS);
}

export function stopEvents() {
    if (!running) return;
    running = false;
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}

export function getLastEvents() {
    return lastData;
}