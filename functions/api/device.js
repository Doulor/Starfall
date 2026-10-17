import { authorizeDeviceWrite, readDeviceToken, safeDeviceName } from './_lib/device-auth.js';
import { takeQuota, clientIp } from './_lib/rate-limit.js';

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

// 写设备名（报告 #14）。
// 以前 deviceId 完全来自请求体，任何人不用登录就能改任何人的设备名。
// 现在必须带服务端签发的设备凭据（x-device-token）；只有「这台设备还没被创建」
// 或「历史设备还没被认领」时，才允许不带凭据地创建/认领一次，并当场把凭据下发，
// 老玩家因此不需要重新注册。
export async function onRequest(context) {
  if (context.request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  const ip = clientIp(context.request);
  const quota = takeQuota(context.env, `device:${ip}`, { perMinute: 30, perDay: 2000 });
  if (!quota.ok) {
    return json({ ok: false, error: quota.error, code: quota.code }, 429, { 'Retry-After': String(quota.retryAfter || 60) });
  }

  try {
    const rawBody = await context.request.text();
    if (rawBody.length > 2000) return json({ ok: false, error: 'Request too large' }, 413);
    const payload = JSON.parse(rawBody || '{}');
    const deviceId = String(payload.deviceId || '').trim();
    const deviceName = safeDeviceName(payload.deviceName);
    if (!deviceName) return json({ ok: false, error: 'Device name is required', code: 'DEVICE_NAME_REQUIRED' }, 400);

    const auth = await authorizeDeviceWrite(context.env, {
      deviceId,
      deviceName,
      token: readDeviceToken(context.request, payload),
    });
    if (!auth.ok) {
      // 401 时带上 code，前端据此重新签发设备身份，而不是让玩家卡死。
      return json({ ok: false, error: auth.error, code: auth.code }, auth.status || 502);
    }
    // deviceToken 只在签发/认领时回传，客户端自己存 localStorage；
    // 不带凭据时服务端永远不会替客户端「找回」别人的设备。
    return json({
      ok: true,
      deviceId,
      deviceName,
      auth: auth.auth,
      ...(auth.deviceToken ? { deviceToken: auth.deviceToken } : {}),
    });
  } catch (error) {
    return json({ ok: false, error: 'Device name sync failed' }, 500);
  }
}
