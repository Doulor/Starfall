// 每 IP 的固定窗口限流 + 每日配额。
//
// 为什么要它：/api/dialogue 用的是运营方在 Cloudflare 环境变量里配的 Key，
// 之前完全没有鉴权也没有限流（报告 #31），任何人都能拿本服务当免费 LLM 代理，
// 一个脚本就能把额度刷光。
//
// 为什么是进程内 Map：Pages Functions 里没有绑定 KV / D1，代码里也无法声明绑定，
// 所以每个 isolate 各持一份计数。这是「尽力而为」的第一道闸：单 isolate 内准确，
// 跨 isolate 只能近似（大致是用户数 × isolate 数）。要真正的全局限流，还得在
// Cloudflare 侧叠 WAF Rate limiting 规则，README 的「安全注意事项」里有说明。
// 这一层挡的是脚本刷额度和明显滥用，不需要多精确。

const buckets = new Map();
const MAX_TRACKED_KEYS = 4000;

export function envInt(env, name, fallback, min, max) {
  const parsed = Number.parseInt(env?.[name] ?? '', 10);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, value));
}

// 取调用方 IP：Cloudflare 会带上 CF-Connecting-IP。
// 本地 wrangler dev 没有这个头，退化成一个固定 key（本地开发不需要限流）。
export function clientIp(request) {
  const cf = request.headers.get('CF-Connecting-IP');
  if (cf) return cf.trim();
  const forwarded = request.headers.get('X-Forwarded-For');
  if (forwarded) return forwarded.split(',')[0].trim();
  return 'local';
}

function todayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// 清掉过期的桶，避免 isolate 长时间存活后 Map 无限增长。
function prune(now) {
  if (buckets.size <= MAX_TRACKED_KEYS) return;
  const day = todayKey(now);
  for (const [key, bucket] of buckets) {
    const minuteExpired = now - bucket.minuteStart >= 120000;
    const dayExpired = bucket.day !== day;
    if (minuteExpired && dayExpired) buckets.delete(key);
  }
}

// 计一次额度。返回 { ok: true, remaining } 或
// { ok: false, code, retryAfter }（retryAfter 单位：秒）。
export function takeQuota(env, key, options = {}) {
  const now = Date.now();
  const perMinute = options.perMinute ?? envInt(env, 'AI_RATE_LIMIT_PER_MINUTE', 20, 1, 600);
  const perDay = options.perDay ?? envInt(env, 'AI_DAILY_QUOTA_PER_IP', 200, 1, 100000);
  const day = todayKey(now);

  prune(now);

  let bucket = buckets.get(key);
  if (!bucket || now - bucket.minuteStart >= 60000) {
    bucket = { minuteStart: now, minuteCount: 0, day, dayCount: bucket && bucket.day === day ? bucket.dayCount : 0 };
    buckets.set(key, bucket);
  }
  if (bucket.day !== day) {
    bucket.day = day;
    bucket.dayCount = 0;
  }

  if (bucket.minuteCount >= perMinute) {
    const retryAfter = Math.max(1, Math.ceil((60000 - (now - bucket.minuteStart)) / 1000));
    return { ok: false, code: 'RATE_LIMITED', error: 'Too many requests', retryAfter };
  }
  if (bucket.dayCount >= perDay) {
    const retryAfter = Math.max(1, Math.ceil((86400000 - (now % 86400000)) / 1000));
    return { ok: false, code: 'DAILY_QUOTA_EXCEEDED', error: 'Daily quota exceeded', retryAfter };
  }

  bucket.minuteCount += 1;
  bucket.dayCount += 1;
  return { ok: true, remaining: Math.max(0, perDay - bucket.dayCount) };
}

// 只读检查：某些路径（比如调试接口）只想知道「现在超没超」，不占额度。
export function peekQuota(env, key) {
  const bucket = buckets.get(key);
  if (!bucket) return { ok: true };
  const now = Date.now();
  if (now - bucket.minuteStart < 60000 && bucket.minuteCount >= envInt(env, 'AI_RATE_LIMIT_PER_MINUTE', 20, 1, 600)) {
    return { ok: false, code: 'RATE_LIMITED', retryAfter: Math.max(1, Math.ceil((60000 - (now - bucket.minuteStart)) / 1000)) };
  }
  return { ok: true };
}

// 仅供测试使用：清空计数。
export function __resetQuotaForTests() {
  buckets.clear();
}
