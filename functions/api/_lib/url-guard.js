// 出网守卫：所有「服务端按玩家提供的地址去发请求」的路径都必须先过这里。
//
// 背景：/api/dialogue 支持玩家自带 Key（custom provider），服务端会真的按
// custom.baseUrl 发 POST，并把玩家填的 Bearer Key 一起带上。如果不校验，任何人都能：
//   1. 让本服务当 SSRF 跳板去打内网 / 回环 / 云元数据端点（169.254.169.254）；
//   2. 把自己的域名填进 baseUrl，让服务端把构造好的系统提示词原样送到自己手里；
//   3. 把本服务当成「任意 Bearer 转发器」白嫖代理。
// 所以这里做四件事：协议/端口/凭据校验 → 主机字面量的内网判定 → 主机白名单 →
// 逐跳校验的重定向（redirect: 'manual'），避免一个 302 把请求（连同 Authorization）
// 带到白名单之外。
//
// 注意：Worker/Pages Functions 里没法「先 DNS 解析再校验」（TOCTOU），所以只做字面量
// 判断。这一层的目标是挡住明显的探测与探测绕过，而不是替代出网防火墙。

// 通配 DNS 服务：A.B.C.D.nip.io 之类的子域名本身看不出内网，但会解析到内网地址，
// 属于最常见的白名单绕过手法，直接按后缀封掉。
const WILDCARD_DNS_SUFFIXES = [
  'nip.io', 'sslip.io', 'xip.io', 'lvh.me', 'localtest.me', 'traefik.me', 'vcap.me', 'lacolhost.com',
];
// 特殊用途域名后缀：mDNS / 私有云内网域名 / 私有 DNS。
const BLOCKED_HOST_SUFFIXES = ['.local', '.localhost', '.internal', '.home.arpa', '.localdomain', '.intranet'];

// 默认的 custom provider 主机白名单：常见的 OpenAI-compatible 服务。
// 运营方可以用 AI_CUSTOM_ALLOWED_HOSTS 覆盖它（逗号分隔，前缀 . 表示允许子域名）。
const DEFAULT_ALLOWED_AI_HOSTS = [
  'api.openai.com',
  'api.deepseek.com',
  'api.moonshot.cn',
  'api.moonshot.ai',
  'open.bigmodel.cn',
  'dashscope.aliyuncs.com',
  'api.siliconflow.cn',
  'api.groq.com',
  'openrouter.ai',
  'api.mistral.ai',
  'api.together.xyz',
  'api.x.ai',
  'api.perplexity.ai',
  'api.302.ai',
  'qianfan.baidubce.com',
  'ark.cn-beijing.volces.com',
  'api.minimax.chat',
  'api.hunyuan.cloud.tencent.com',
  'generativelanguage.googleapis.com',
];

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 2;

function normalizeHost(host) {
  return String(host || '').trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
}

function envFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

// 只做字面量判断：本机 / 内网 / 链路本地 / CGNAT / 组播 / 保留段 / IPv6 字面量。
// 公网 IPv4 字面量本身不算私网，但 custom provider 那边会再拒一次（白名单按域名走）。
export function isPrivateOrLocalHost(host) {
  const h = normalizeHost(host);
  if (!h) return true;
  if (h === 'localhost') return true;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => h.endsWith(suffix))) return true;
  if (WILDCARD_DNS_SUFFIXES.some((suffix) => h === suffix || h.endsWith(`.${suffix}`))) return true;
  // 不带点的主机名（http://intranet/ 这种）在公网没有任何意义，按可疑处理。
  if (!h.includes('.') && !h.includes(':')) return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const octets = [Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4])];
    if (octets.some((n) => n > 255)) return true;
    const [a, b, c] = octets;
    if (a === 0 || a === 10 || a === 127) return true;              // 0.0.0.0/8 本机 回环
    if (a === 169 && b === 254) return true;                        // 链路本地 + 云元数据
    if (a === 172 && b >= 16 && b <= 31) return true;               // 私有段
    if (a === 192 && b === 168) return true;                        // 私有段
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;   // 保留 / TEST-NET-1
    if (a === 198 && (b === 18 || b === 19)) return true;           // 基准测试网段
    if (a === 198 && b === 51 && c === 100) return true;            // TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return true;             // TEST-NET-3
    if (a === 100 && b >= 64 && b <= 127) return true;              // CGNAT 100.64.0.0/10
    if (a >= 224) return true;                                      // 组播 224/4 + 保留 240/4
    return false;
  }

  // 任何 IPv6 字面量（::1、fe80::、fd00::、::ffff:127.0.0.1…）一律拒：正常 API 用不到，
  // 而且 IPv6 的等价写法太多，白名单按域名走更安全。
  if (h.includes(':')) return true;
  return false;
}

