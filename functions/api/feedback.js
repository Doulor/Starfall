const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i;
const ALLOWED_TYPES = new Set(['suggestion', 'bug', 'optimization', 'other']);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function cleanText(value, max, keepNewlines = false) {
  return String(value || '')
    .replace(/[<>]/g, '')
    .split('')
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      if (keepNewlines && (ch === '\n' || ch === '\r' || ch === '\t')) return true;
      return c >= 32 && c !== 127;
    })
    .join('')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, max);
}

function safeDeviceName(value) {
  return cleanText(value, 18, false);
}

function normalizeType(value) {
  const type = String(value || 'suggestion').trim();
  return ALLOWED_TYPES.has(type) ? type : 'suggestion';
}

function normalizeLanguage(value) {
  return value === 'en' ? 'en' : 'zh-CN';
}

function mapFeedback(item) {
  return {
    id: item.id,
    type: item.type,
    title: item.title || '',
    content: item.content || '',
    language: item.language || 'zh-CN',
    deviceId: item.device_id || '',
    deviceName: item.device_name || '',
    isResolved: Boolean(item.is_resolved),
    createdAt: item.created_at,
  };
}

async function insertFeedback(env, payload) {
  const url = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { ok: false, status: 503, data: { ok: false, error: 'Supabase is not configured' } };
  const response = await fetch(`${url}/rest/v1/player_feedback`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text || '[]'); } catch (_) { data = { error: 'Invalid Supabase response' }; }
  return { ok: response.ok, status: response.status, data };
}

export async function onRequest(context) {
  if (context.request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);
  try {
    const rawBody = await context.request.text();
    if (rawBody.length > 4000) return json({ ok: false, error: 'Request too large' }, 413);
    const payload = JSON.parse(rawBody || '{}');
    const type = normalizeType(payload.type);
    const title = cleanText(payload.title, 80, false);
    const content = cleanText(payload.content, 1200, true);
    const language = normalizeLanguage(payload.language);
    const deviceId = String(payload.deviceId || '').trim();
    const deviceName = safeDeviceName(payload.deviceName);
    const userAgent = cleanText(payload.userAgent, 180, false);
    if (content.length < 5) return json({ ok: false, error: 'Feedback content is required' }, 400);
    if (deviceId && !UUID_RE.test(deviceId)) return json({ ok: false, error: 'Invalid deviceId' }, 400);
    const result = await insertFeedback(context.env, {
      type,
      title: title || null,
      content,
      language,
      device_id: deviceId || null,
      device_name: deviceName || null,
      user_agent: userAgent || null,
      is_resolved: false,
    });
    if (!result.ok) return json({ ok: false, error: result.data?.message || result.data?.error || 'Feedback submit failed' }, result.status || 502);
    const item = Array.isArray(result.data) ? result.data[0] : result.data;
    return json({ ok: true, item: mapFeedback(item || {}) });
  } catch (error) {
    return json({ ok: false, error: 'Feedback submit failed' }, 500);
  }
}
