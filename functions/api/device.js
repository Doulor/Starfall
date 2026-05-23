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

function safeDeviceName(value) {
  return String(value || '').replace(/[<>]/g, '').split('').filter((ch) => {
    const c = ch.charCodeAt(0);
    return c >= 32 && c !== 127;
  }).join('').trim().slice(0, 18);
}

async function upsertDeviceName(env, deviceId, deviceName) {
  const url = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { ok: false, status: 503, data: { ok: false, error: 'Supabase is not configured' } };
  const response = await fetch(`${url}/rest/v1/devices?on_conflict=id`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Prefer': 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify({ id: deviceId, device_name: deviceName, last_seen_at: new Date().toISOString() }),
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
    if (rawBody.length > 2000) return json({ ok: false, error: 'Request too large' }, 413);
    const payload = JSON.parse(rawBody || '{}');
    const deviceId = String(payload.deviceId || '').trim();
    const deviceName = safeDeviceName(payload.deviceName);
    if (!UUID_RE.test(deviceId)) return json({ ok: false, error: 'Invalid deviceId' }, 400);
    if (!deviceName) return json({ ok: false, error: 'Device name is required' }, 400);
    const result = await upsertDeviceName(context.env, deviceId, deviceName);
    if (!result.ok) return json({ ok: false, error: result.data?.message || result.data?.error || 'Device name sync failed' }, result.status || 502);
    return json({ ok: true, deviceId, deviceName });
  } catch (error) {
    return json({ ok: false, error: 'Device name sync failed' }, 500);
  }
}
