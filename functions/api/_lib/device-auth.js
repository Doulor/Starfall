// 设备归属凭据（报告 #14）。
//
// 现状问题：deviceId 是前端 localStorage 里随机生成的 UUID，服务端此前完全不校验，
// 所以任何人拿到别人的 deviceId 就能改别人的设备名（/api/device）、伪造别人的战绩
// （/api/runs）。可是排行榜接口又把 device_id 原样吐了出来，等于把「别人的 id」
// 直接发给所有人。
//
// 方案：服务端签发、无状态校验的凭据
//   token = v1.<deviceId>.<签发秒>.<HMAC-SHA256 前 32 hex>
// 签名密钥取 DEVICE_TOKEN_SECRET；没有就回落到 SUPABASE_SERVICE_ROLE_KEY
// （它本来就只存在于后端、不得外泄，作为密钥材料够用，且不用新增配置）。
//
// 为什么不用 KV/D1：这个仓库没有绑定任何存储，Pages Functions 的绑定必须在
// Cloudflare Dashboard 里加；而 Supabase 本来就在用，只需要一个「是否已被认领」
// 的标记列（devices.token_bound），迁移 SQL 在 README 里。
//
// 平滑迁移：老玩家库里已经有 devices 行但没有 token。这类行 token_bound=false，
// 首次写操作会「认领」并把 token 下发（见 authorizeDeviceWrite），玩家不需要重注册。
// 如果迁移 SQL 还没执行（列不存在），代码退回迁移前的旧行为只是打警告，避免整个
// 排行榜功能直接坏掉。

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TOKEN_VERSION = 'v1';
// 365 天。设备凭据丢了也不会锁死玩家：前端会重新生成 deviceId 再来一遍。
const TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;
const CLOCK_SKEW_SECONDS = 300;

// devices.token_bound 是否存在，isolate 内缓存一次，避免每请求都试错。
let boundColumnState = 'unknown'; // unknown | available | missing

export function resetBoundColumnStateForTests() {
  boundColumnState = 'unknown';
}

// 设备名清洗：去掉尖括号（防 HTML 注入）、控制字符、零宽字符与双向控制符
// （后者能把昵称伪装成别的样子），再截断到 18 字符（和库里的 check 约束一致）。
export function safeDeviceName(value) {
  return String(value || '')
    .replace(/[<>]/g, '')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, '')
    .trim()
    .slice(0, 18);
}

function tokenSecret(env) {
  const secret = String(env?.DEVICE_TOKEN_SECRET || env?.SUPABASE_SERVICE_ROLE_KEY || '');
  return secret.length >= 16 ? secret : '';
}

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(secret, message) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return toHex(signature);
}

