/* ============================================================
   Squeekchain Health Monitor - js/squeek.js
   查询区：单 Squeek 详情（/v1/squeeks/{tokenId}）
   - tokenId 校验（1–9999）
   - SVG 图像隔离渲染（用 <img src> 而非 innerHTML 注入）
   - 处理 burned / pending / unavailable / 404
   ============================================================ */

import { api, ApiError } from './api.js';
import {
    esc,
    toBig,
    thousands,
    formatTokenId,
    shortAddr,
    mergeStateLabel,
    mergeStateClass,
} from './format.js';

/* ==================== 工具 ==================== */
function setHtml(id, html) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
}

/* ==================== tokenId 校验 ==================== */
function parseTokenId(input) {
    const n = Number(input);
    if (!Number.isInteger(n)) return null;
    if (n < 1 || n > 9999) return null;
    return n;
}

/* ==================== 图像区渲染 ==================== */
// 文档要求：SVG 必须当不可信内容隔离显示，不能注入 application markup。
// 这里用 <img src="data:..."> 而非 innerHTML 注入 SVG，浏览器会当作图片渲染，脚本不会执行。
function renderImage(metadata) {
    const wrap = document.getElementById('squeekImageWrap');
    if (!wrap) return;

    // No metadata / metadata pending
    if (!metadata) {
        wrap.innerHTML = '<div class="empty">No image</div>';
        return;
    }
    if (metadata.status === 'pending') {
        wrap.innerHTML = '<div class="empty">Metadata updating…</div>';
        return;
    }

    const dataUri = metadata.imageDataUri || '';
    const cardUrl = metadata.cardImageUrl || '';

    // Prefer imageDataUri (SVG), fallback to cardImageUrl (raster)
    const src = dataUri || cardUrl;
    if (!src) {
        wrap.innerHTML = '<div class="empty">No image</div>';
        return;
    }

    // esc the src attribute to prevent data URI from breaking HTML with quotes
    wrap.innerHTML = '<img src="' + esc(src) + '" alt="Squeek" loading="lazy">';
}


/* ==================== 属性渲染 ==================== */
function renderAttributes(attributes) {
    if (!Array.isArray(attributes) || !attributes.length) return '';
    const badges = attributes.map(a => {
        const k = a.traitType || a.trait_type || a.name || '';
        const v = a.value !== undefined ? a.value : '';
        if (!k) return '';
        return '<span class="squeek-attr">' + esc(k) + '<b>' + esc(String(v)) + '</b></span>';
    }).filter(Boolean).join('');
    return badges ? '<div class="squeek-attributes">' + badges + '</div>' : '';
}

