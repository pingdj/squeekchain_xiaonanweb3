/* ============================================================
   Squeekchain Health Monitor - js/format.js
   格式化工具
   - BigInt 安全处理（SQK 10^18、block units 10^9、work）
   - 千分位、百分比
   - 时间差（多久之前）、Unix 秒转本地时间
   - 地址缩写、tokenId 补零
   - Blockscout 链接
   - 轮次时间计算（genesis + roundDuration）
   - 等级表查找
   ============================================================ */

/* ==================== 常量 ==================== */
export const SQK_DECIMALS = 18n;
export const SQK_UNIT = 10n ** SQK_DECIMALS;          // 1 SQK = 10^18 base units
export const BLOCK_UNITS_PER_BLOCK = 1_000_000_000n;  // 10^9 block units = 1 Squeek block
export const BLOCKSCOUT_BASE = 'https://eth-sepolia.blockscout.com';

/* ==================== 安全转 BigInt ==================== */
/**
 * 把 API 返回的十进制字符串（可能带小数）安全转成 BigInt。
 * 只用于整数类字段（base units、work、block units、round 等）。
 * 若传入 number，会先转 string 再转 BigInt，避免精度丢失。
 * @param {string|number|bigint|null|undefined} v
 * @returns {bigint}
 */
export function toBig(v) {
    if (v === null || v === undefined || v === '') return 0n;
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number') {
        if (!Number.isFinite(v)) return 0n;
        // number 只在小于 2^53 时安全；超出时提醒但仍尝试
        return BigInt(Math.trunc(v));
    }
    const s = String(v).trim();
    if (!s) return 0n;
    // 只保留整数部分，防 API 偶发返回小数
    const intPart = s.split('.')[0];
    try { return BigInt(intPart); } catch { return 0n; }
}

/* ==================== 数字加千分位 ==================== */
/**
 * @param {string|number|bigint} v
 * @returns {string} 例如 "1,234,567"
 */
