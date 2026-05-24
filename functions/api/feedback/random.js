function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function normalizeLanguage(value) {
  return value === 'en' ? 'en' : value === 'zh-CN' ? 'zh-CN' : '';
}

function mapFeedback(item) {
  return {
    id: item.id,
    type: item.type,
    title: item.title || '',
    content: item.content || '',
    language: item.language || 'zh-CN',
    deviceName: item.device_name || '',
    isResolved: Boolean(item.is_resolved),
    createdAt: item.created_at,
  };
}

function readCount(contentRange) {
  const match = String(contentRange || '').match(/\/(\d+)$/);
  return match ? Number(match[1]) : 0;
}

async function fetchJson(url, key, params, extraHeaders = {}) {
  const response = await fetch(`${url}/rest/v1/player_feedback?${params.toString()}`, {
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      ...extraHeaders,
    },
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text || '[]'); } catch (_) { data = { error: 'Invalid Supabase response' }; }
  return { ok: response.ok, status: response.status, data, headers: response.headers };
}

export async function onRequest(context) {
  if (context.request.method !== 'GET') return json({ ok: false, error: 'Method not allowed' }, 405);
  const supabaseUrl = String(context.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = context.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !key) return json({ ok: false, error: 'Supabase is not configured' }, 503);
  const requestUrl = new URL(context.request.url);
  const language = normalizeLanguage(requestUrl.searchParams.get('language'));
  try {
    const countParams = new URLSearchParams();
    countParams.set('select', 'id');
    countParams.set('limit', '1');
    let useLanguageFilter = Boolean(language);
    if (useLanguageFilter) countParams.set('language', `eq.${language}`);
    let countResult = await fetchJson(supabaseUrl, key, countParams, { Prefer: 'count=exact' });
    let count = countResult.ok ? readCount(countResult.headers.get('content-range')) : 0;
    if (useLanguageFilter && count === 0) {
      useLanguageFilter = false;
      countParams.delete('language');
      countResult = await fetchJson(supabaseUrl, key, countParams, { Prefer: 'count=exact' });
      count = countResult.ok ? readCount(countResult.headers.get('content-range')) : 0;
    }
    if (!countResult.ok) return json({ ok: false, error: countResult.data?.message || countResult.data?.error || 'Feedback unavailable' }, countResult.status || 502);
    if (!count) return json({ ok: true, item: null });
    const itemParams = new URLSearchParams();
    itemParams.set('select', 'id,type,title,content,language,device_name,is_resolved,created_at');
    itemParams.set('order', 'created_at.desc');
    itemParams.set('limit', '1');
    itemParams.set('offset', String(Math.floor(Math.random() * count)));
    if (useLanguageFilter) itemParams.set('language', `eq.${language}`);
    const result = await fetchJson(supabaseUrl, key, itemParams);
    if (!result.ok) return json({ ok: false, error: result.data?.message || result.data?.error || 'Feedback unavailable' }, result.status || 502);
    const item = Array.isArray(result.data) ? result.data[0] : null;
    return json({ ok: true, item: item ? mapFeedback(item) : null });
  } catch (error) {
    return json({ ok: false, error: 'Feedback unavailable' }, 500);
  }
}
