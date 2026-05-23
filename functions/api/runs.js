const ALLOWED_MODES = new Set(['normal', 'hard', 'infinite']);
const ALLOWED_OUTCOMES = new Set(['victory', 'death']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function clampInt(value, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function normalizePayload(raw) {
  const runId = String(raw.runId || '').trim();
  const deviceId = String(raw.deviceId || '').trim();
  const mode = String(raw.mode || '').trim();
  const outcome = String(raw.outcome || '').trim();
  if (!UUID_RE.test(runId)) throw new Error('invalid runId');
  if (!UUID_RE.test(deviceId)) throw new Error('invalid deviceId');
  if (!ALLOWED_MODES.has(mode)) throw new Error('invalid mode');
  if (!ALLOWED_OUTCOMES.has(outcome)) throw new Error('invalid outcome');
  return {
    runId,
    deviceId,
    mode,
    outcome,
    playerCount: clampInt(raw.playerCount, 1, 2),
    survivalTime: clampInt(raw.survivalTime, 0, 86400),
    highestLevel: clampInt(raw.highestLevel, 1, 99),
    xp: clampInt(raw.xp, 0, 999999),
    bulletsDodged: clampInt(raw.bulletsDodged, 0, 9999999),
    bulletsSpawned: clampInt(raw.bulletsSpawned, 0, 9999999),
    bulletsHit: clampInt(raw.bulletsHit, 0, 999999),
    totalConversations: clampInt(raw.totalConversations, 0, 9999),
    deaths: clampInt(raw.deaths, 0, 999),
  };
}

async function callSupabaseRpc(env, payload) {
  const url = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return { ok: false, status: 503, data: { ok: false, error: 'Supabase is not configured' } };
  }
  const response = await fetch(`${url}/rest/v1/rpc/record_run_summary`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': key,
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({ payload }),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text || '{}'); } catch (_) { data = { error: 'Invalid Supabase response' }; }
  return { ok: response.ok, status: response.status, data };
}

export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return json({ ok: false, error: 'Method not allowed' }, 405);
  }
  try {
    const rawBody = await context.request.text();
    if (rawBody.length > 8000) return json({ ok: false, error: 'Request too large' }, 413);
    const raw = JSON.parse(rawBody || '{}');
    const payload = normalizePayload(raw);
    const result = await callSupabaseRpc(context.env, payload);
    if (!result.ok) {
      return json({ ok: false, error: result.data?.message || result.data?.error || 'Run upload failed' }, result.status || 502);
    }
    return json(result.data);
  } catch (error) {
    return json({ ok: false, error: error.message || 'Run upload failed' }, 400);
  }
}
