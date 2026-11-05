/* ============================================================
   Squeekchain Health Monitor - js/api.js
   API 请求统一封装
   - 统一 BASE_URL
   - 统一超时
   - 统一处理 429 / 503 / 504 / 5xx + Retry-After
   - 统一处理 "status": "unavailable"（HTTP 200 但数据未知）
   - 统一 schemaVersion 检查（可选）
   - 同一 path 的并发请求自动合并（in-flight 去重）
   - 每个端点一个便捷方法
   ============================================================ */

export const BASE_URL = 'https://api.squeekchain.com';

const DEFAULT_TIMEOUT = 15000;    // 单次请求超时（毫秒）
const MAX_RETRIES = 3;            // 429 / 503 / 504 / 5xx 最大重试次数
const RETRY_FALLBACK_SECONDS = 2; // 没有 Retry-After 时的默认等待秒数
const RETRY_MAX_WAIT_SECONDS = 60;// 单次等待上限，防止卡死

/* ==================== 错误类型 ==================== */
export class ApiError extends Error {
    constructor(message, { code = '', httpStatus = 0, path = '' } = {}) {
        super(message);
        this.name = 'ApiError';
        this.code = code;
        this.httpStatus = httpStatus;
        this.path = path;
    }
}

/* ==================== 内部：带超时的 fetch ==================== */
async function fetchWithTimeout(url, options = {}, timeout = DEFAULT_TIMEOUT) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

/* ==================== 内部：解析 Retry-After ==================== */
function parseRetryAfter(header) {
    if (!header) return RETRY_FALLBACK_SECONDS;
    const n = Number(header);
    if (!Number.isNaN(n) && n >= 0) {
        return Math.min(n, RETRY_MAX_WAIT_SECONDS);
    }
    const dateMs = Date.parse(header);
    if (!Number.isNaN(dateMs)) {
        const sec = Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
        return Math.min(sec, RETRY_MAX_WAIT_SECONDS);
    }
    return RETRY_FALLBACK_SECONDS;
}

/* ==================== 内部：单次请求 + 重试 ==================== */
async function doRequest(path, options, attempt = 0) {
    const url = BASE_URL + path;
    const { timeout, ...fetchOpts } = options;

    let resp;
    try {
        resp = await fetchWithTimeout(url, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            ...fetchOpts,
        }, timeout);
    } catch (e) {
        if (e.name === 'AbortError') {
            throw new ApiError('请求超时', { code: 'timeout', path });
        }
        throw new ApiError('网络错误: ' + e.message, { code: 'network', path });
    }

    // 可重试的 HTTP 状态码
    const retryable =
        resp.status === 429 ||
        resp.status === 503 ||
        resp.status === 504 ||
        resp.status >= 500;

    if (retryable && attempt < MAX_RETRIES) {
        const waitSec = parseRetryAfter(resp.headers.get('Retry-After'));
        await new Promise(r => setTimeout(r, waitSec * 1000));
        return doRequest(path, options, attempt + 1);
    }

    // 解析 JSON
    let body = null;
    const text = await resp.text();
    if (text) {
        try { body = JSON.parse(text); } catch { body = null; }
    }

    // 非 2xx
    if (!resp.ok) {
        const code = (body && body.error) || ('http_' + resp.status);
        throw new ApiError(
            `HTTP ${resp.status}${body && body.error ? ' (' + body.error + ')' : ''}`,
            { code, httpStatus: resp.status, path }
        );
    }

    // 2xx 但响应不是 JSON
    if (!body) {
        throw new ApiError('响应不是有效 JSON', {
            code: 'invalid_json', httpStatus: resp.status, path,
        });
    }

    // "status": "unavailable" 是合法响应，代表“数据未知”
    // 注意：绝不能当成 0 或空数组
    if (body.status === 'unavailable') {
        return {
            status: 'unavailable',
            reason: body.reason || 'unknown',
            raw: body,
        };
    }

    return { status: 'ok', data: body };
}

/* ==================== 内部：in-flight 去重 ==================== */
// 同一个 path 正在请求时，复用同一个 Promise，避免重复请求
const inFlight = new Map();

/* ==================== 对外：统一 GET ==================== */
/**
 * @param {string} path  形如 '/v1/core'
 * @param {object} [options]
 * @param {number} [options.timeout]         毫秒，默认 15000
 * @param {string[]} [options.expectSchema]  允许的 schemaVersion 列表，不传则不检查
 * @returns {Promise<
 *   {status:'ok', data:any} |
 *   {status:'unavailable', reason:string, raw:any}
 * >}
 * @throws {ApiError}
 */
export async function apiGet(path, options = {}) {
    const key = path;
    if (inFlight.has(key)) return inFlight.get(key);

    const p = (async () => {
        const result = await doRequest(path, options);

        // schemaVersion 检查（可选）
        if (options.expectSchema && result.status === 'ok' && result.data) {
            const ver = result.data.schemaVersion;
            if (ver !== undefined && !options.expectSchema.includes(String(ver))) {
                throw new ApiError(
                    `不支持的 schemaVersion: ${ver}（期望 ${options.expectSchema.join(' / ')}）`,
                    { code: 'schema_mismatch', path }
                );
            }
        }

        return result;
    })();

    inFlight.set(key, p);
    try {
        return await p;
    } finally {
        inFlight.delete(key);
    }
}

/* ==================== 对外：每个端点一个方法 ==================== */
export const api = {
    /* ---------- 健康检查（不解析 JSON，只看 HTTP 200） ---------- */
    async healthz() {
        try {
            const resp = await fetchWithTimeout(BASE_URL + '/healthz', {}, 5000);
            return resp.ok;
        } catch { return false; }
    },

    async readyz() {
        try {
            const resp = await fetchWithTimeout(BASE_URL + '/readyz', {}, 5000);
            return resp.ok;
        } catch { return false; }
    },

    /* ---------- 自动轮询的端点 ---------- */
    status() {
        return apiGet('/v1/status');
    },

    core() {
        return apiGet('/v1/core');
    },

    economyState() {
        return apiGet('/v1/economy/state');
    },

    measurementBlocks() {
        return apiGet('/v1/measurement/blocks');
    },

    settlements(range = '24h') {
        return apiGet(`/v1/settlements?range=${encodeURIComponent(range)}`);
    },

    events(category = 'all', limit = 40) {
        return apiGet(`/v1/events?category=${encodeURIComponent(category)}&limit=${limit}`);
    },

    /* ---------- 点击加载的端点 ---------- */
    measurementStats(range) {
        // range 只能是 '7d' 或 '30d'
        return apiGet(`/v1/measurement/stats?range=${encodeURIComponent(range)}`);
    },

    account(address, cursor = null, limit = 25) {
        const q = new URLSearchParams({ limit: String(limit) });
        if (cursor) q.set('cursor', cursor);
        return apiGet(`/v1/accounts/${encodeURIComponent(address)}?${q.toString()}`);
    },

    accountActivity(address, cursor = null, limit = 25) {
        const q = new URLSearchParams({ limit: String(limit) });
        if (cursor) q.set('cursor', cursor);
        return apiGet(`/v1/accounts/${encodeURIComponent(address)}/activity?${q.toString()}`);
    },

    squeek(tokenId) {
        return apiGet(`/v1/squeeks/${encodeURIComponent(tokenId)}`);
    },
};