export function thousands(v) {
    const s = String(v);
    return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/* ==================== 缩位（K / M / B / T） ==================== */
/**
 * 大数缩位显示。输入可为 BigInt 或字符串。
 * @param {string|number|bigint} v
 * @param {number} [decimals=2]
 * @returns {string}
 */
export function abbreviate(v, decimals = 2) {
    const s = typeof v === 'bigint' ? v.toString() : String(v);
    const neg = s.startsWith('-');
    const abs = neg ? s.slice(1) : s;
    const len = abs.length;

    let out;
    if (len <= 3) {
        out = abs;
    } else if (len <= 6) {
        out = (Number(abs) / 1e3).toFixed(decimals) + 'K';
    } else if (len <= 9) {
        out = (Number(abs) / 1e6).toFixed(decimals) + 'M';
    } else if (len <= 12) {
        out = (Number(abs) / 1e9).toFixed(decimals) + 'B';
    } else if (len <= 15) {
        out = (Number(abs) / 1e12).toFixed(decimals) + 'T';
    } else {
        out = abs;
    }
    return neg ? '-' + out : out;
}

/* ==================== BigInt 定点除法（用于 SQK base units 显示） ==================== */
/**
 * 把 base units 的 BigInt 除以 10^decimals，保留 fracDigits 位小数。
 * 例：formatUnits(1234567890000000000000n, 18, 4) → "1234.5678"
 * @param {bigint|string|number} value
 * @param {bigint} [unit=10n**18n]
 * @param {number} [fracDigits=4]
 * @returns {string}
 */
export function formatUnits(value, unit = SQK_UNIT, fracDigits = 4) {
    const v = toBig(value);
    const neg = v < 0n;
    const abs = neg ? -v : v;
    const intPart = abs / unit;
    const fracPart = abs % unit;

    if (fracDigits <= 0 || fracPart === 0n) {
        return (neg ? '-' : '') + intPart.toString();
    }

    // 把小数部分扩到 fracDigits 位
    const scaled = (fracPart * (10n ** BigInt(fracDigits))) / unit;
    let fracStr = scaled.toString().padStart(fracDigits, '0');
    // 去掉尾部多余的 0
    fracStr = fracStr.replace(/0+$/, '');
    if (!fracStr) return (neg ? '-' : '') + intPart.toString();
    return (neg ? '-' : '') + intPart.toString() + '.' + fracStr;
}

/* ==================== SQK 专用格式化（base units → SQK） ==================== */
/**
 * @param {string|number|bigint} baseUnits
 * @param {number} [fracDigits=4]
 * @returns {string} 例如 "1234.5678 SQK"
 */
export function formatSqk(baseUnits, fracDigits = 4) {
    return formatUnits(baseUnits, SQK_UNIT, fracDigits) + ' SQK';
}

/* ==================== Block units 格式化为 Squeek block 高度 ==================== */
/**
 * @param {string|number|bigint} blockUnits
 * @returns {string}
 */
export function formatBlockHeight(blockUnits) {
    const v = toBig(blockUnits);
    return thousands((v / BLOCK_UNITS_PER_BLOCK).toString());
}

/* ==================== 百分比 ==================== */
/**
 * @param {string|number|bigint} numerator
 * @param {string|number|bigint} denominator
 * @param {number} [decimals=2]
 * @returns {string} 例如 "12.34%"
 */
export function percent(numerator, denominator, decimals = 2) {
    const n = toBig(numerator);
    const d = toBig(denominator);
    if (d === 0n) return '0.00%';
    // 用放大 10000 倍的整数运算，避免浮点误差
    const scale = 10n ** BigInt(decimals + 2); // 多乘 100
    const pct = (n * scale) / d;
    const whole = pct / (10n ** BigInt(decimals));
    const frac = pct % (10n ** BigInt(decimals));
    const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
    return whole.toString() + (fracStr ? '.' + fracStr : '') + '%';
}

/* ==================== 时间 ==================== */
/**
 * Unix 秒转本地时间字符串 YYYY-MM-DD HH:mm:ss
 * @param {string|number} unixSec
 * @returns {string}
 */
export function unixToLocal(unixSec) {
    const n = Number(unixSec);
    if (!Number.isFinite(n) || n <= 0) return '—';
    const d = new Date(n * 1000);
    const pad = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * ISO 字符串转本地时间（YYYY-MM-DD HH:mm:ss）
 * @param {string} iso
 * @returns {string}
 */
export function isoToLocal(iso) {
    if (!iso) return '—';
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return '—';
    return unixToLocal(Math.floor(t / 1000));
}

/**
 * Time elapsed since a given timestamp (English).
 * @param {string|number} unixSec   Unix seconds or ISO string
 * @returns {string}  e.g. "3m 12s ago", "2d 5h ago"
 */
export function timeAgo(unixSec) {
    let t;
    if (typeof unixSec === 'string' && unixSec.includes('T')) {
        t = Date.parse(unixSec);
    } else {
        t = Number(unixSec) * 1000;
    }
    if (!Number.isFinite(t) || t <= 0) return '—';
    const diff = Math.floor((Date.now() - t) / 1000);
    if (diff < 0) return 'in the future';
    if (diff < 60) return diff + 's ago';
    if (diff < 3600) {
        const m = Math.floor(diff / 60);
        const s = diff % 60;
        return m + 'm' + (s ? ' ' + s + 's' : '') + ' ago';
    }
    if (diff < 86400) {
        const h = Math.floor(diff / 3600);
        const m = Math.floor((diff % 3600) / 60);
        return h + 'h' + (m ? ' ' + m + 'm' : '') + ' ago';
    }
    const d = Math.floor(diff / 86400);
    const h = Math.floor((diff % 86400) / 3600);
    return d + 'd' + (h ? ' ' + h + 'h' : '') + ' ago';
}

/**
 * 秒数格式化为 "1d 2h 3m"
 * @param {number} sec
 * @returns {string}
 */
export function durationSec(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '—';
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const parts = [];
    if (d) parts.push(d + 'd');
    if (h) parts.push(h + 'h');
    if (m) parts.push(m + 'm');
    if (s && parts.length === 0) parts.push(s + 's');
    return parts.join(' ') || '0s';
}

/* ==================== 轮次计算 ==================== */
/**
 * 根据 genesisTimestamp + roundDuration 计算当前轮次
 * @param {number} genesisTimestamp   Unix 秒
 * @param {number} roundDuration      秒（通常 600）
 * @returns {bigint}                  当前轮次（从 1 开始）
 */
export function currentRoundFromGenesis(genesisTimestamp, roundDuration) {
    const genesis = toBig(genesisTimestamp);
    const dur = toBig(roundDuration);
    if (dur === 0n) return 0n;
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (now < genesis) return 0n;
    return (now - genesis) / dur + 1n;
}

/**
 * 轮次的开始时间（Unix 秒）
 * @param {number} roundId
 * @param {number} genesisTimestamp
 * @param {number} roundDuration
 * @returns {number}
 */
export function roundStartTime(roundId, genesisTimestamp, roundDuration) {
    return Number(genesisTimestamp) + (Number(roundId) - 1) * Number(roundDuration);
}

/* ==================== 地址 / 哈希缩写 ==================== */
/**
 * @param {string} addr
 * @param {number} [head=6]
 * @param {number} [tail=4]
 * @returns {string}  例如 "0xfbE8...7777"
 */
export function shortAddr(addr, head = 6, tail = 4) {
    if (!addr) return '—';
    const s = String(addr);
    if (s.length <= head + tail + 3) return s;
    return s.slice(0, head) + '...' + s.slice(-tail);
}

/* ==================== tokenId 补零 ==================== */
/**
 * @param {string|number} id
 * @returns {string}  例如 "#0001"
 */
export function formatTokenId(id) {
    const n = Number(id);
    if (!Number.isFinite(n)) return '#' + String(id);
    return '#' + String(n).padStart(4, '0');
}

/* ==================== Blockscout 链接 ==================== */
/**
 * @param {string} txHash
 * @returns {string}
 */
export function blockscoutTx(txHash) {
    if (!txHash) return '';
    return `${BLOCKSCOUT_BASE}/tx/${txHash}`;
}

/**
 * @param {string} address
 * @returns {string}
 */
export function blockscoutAddress(address) {
    if (!address) return '';
    return `${BLOCKSCOUT_BASE}/address/${address}`;
}

/* ==================== HTML 转义 ==================== */
/**
 * 任何来自 API 或用户输入的字符串，插入 innerHTML 前必须过一遍。
 * @param {string} s
 * @returns {string}
 */
export function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/* ==================== mergeState 中文化 ==================== */
export function mergeStateLabel(state) {
    switch (state) {
        case 'ready': return 'Ready';
        case 'cooldown': return 'Cooldown';
        case 'terminal': return 'Max Level';
        case 'merges_closed': return 'Merges Closed';
        default: return state || '—';
    }
}

/* ==================== 等级表查找 ==================== */
/**
 * 从 economy/state 返回的 basePower[] 查 level 对应的 power
 * @param {number} level   1-based
 * @param {string[]|number[]|bigint[]} basePowerArr  索引 0 对应 level 1
 * @returns {bigint}
 */
export function powerForLevel(level, basePowerArr) {
    if (!Array.isArray(basePowerArr)) return 0n;
    const idx = Number(level) - 1;
    if (idx < 0 || idx >= basePowerArr.length) return 0n;
    return toBig(basePowerArr[idx]);
}

/**
 * 从 economy/state 返回的 cooldownBlocks[] 查 level 对应的 cooldown
 * @param {number} level
 * @param {string[]|number[]|bigint[]} cooldownArr
 * @returns {bigint}
 */
export function cooldownForLevel(level, cooldownArr) {
    if (!Array.isArray(cooldownArr)) return 0n;
    const idx = Number(level) - 1;
    if (idx < 0 || idx >= cooldownArr.length) return 0n;
    return toBig(cooldownArr[idx]);
}

/* ==================== 状态徽章样式类 ==================== */
/**
 * 根据 mergeState 返回对应 CSS 类
 * @param {string} state
 * @returns {string}
 */
export function mergeStateClass(state) {
    switch (state) {
        case 'ready': return 'ready';
        case 'cooldown': return 'cooldown';
        case 'terminal': return 'terminal';
        case 'merges_closed': return 'merges_closed';
        default: return '';
    }
}

/* ==================== freshness 中文化 ==================== */
export function freshnessLabel(f) {
    switch (f) {
        case 'fresh': return 'Fresh';
        case 'stale': return 'Stale';
        case 'unavailable': return 'Unavailable';
        case 'online': return 'Online';
        default: return f || '—';
    }
}

/* ==================== settlement queue state 中文化 ==================== */
export function queueStateLabel(s) {
    const map = {
        disabled: 'Disabled',
        empty: 'Empty',
        ready: 'Ready',
        preparing: 'Preparing',
        submitted: 'Submitted',
        retrying: 'Retrying',
        blocked: 'Blocked',
        stale: 'Stale',
    };
    return map[s] || s || '—';
}

/* ==================== oracle state 中文化 ==================== */
export function oracleStateLabel(s) {
    const map = {
        accepted: 'Accepted',
        stale: 'Stale',
        blocked: 'Blocked',
        unavailable: 'Unavailable',
    };
    return map[s] || s || '—';
}

/* ==================== device coreStatus 中文化 ==================== */
export function coreStatusLabel(s) {
    const map = {
        IDLE: 'Idle',
        ACTIVE: 'Active',
        COUNTER_FAULT: 'Counter Fault',
    };
    return map[s] || s || '—';
}

/* ==================== 事件类型中文化 ==================== */
export function eventTypeLabel(t) {
    const map = {
        'system.settlement_completed': 'Settlement',
        'system.mining_checkpointed': 'Checkpoint',
        'account.rewards_claimed': 'Claim',
        'account.claim_recipient_set': 'Set Recipient',
        'account.rewards_staked': 'Stake Rewards',
        'account.sqk_staked': 'Stake SQK',
        'account.sqk_unstaked': 'Unstake SQK',
        'nft.deposited': 'NFT Deposit',
        'nft.withdrawn': 'NFT Withdraw',
        'nft.merged': 'NFT Merge',
        'nft.launch_claimed': 'Launch Claim',
        'measurement.distance_milestone': 'Distance Milestone',
        'measurement.daily_distance_milestone': 'Daily Distance Milestone',
        'measurement.speed_milestone': 'Speed Milestone',
        'measurement.speed_record': 'Speed Record',
        'measurement.distance_streak': 'Distance Streak',
    };
    return map[t] || t || '—';
}

/* ==================== 活动类型中文化 ==================== */
export function activityKindLabel(k) {
    const map = {
        rewards_claimed: 'Claim',
        claim_recipient_set: 'Set Recipient',
        rewards_staked: 'Stake Rewards',
        sqk_staked: 'Stake SQK',
        sqk_unstaked: 'Unstake SQK',
        nft_deposited: 'NFT Deposit',
        nft_withdrawn: 'NFT Withdraw',
        nft_merged: 'NFT Merge',
        nft_launch_claimed: 'Launch Claim',
        nft_transferred: 'NFT Transfer',
    };
    return map[k] || k || '—';
}