// 运营方白名单；空 = 用内置默认表。
export function customHostAllowlist(env) {
  const raw = String(env?.AI_CUSTOM_ALLOWED_HOSTS || '').trim();
  if (!raw) return DEFAULT_ALLOWED_AI_HOSTS;
  return raw.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

export function isCustomHostAllowed(host, env) {
  // 逃生门：运营方明确要求「允许玩家连自建端点」时才打开；此时仍受上面的
  // 内网/协议/重定向校验约束，只是跳过域名白名单。
  if (envFlag(env?.AI_CUSTOM_ALLOW_ANY_HOST)) return true;
  const h = normalizeHost(host);
  return customHostAllowlist(env).some((entry) => (
    entry.startsWith('.') ? (h === entry.slice(1) || h.endsWith(entry)) : h === entry
  ));
}

// 校验一个玩家提交的 custom provider 地址。
// 成功返回 { ok: true, url }，失败返回 { ok: false, code, error }（错误文案不回声原始地址，
// 避免把玩家的输入原样写回响应里）。
export function resolveCustomProvider(raw, env) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return { ok: false, code: 'CUSTOM_URL_MISSING', error: 'Custom API endpoint is required' };
  if (trimmed.length > 500) return { ok: false, code: 'CUSTOM_URL_INVALID', error: 'Custom API endpoint is too long' };

  let url;
  try {
    url = new URL(trimmed);
  } catch (_) {
    return { ok: false, code: 'CUSTOM_URL_INVALID', error: 'Custom API endpoint is not a valid URL' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, code: 'CUSTOM_URL_INSECURE', error: 'Custom API endpoint must use https' };
  }
  if (url.username || url.password) {
    return { ok: false, code: 'CUSTOM_URL_CREDENTIALS', error: 'Custom API endpoint must not embed credentials' };
  }
  if (url.port && url.port !== '443') {
    return { ok: false, code: 'CUSTOM_URL_PORT', error: 'Custom API endpoint must use the default https port' };
  }
  if (isPrivateOrLocalHost(url.hostname)) {
    return { ok: false, code: 'CUSTOM_URL_PRIVATE', error: 'Custom API endpoint must not point to a private or local address' };
  }
  if (!isCustomHostAllowed(url.hostname, env)) {
    return { ok: false, code: 'CUSTOM_URL_NOT_ALLOWED', error: 'Custom API endpoint host is not in the allowlist' };
  }
  return { ok: true, url };
}

// 带守卫的 custom provider 请求：手动跟随重定向，每一跳都重新校验。
// 跨源重定向直接拒绝（否则玩家的 Bearer Key 会被送到另一个主机上）。
export async function fetchCustomProvider(env, rawUrl, options = {}) {
  const { apiKey, body, headers = {}, signal } = options;
  let current;
  let origin = '';
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const checked = resolveCustomProvider(current ? current.href : rawUrl, env);
    if (!checked.ok) return { ok: false, code: checked.code, error: checked.error };
    if (!origin) origin = checked.url.origin;
    const request = await fetch(checked.url.href, {
      method: 'POST',
      // 关键：不能让运行时自动跟随 302，否则 Authorization 会跟着跳到白名单外的地址。
      redirect: 'manual',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        ...headers,
      },
      body,
    });
    if (!REDIRECT_STATUSES.has(request.status)) return { ok: true, response: request };
    const location = request.headers.get('Location');
    if (!location) return { ok: false, code: 'CUSTOM_REDIRECT_INVALID', error: 'Upstream redirect has no target' };
    let next;
    try {
      next = new URL(location, checked.url);
    } catch (_) {
      return { ok: false, code: 'CUSTOM_REDIRECT_INVALID', error: 'Upstream redirect target is invalid' };
    }
    if (next.origin !== origin) {
      return { ok: false, code: 'CUSTOM_REDIRECT_REFUSED', error: 'Upstream redirect leaves the allowed origin' };
    }
    current = next;
  }
  return { ok: false, code: 'CUSTOM_REDIRECT_REFUSED', error: 'Too many upstream redirects' };
}

export { DEFAULT_ALLOWED_AI_HOSTS };