/* ==================== 主渲染 ==================== */
function render(result) {
    const el = document.getElementById('squeekResult');
    if (!el) return;

    // unavailable
    if (result.status === 'unavailable') {
        el.innerHTML = '<div class="unavailable-box">Squeek data unavailable: ' +
            esc(result.reason || 'unknown') + '</div>';
        return;
    }

    const d = result.data || {};
    const custody = d.custody || {};
    const economy = d.economy || {};
    const metadata = d.metadata || null;

    // ---------- Burned ----------
    if (custody.burned) {
        el.innerHTML =
            '<div class="unavailable-box">' +
                '<b>' + esc(formatTokenId(d.tokenId)) + ' was burned</b>' +
                (custody.owner ? ' · previously owned by ' + esc(shortAddr(custody.owner)) : '') +
                '<br>Merge donors are permanently burned and cannot be restored.' +
            '</div>';
        return;
    }

    // ---------- 顶部 meta ----------
    const owner = custody.owner || '—';
    const ownerLink = custody.owner
        ? '<a href="https://eth-sepolia.blockscout.com/address/' + esc(custody.owner) +
          '" target="_blank" rel="noopener">' + esc(shortAddr(custody.owner)) + '</a>'
        : '—';

    const custodian = custody.depositor
        ? 'staked (depositor ' + esc(shortAddr(custody.depositor)) + ')'
        : (custody.stray ? 'stray (no deposit record)' : 'wallet');

    const level = d.level !== undefined ? 'L' + d.level : '—';
    const basePower = d.basePower !== undefined ? thousands(String(toBig(d.basePower))) : '—';
    const nextMerge = d.nextMergeHeight !== undefined && d.nextMergeHeight !== null
        ? String(d.nextMergeHeight)
        : '—';
    const state = d.mergeState || '';
    const stateLabel = mergeStateLabel(state);
    const stateCls = mergeStateClass(state);

    const metaHtml =
        '<div class="squeek-detail">' +
            '<div class="squeek-image-wrap" id="squeekImageWrap"></div>' +
            '<div class="squeek-info-grid">' +
                '<div class="info-row"><span>Token ID</span><b>' + esc(formatTokenId(d.tokenId)) + '</b></div>' +
                '<div class="info-row"><span>Owner</span><b>' + ownerLink + '</b></div>' +
                '<div class="info-row"><span>Custody</span><b>' + esc(custodian) + '</b></div>' +
                '<div class="info-row"><span>Level</span><b>' + esc(level) + '</b></div>' +
                '<div class="info-row"><span>Base Power</span><b>' + esc(basePower) + '</b></div>' +
                '<div class="info-row"><span>Next Merge Height</span><b>#' + esc(nextMerge) + '</b></div>' +
                '<div class="info-row"><span>Merge State</span><b><span class="merge-state ' + esc(stateCls) + '">' + esc(stateLabel) + '</span></b></div>' +
                '<div class="info-row"><span>Current Round</span><b>' + esc(String(economy.currentRound !== undefined ? economy.currentRound : '—')) + '</b></div>' +
                '<div class="info-row"><span>Core Height</span><b>' + esc(String(economy.coreBlockHeight !== undefined ? economy.coreBlockHeight : '—')) + '</b></div>' +
                '<div class="info-row"><span>Merges Open</span><b>' + (economy.mergesOpen ? 'Yes' : 'No') + '</b></div>' +
                renderAttributes(metadata ? metadata.attributes : null) +
            '</div>' +
        '</div>';

    // ---------- 名称 / 描述 ----------
    let nameDesc = '';
    if (metadata && metadata.status !== 'pending') {
        if (metadata.name || metadata.description) {
            nameDesc = '<div style="margin-top:14px;padding-top:12px;border-top:1px dashed var(--border);">';
            if (metadata.name) {
                nameDesc += '<div style="font-size:15px;font-weight:600;color:var(--text-primary);margin-bottom:4px;">' +
                    esc(metadata.name) + '</div>';
            }
            if (metadata.description) {
                nameDesc += '<div style="font-size:12px;color:var(--text-secondary);line-height:1.6;">' +
                    esc(metadata.description) + '</div>';
            }
            if (metadata.refreshedAtBlock) {
                nameDesc += '<div style="font-size:11px;color:var(--text-muted);margin-top:6px;">' +
                    'Metadata refreshed at block #' + esc(String(metadata.refreshedAtBlock)) + '</div>';
            }
            nameDesc += '</div>';
        }
    }

    el.innerHTML = metaHtml + nameDesc;

    // 图像单独渲染（因为要用 <img> 隔离 SVG）
    renderImage(metadata);
}

/* ==================== 单次查询 ==================== */
async function query(tokenId) {
    const el = document.getElementById('squeekResult');
    if (!el) return;

    el.innerHTML = '<div class="empty">Querying…</div>';

    try {
        const result = await api.squeek(tokenId);
        render(result);
    } catch (e) {
        // 404 token_not_found
        if (e instanceof ApiError && e.httpStatus === 404) {
            el.innerHTML = '<div class="error-box">Squeek #' + esc(String(tokenId)) +
                ' not found (never minted or burned)</div>';
            return;
        }
        el.innerHTML = '<div class="error-box">Query failed: ' + esc(e.message) + '</div>';
    }
}

/* ==================== 按钮绑定 ==================== */
function bindQuery() {
    const btn = document.getElementById('squeekQueryBtn');
    const input = document.getElementById('squeekTokenIdInput');
    if (!btn || !input) return;
    if (btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';

    const doQuery = () => {
        const id = parseTokenId(input.value.trim());
        if (id === null) {
            const el = document.getElementById('squeekResult');
            if (el) el.innerHTML = '<div class="error-box">tokenId must be an integer between 1 and 9999</div>';
            return;
        }
        query(id);
    };

    btn.addEventListener('click', doQuery);
    input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') doQuery();
    });
}

/* ==================== 对外：启动 / 停止 ==================== */
export function startSqueek() {
    bindQuery();
}

export function stopSqueek() {
    // 无轮询
}