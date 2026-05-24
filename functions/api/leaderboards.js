const ALLOWED_MODES = new Set(['normal', 'hard', 'infinite']);

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

function maskDeviceId(id, language = 'zh-CN') {
  const clean = String(id || '').replace(/-/g, '');
  return `${language === 'en' ? 'Starfarer' : '星旅者'} ${clean.slice(-6) || '??????'}`;
}

async function fetchLeaderboard(env, mode, limit, offset) {
  const url = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return { ok: false, status: 503, data: { ok: false, error: 'Supabase is not configured' } };
  }
  const params = new URLSearchParams();
  params.set('mode', `eq.${mode}`);
  params.set('select', 'mode,device_id,device_name,best_run_id,best_survival_time,best_highest_level,best_bullets_dodged,best_outcome,total_runs,total_bullets_dodged,updated_at');
  params.set('order', 'best_survival_time.desc,best_bullets_dodged.desc,best_highest_level.desc,updated_at.asc');
  params.set('limit', String(limit + 1));
  params.set('offset', String(offset));
  const response = await fetch(`${url}/rest/v1/mode_leaderboards?${params.toString()}`, {
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
    },
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text || '[]'); } catch (_) { data = { error: 'Invalid Supabase response' }; }
  return { ok: response.ok, status: response.status, data };
}

export async function onRequest(context) {
  if (context.request.method !== 'GET') {
    return json({ ok: false, error: 'Method not allowed' }, 405);
  }
  const url = new URL(context.request.url);
  const mode = url.searchParams.get('mode') || 'normal';
  const limit = clampInt(url.searchParams.get('limit') || '10', 1, 50);
  const offset = clampInt(url.searchParams.get('offset') || '0', 0, 500);
  const language = url.searchParams.get('language') === 'en' ? 'en' : 'zh-CN';
  if (!ALLOWED_MODES.has(mode)) return json({ ok: false, error: 'Invalid mode' }, 400);
  try {
    const result = await fetchLeaderboard(context.env, mode, limit, offset);
    if (!result.ok) {
      return json({ ok: false, error: result.data?.message || result.data?.error || 'Leaderboard unavailable' }, result.status || 502);
    }
    const rows = Array.isArray(result.data) ? result.data : [];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((item, index) => ({
      rank: offset + index + 1,
      mode: item.mode,
      deviceId: item.device_id,
      deviceName: String(item.device_name || '').trim().slice(0, 18) || maskDeviceId(item.device_id, language),
      displayId: maskDeviceId(item.device_id, language),
      bestRunId: item.best_run_id,
      bestSurvivalTime: Number(item.best_survival_time || 0),
      bestHighestLevel: Number(item.best_highest_level || 1),
      bestBulletsDodged: Number(item.best_bullets_dodged || 0),
      bestOutcome: item.best_outcome || 'death',
      totalRuns: Number(item.total_runs || 0),
      totalBulletsDodged: Number(item.total_bullets_dodged || 0),
      updatedAt: item.updated_at,
    }));
    return json({ ok: true, mode, limit, offset, hasMore, items });
  } catch (error) {
    return json({ ok: false, error: 'Leaderboard unavailable' }, 500);
  }
}