// 定长比较，避免用 === 比较签名带来时序差异。
function timingSafeEqual(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

export async function issueDeviceToken(env, deviceId) {
  const secret = tokenSecret(env);
  if (!secret) return '';
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = `${TOKEN_VERSION}.${deviceId}.${issuedAt}`;
  return `${payload}.${(await hmacHex(secret, payload)).slice(0, 32)}`;
}

export async function verifyDeviceToken(env, deviceId, token) {
  const secret = tokenSecret(env);
  if (!secret) return false;
  const parts = String(token || '').trim().split('.');
  if (parts.length !== 4 || parts[0] !== TOKEN_VERSION) return false;
  const [, tokenDeviceId, issuedAtRaw, signature] = parts;
  if (tokenDeviceId.toLowerCase() !== String(deviceId || '').toLowerCase()) return false;
  const issuedAt = Number(issuedAtRaw);
  if (!Number.isInteger(issuedAt) || issuedAt <= 0) return false;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (issuedAt > nowSeconds + CLOCK_SKEW_SECONDS) return false;
  if (nowSeconds - issuedAt > TOKEN_TTL_SECONDS) return false;
  const expected = (await hmacHex(secret, `${TOKEN_VERSION}.${tokenDeviceId}.${issuedAtRaw}`)).slice(0, 32);
  return timingSafeEqual(expected, signature);
}

// 从 token 反推出它绑定的 deviceId（用在排行榜「哪一行是我」上）。
// 返回 null 表示 token 无效。
export async function deviceIdFromToken(env, token) {
  const secret = tokenSecret(env);
  if (!secret) return null;
  const parts = String(token || '').trim().split('.');
  if (parts.length !== 4 || parts[0] !== TOKEN_VERSION) return null;
  const deviceId = parts[1];
  if (!UUID_RE.test(deviceId)) return null;
  return (await verifyDeviceToken(env, deviceId, token)) ? deviceId : null;
}

// 凭据可以从请求头带（推荐，不会进日志），也可以放在 body 里（兼容老客户端）。
export function readDeviceToken(request, payload) {
  const header = request?.headers?.get?.('x-device-token');
  if (header) return header.trim().slice(0, 200);
  const body = payload?.deviceToken;
  return typeof body === 'string' ? body.trim().slice(0, 200) : '';
}

function supabaseConfig(env) {
  const url = String(env?.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = env?.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url, key };
}

async function supabaseRequest(env, path, init = {}) {
  const config = supabaseConfig(env);
  if (!config) return { ok: false, status: 503, error: 'Leaderboard storage is not configured' };
  const response = await fetch(`${config.url}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'apikey': config.key,
      'Authorization': `Bearer ${config.key}`,
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text || 'null'); } catch (_) { data = null; }
  if (!response.ok) {
    return { ok: false, status: response.status, error: data?.message || data?.error || 'Supabase request failed', data };
  }
  return { ok: true, status: response.status, data };
}

function isMissingBoundColumn(result) {
  if (result?.ok) return false;
  return /token_bound/i.test(String(result?.error || '')) || /42703/.test(String(result?.data?.code || ''));
}

// 读设备行：{ ok, exists, bound }。bound 为 null 表示不知道（列不存在）。
export async function loadDevice(env, deviceId) {
  const select = boundColumnState === 'missing' ? 'id' : 'id,token_bound';
  const result = await supabaseRequest(env, `/rest/v1/devices?id=eq.${encodeURIComponent(deviceId)}&select=${select}&limit=1`);
  if (!result.ok && boundColumnState !== 'missing' && isMissingBoundColumn(result)) {
    // 迁移 SQL 没执行。降级成「只会知道行存在」的模式，并在日志里一直吵。
    boundColumnState = 'missing';
    console.warn('[device-auth] devices.token_bound 列不存在，暂时跳过归属校验。请执行 README 里的迁移 SQL。');
    return loadDevice(env, deviceId);
  }
  if (!result.ok) return { ok: false, status: result.status || 502, error: result.error };
  const row = Array.isArray(result.data) ? result.data[0] : null;
  if (!row) return { ok: true, exists: false, bound: null };
  return { ok: true, exists: true, bound: boundColumnState === 'missing' ? null : row.token_bound !== false };
}

async function insertDevice(env, deviceId, deviceName) {
  const body = { id: deviceId, device_name: deviceName || '', last_seen_at: new Date().toISOString() };
  const withFlag = boundColumnState !== 'missing';
  const attempt = (payload) => supabaseRequest(env, '/rest/v1/devices', {
    method: 'POST',
    headers: { 'Prefer': 'return=representation' },
    body: JSON.stringify(payload),
  });
  const result = await attempt(withFlag ? { ...body, token_bound: true } : body);
  if (!result.ok && withFlag && isMissingBoundColumn(result)) {
    boundColumnState = 'missing';
    console.warn('[device-auth] devices.token_bound 列不存在，暂时跳过归属校验。请执行 README 里的迁移 SQL。');
    return insertDevice(env, deviceId, deviceName);
  }
  if (!result.ok) {
    // 并发下别人先插入了同一行：当成「已存在」交给上层去认领/校验。
    if (result.status === 409) return { ok: false, conflict: true };
    return { ok: false, status: result.status || 502, error: result.error };
  }
  if (withFlag) boundColumnState = 'available';
  return { ok: true, created: true };
}

// 认领一个还没绑定凭据的历史设备行（token_bound=false → true）。
// 条件更新保证并发下只有一个请求能认领成功。
async function claimDevice(env, deviceId, deviceName) {
  if (boundColumnState === 'missing') return { ok: false, unavailable: true };
  const patch = { token_bound: true, last_seen_at: new Date().toISOString() };
  if (deviceName) patch.device_name = deviceName;
  const result = await supabaseRequest(env, `/rest/v1/devices?id=eq.${encodeURIComponent(deviceId)}&token_bound=eq.false`, {
    method: 'PATCH',
    headers: { 'Prefer': 'return=representation' },
    body: JSON.stringify(patch),
  });
  if (!result.ok && isMissingBoundColumn(result)) {
    boundColumnState = 'missing';
    return { ok: false, unavailable: true };
  }
  if (!result.ok) return { ok: false, status: result.status || 502, error: result.error };
  const rows = Array.isArray(result.data) ? result.data : [];
  return { ok: rows.length > 0 };
}

export async function touchDevice(env, deviceId, deviceName) {
  const patch = { last_seen_at: new Date().toISOString() };
  if (deviceName) patch.device_name = deviceName;
  const result = await supabaseRequest(env, `/rest/v1/devices?id=eq.${encodeURIComponent(deviceId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return result.ok;
}

// 写操作的统一入口（/api/device 与 /api/runs 都用它）。
// 返回：
//   { ok: true, deviceToken, auth: 'token' | 'claimed' | 'created' | 'legacy' }
//   { ok: false, status, code, error }
export async function authorizeDeviceWrite(env, options) {
  const deviceId = String(options?.deviceId || '').trim();
  const deviceName = safeDeviceName(options?.deviceName);
  const token = String(options?.token || '').trim();

  if (!UUID_RE.test(deviceId)) {
    return { ok: false, status: 400, code: 'DEVICE_ID_INVALID', error: 'Invalid deviceId' };
  }
  if (!supabaseConfig(env)) {
    return { ok: false, status: 503, code: 'STORAGE_UNAVAILABLE', error: 'Leaderboard storage is not configured' };
  }
  if (!tokenSecret(env)) {
    // 两个密钥都缺：既然 SUPABASE_SERVICE_ROLE_KEY 都没有，上面的分支早就返回了。
    console.warn('[device-auth] 缺少签名密钥，跳过设备归属校验');
    return { ok: true, deviceToken: '', auth: 'legacy' };
  }

  if (token && await verifyDeviceToken(env, deviceId, token)) {
    await touchDevice(env, deviceId, deviceName);
    return { ok: true, deviceToken: token, auth: 'token' };
  }

  const row = await loadDevice(env, deviceId);
  if (!row.ok) {
    return { ok: false, status: row.status || 502, code: 'STORAGE_ERROR', error: 'Device lookup failed' };
  }

  if (!row.exists) {
    const created = await insertDevice(env, deviceId, deviceName);
    if (created.ok) {
      return { ok: true, deviceToken: await issueDeviceToken(env, deviceId), auth: 'created' };
    }
    if (!created.conflict) {
      return { ok: false, status: created.status || 502, code: 'STORAGE_ERROR', error: 'Device registration failed' };
    }
    // 竞态：行刚被创建出来，落到下面的「已存在」分支重新判断。
    const raced = await loadDevice(env, deviceId);
    if (!raced.ok || !raced.exists) {
      return { ok: false, status: 502, code: 'STORAGE_ERROR', error: 'Device registration failed' };
    }
    if (boundColumnState === 'missing') {
      return { ok: true, deviceToken: await issueDeviceToken(env, deviceId), auth: 'legacy' };
    }
    return { ok: false, status: 401, code: 'DEVICE_TOKEN_REQUIRED', error: 'Device credential required' };
  }

  // 已存在的设备：
  //   - token_bound=false 的历史行允许一次性认领（老玩家平滑迁移）；
  //   - 迁移 SQL 未执行时退回旧行为（只打警告，不把功能直接打死）；
  //   - 其余情况必须带有效凭据，否则任何人拿到 deviceId 就能改别人的名字。
  if (row.bound === false) {
    const claimed = await claimDevice(env, deviceId, deviceName);
    if (claimed.ok) {
      return { ok: true, deviceToken: await issueDeviceToken(env, deviceId), auth: 'claimed' };
    }
    if (!claimed.unavailable) {
      return { ok: false, status: 409, code: 'DEVICE_CLAIM_RACE', error: 'Device is already claimed' };
    }
  }
  if (boundColumnState === 'missing') {
    return { ok: true, deviceToken: await issueDeviceToken(env, deviceId), auth: 'legacy' };
  }
  return {
    ok: false,
    status: 401,
    code: token ? 'DEVICE_TOKEN_INVALID' : 'DEVICE_TOKEN_REQUIRED',
    error: 'Device credential required',
  };
}
