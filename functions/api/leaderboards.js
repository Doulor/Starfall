import { deviceIdFromToken, readDeviceToken, safeDeviceName } from './_lib/device-auth.js';

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
  // device_id 仍然要查（服务端要拿它算脱敏展示名和 isMe），但绝不写回响应；
  // best_run_id 连查都不查 —— 它是 run_summaries 的主键，公开之后配合
  // /api/runs 的 on conflict 就能抢别人的成绩行（报告 #14）。
  params.set('select', 'mode,device_id,device_name,best_survival_time,best_highest_level,best_bullets_dodged,best_outcome,total_runs,total_bullets_dodged,updated_at');
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
    // 带设备凭据的请求才能标出"哪一行是自己"，凭据只用来判断归属，不做任何鉴权拦截：
    // 排行榜本来就是公开只读数据。
    const token = readDeviceToken(context.request, null);
    const selfDeviceId = token ? await deviceIdFromToken(context.env, token) : null;

    const result = await fetchLeaderboard(context.env, mode, limit, offset);
    if (!result.ok) {
      return json({ ok: false, error: result.data?.message || result.data?.error || 'Leaderboard unavailable' }, result.status || 502);
    }
    const rows = Array.isArray(result.data) ? result.data : [];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((item, index) => ({
      rank: offset + index + 1,
      mode: item.mode,
      // deviceId 现在是脱敏展示 id，不再是真实的设备 UUID。
      deviceId: maskDeviceId(item.device_id, language),
      // 昵称是玩家自己起、用于公开展示的名字，保持原样（只做控制字符/零宽字符清洗）。
      // 它会变成别人也能写进隐私信息（比如填手机号）——但那属于玩家自曝，
      // 而且以前真正的风险是"别人能改你的昵称"，那条已经在 /api/device 修掉。
      deviceName: safeDeviceName(item.device_name) || maskDeviceId(item.device_id, language),
      displayId: maskDeviceId(item.device_id, language),
      isMe: Boolean(selfDeviceId && String(item.device_id || '').toLowerCase() === selfDeviceId.toLowerCase()),
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
