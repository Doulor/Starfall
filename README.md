# 星碎 · Starfall

**星碎 · Starfall** 是一款单文件 H5 弹幕躲避 + AI 对话游戏。玩家醒在破碎星域，面对星门守卫 Luna 的试炼：一边躲避不断变化的弹幕，一边通过对话理解她、影响她、说服她，最终让星门显形并通过试炼。

项目主体是一个 `index.html`，后端使用 Cloudflare Pages Functions 提供 AI 对话与排行榜 API，排行榜数据存储在 Supabase PostgreSQL。

## 主要特色

- **弹幕躲避核心玩法**：Boss Luna 会使用星雨、螺旋、追踪、激光、重力井、夹击、狙击、星雷等多种弹幕模式。
- **成长与技能系统**：通过收集 XP 升级，解锁星脉冲、星步、时滞、星爆、相位、磁吸、星幕等能力。
- **AI 对话驱动战斗**：玩家说的话会影响 Luna 的态度、下一轮攻击方式、是否放水、是否清弹、是否给护盾。
- **Boss 主动开场**：战斗间歇自动触发对话时，优先由 AI 根据已有聊天上下文生成 Luna 的开场白，失败时回退本地预设。
- **剧情通关目标**：普通/困难模式中，玩家需要推进对话、获得信任，让星门显形并进入星门。
- **多模式支持**：普通模式、困难模式、无限模式。
- **本地兜底规则**：在线 AI 不可用时仍可使用本地规则继续游戏。
- **排行榜与设备昵称**：通过 Supabase 保存成绩、设备昵称与各模式排行榜。
- **桌面与移动端适配**：桌面支持键盘与双人，移动端建议横屏全屏，支持任意位置滑动控制。
- **跨局聊天记忆**：可选开启本机浏览器内的聊天记忆，让 Luna 在后续局中参考过往对话。

## 游戏的内涵

《星碎》表面上是弹幕试炼，核心其实是“在冲突中建立理解”。

Luna 不是单纯的敌人，而是守门人：她必须阻拦玩家，却也会被玩家的真诚、关心、提问和选择影响。弹幕代表压力、误解与考验；对话代表沟通、共情与信任。玩家并不是只靠操作战胜 Boss，而是在一次次闪避和交流中证明自己不是闯入者，而是能够理解星门问题的人。

星门也不是普通出口，它更像一道选择题：当 Luna 开始相信玩家，星门才会真正显形。游戏希望表达的是：通关不只是“击败谁”，也可以是“理解谁”。

## 项目结构

```text
.
├── index.html                    # 游戏主体：HTML / CSS / Canvas / 前端逻辑
└── functions/
    └── api/
        ├── dialogue.js           # AI 对话接口，支持默认 API、备用 API、自定义 API
        ├── runs.js               # 上传单局成绩到 Supabase RPC
        ├── leaderboards.js       # 从 Supabase 读取排行榜
        └── device.js             # 同步设备昵称到 Supabase
```

## 本地运行

基础游戏是静态页面，可以直接打开 `index.html`。

如果只想静态预览：

```bash
python3 -m http.server 4173
```

然后访问：

```text
http://127.0.0.1:4173/
```

如果需要测试 `/api/*` Pages Functions，建议使用 Wrangler：

```bash
npx wrangler pages dev .
```

然后根据终端输出访问本地地址。

## 操作方式

### 桌面端

- P1 移动：`W A S D`
- P2 移动：方向键
- 慢速/专注：`Shift`
- 技能：
  - `Space` 星脉冲
  - `E` 星步
  - `Q` 时滞
  - `R` 星爆
  - `F` 相位

### 移动端

- 建议横屏 + 全屏游玩。
- 游戏中按住屏幕任意位置并滑动，小球会沿滑动方向移动。
- 松手后停止移动。
- 对话框默认不会自动弹出键盘，需要手动点击输入框。

## 游戏模式

- **普通模式**：默认剧情试炼，包含对话、剧情推进与通关目标。
- **困难模式**：弹幕更密，Luna 更难被说服。
- **无限模式**：无剧情通关和对话，直到三次死亡结束。

## AI 对话逻辑

前端通过 `DialogueAI` 管理对话，后端接口为：

```text
POST /api/dialogue
```

### 前端 AI 模式

游戏设置中可选择：

1. **默认在线 AI**
   - 请求同源 `/api/dialogue`。
   - 后端读取 Cloudflare 环境变量中的 API 配置。

2. **自定义 API**
   - 玩家在设置里填写自己的 Base URL、API Key 和模型。
   - 仍然通过 `/api/dialogue` 转发。
   - 使用自定义 API 时，只使用玩家填写的 custom provider，不会再尝试 Cloudflare 环境变量里的默认/备用 API。

3. **本地规则**
   - 完全离线。
   - 不请求 AI。
   - 使用前端内置规则生成 Luna 的回复与行为。

### `/api/dialogue` 请求类型

后端支持两类 `intent`：

```text
intent: "reply"
```

玩家发送一句话后，AI 返回：

- Luna 的回复文本；
- 态度变化；
- 下一轮攻击行为；
- 是否继续聊天；
- 推荐玩家回复；
- 剧情推进；
- 是否奖励护盾或清弹。

```text
intent: "opening"
```

战斗自动暂停并触发对话时，AI 根据已有聊天上下文生成 Luna 主动开场白。

AI 调用失败时：

- `reply` 回退到本地规则。
- `opening` 回退到原本的内置预设开场白。

## AI 环境变量

后端使用 OpenAI-compatible Chat Completions API。

### 主 API

```text
AI_API_KEY       # 必填：主 API Key
AI_BASE_URL      # 可选：默认 https://api.openai.com/v1/chat/completions
AI_MODEL         # 可选：默认 gpt-4o-mini
AI_TIMEOUT_MS    # 可选：默认 12000，范围 3000-30000，单位毫秒
```

### 备用 API

最多支持 `2` 到 `10` 号备用 API：

```text
AI_API_KEY_2
AI_BASE_URL_2    # 可选，不填则继承 AI_BASE_URL
AI_MODEL_2       # 可选，不填则继承 AI_MODEL

AI_API_KEY_3
AI_BASE_URL_3
AI_MODEL_3

...

AI_API_KEY_10
AI_BASE_URL_10
AI_MODEL_10
```

调用顺序：

1. `AI_API_KEY`
2. `AI_API_KEY_2`
3. `AI_API_KEY_3`
4. ...
5. `AI_API_KEY_10`

每个 provider 失败后自动尝试下一个；成功一个就停止。失败类型包括：

- 请求超时；
- 上游状态码错误；
- 上游返回非 JSON；
- 模型输出不是可解析 JSON；
- 模型返回空内容。

后端默认会使用 `response_format: { type: "json_object" }`。如果上游不支持 JSON mode，并返回相关错误，会自动用普通模式重试同一个 provider。

## Supabase 排行榜环境变量

排行榜相关接口使用 Supabase REST / RPC。

需要在 Cloudflare Pages 中配置：

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

说明：

- `SUPABASE_URL`：Supabase 项目 URL，例如 `https://xxxx.supabase.co`。
- `SUPABASE_SERVICE_ROLE_KEY`：Supabase 的 service role key。
- service role key 只能放在 Cloudflare 后端环境变量中，绝不能写进前端代码或公开仓库。

相关接口：

```text
POST /api/runs
GET  /api/leaderboards?mode=normal|hard|infinite&limit=20
POST /api/device
```

其中：

- `/api/runs` 调用 Supabase RPC：`record_run_summary`
- `/api/leaderboards` 读取 Supabase 视图：`mode_leaderboards`
- `/api/device` 直接 upsert `devices` 表

## 一键创建 Supabase 数据库结构

进入 Supabase 项目后台：

```text
Project Dashboard -> SQL Editor -> New query
```

粘贴并运行下面整段 SQL，即可创建本项目需要的表、视图、RPC 函数和权限。

```sql
begin;

create table if not exists public.devices (
  id uuid primary key,
  device_name text not null default '',
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint devices_device_name_length check (char_length(device_name) <= 18)
);

create table if not exists public.run_summaries (
  run_id uuid primary key,
  device_id uuid not null references public.devices(id) on delete cascade,
  device_name text not null default '',
  mode text not null check (mode in ('normal', 'hard', 'infinite')),
  outcome text not null check (outcome in ('victory', 'death')),
  player_count integer not null default 1 check (player_count between 1 and 2),
  survival_time integer not null default 0 check (survival_time >= 0),
  highest_level integer not null default 1 check (highest_level >= 1),
  xp integer not null default 0 check (xp >= 0),
  bullets_dodged integer not null default 0 check (bullets_dodged >= 0),
  bullets_spawned integer not null default 0 check (bullets_spawned >= 0),
  bullets_hit integer not null default 0 check (bullets_hit >= 0),
  total_conversations integer not null default 0 check (total_conversations >= 0),
  deaths integer not null default 0 check (deaths >= 0),
  created_at timestamptz not null default now()
);

create index if not exists idx_run_summaries_device_mode
  on public.run_summaries(device_id, mode);

create index if not exists idx_run_summaries_mode_rank
  on public.run_summaries(mode, survival_time desc, bullets_dodged desc, highest_level desc, created_at asc);

alter table public.devices enable row level security;
alter table public.run_summaries enable row level security;

create or replace view public.mode_leaderboards
with (security_invoker = true)
as
with ranked as (
  select
    r.mode,
    r.device_id,
    coalesce(nullif(d.device_name, ''), nullif(r.device_name, '')) as device_name,
    r.run_id,
    r.survival_time,
    r.highest_level,
    r.bullets_dodged,
    r.outcome,
    count(*) over (partition by r.mode, r.device_id) as total_runs,
    coalesce(sum(r.bullets_dodged) over (partition by r.mode, r.device_id), 0) as total_bullets_dodged,
    max(r.created_at) over (partition by r.mode, r.device_id) as updated_at,
    row_number() over (
      partition by r.mode, r.device_id
      order by r.survival_time desc, r.bullets_dodged desc, r.highest_level desc, r.created_at asc
    ) as rank_no
  from public.run_summaries r
  left join public.devices d on d.id = r.device_id
)
select
  mode,
  device_id,
  device_name,
  run_id as best_run_id,
  survival_time as best_survival_time,
  highest_level as best_highest_level,
  bullets_dodged as best_bullets_dodged,
  outcome as best_outcome,
  total_runs,
  total_bullets_dodged,
  updated_at
from ranked
where rank_no = 1;

create or replace function public.record_run_summary(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_id uuid;
  v_device_id uuid;
  v_device_name text;
  v_mode text;
  v_outcome text;
  v_player_count integer;
  v_survival_time integer;
  v_highest_level integer;
  v_xp integer;
  v_bullets_dodged integer;
  v_bullets_spawned integer;
  v_bullets_hit integer;
  v_total_conversations integer;
  v_deaths integer;
  v_total_runs integer;
  v_total_bullets_dodged integer;
  v_saved_device_name text;
begin
  v_run_id := (payload->>'runId')::uuid;
  v_device_id := (payload->>'deviceId')::uuid;
  v_device_name := left(trim(regexp_replace(coalesce(payload->>'deviceName', ''), '[<>]', '', 'g')), 18);
  v_mode := payload->>'mode';
  v_outcome := payload->>'outcome';

  if v_mode not in ('normal', 'hard', 'infinite') then
    raise exception 'invalid mode';
  end if;

  if v_outcome not in ('victory', 'death') then
    raise exception 'invalid outcome';
  end if;

  v_player_count := greatest(1, least(2, coalesce((payload->>'playerCount')::integer, 1)));
  v_survival_time := greatest(0, coalesce((payload->>'survivalTime')::integer, 0));
  v_highest_level := greatest(1, coalesce((payload->>'highestLevel')::integer, 1));
  v_xp := greatest(0, coalesce((payload->>'xp')::integer, 0));
  v_bullets_dodged := greatest(0, coalesce((payload->>'bulletsDodged')::integer, 0));
  v_bullets_spawned := greatest(0, coalesce((payload->>'bulletsSpawned')::integer, 0));
  v_bullets_hit := greatest(0, coalesce((payload->>'bulletsHit')::integer, 0));
  v_total_conversations := greatest(0, coalesce((payload->>'totalConversations')::integer, 0));
  v_deaths := greatest(0, coalesce((payload->>'deaths')::integer, 0));

  if v_device_name = '' then
    v_device_name := '星旅者 ' || right(replace(v_device_id::text, '-', ''), 6);
  end if;

  insert into public.devices (id, device_name, last_seen_at)
  values (v_device_id, v_device_name, now())
  on conflict (id) do update
    set device_name = case
          when excluded.device_name <> '' then excluded.device_name
          else public.devices.device_name
        end,
        last_seen_at = now();

  insert into public.run_summaries (
    run_id,
    device_id,
    device_name,
    mode,
    outcome,
    player_count,
    survival_time,
    highest_level,
    xp,
    bullets_dodged,
    bullets_spawned,
    bullets_hit,
    total_conversations,
    deaths
  ) values (
    v_run_id,
    v_device_id,
    v_device_name,
    v_mode,
    v_outcome,
    v_player_count,
    v_survival_time,
    v_highest_level,
    v_xp,
    v_bullets_dodged,
    v_bullets_spawned,
    v_bullets_hit,
    v_total_conversations,
    v_deaths
  )
  on conflict (run_id) do update
    set device_id = excluded.device_id,
        device_name = excluded.device_name,
        mode = excluded.mode,
        outcome = excluded.outcome,
        player_count = excluded.player_count,
        survival_time = excluded.survival_time,
        highest_level = excluded.highest_level,
        xp = excluded.xp,
        bullets_dodged = excluded.bullets_dodged,
        bullets_spawned = excluded.bullets_spawned,
        bullets_hit = excluded.bullets_hit,
        total_conversations = excluded.total_conversations,
        deaths = excluded.deaths;

  select
    count(*)::integer,
    coalesce(sum(bullets_dodged), 0)::integer
  into v_total_runs, v_total_bullets_dodged
  from public.run_summaries
  where device_id = v_device_id;

  select device_name
  into v_saved_device_name
  from public.devices
  where id = v_device_id;

  return jsonb_build_object(
    'ok', true,
    'run', jsonb_build_object(
      'runId', v_run_id,
      'mode', v_mode,
      'outcome', v_outcome,
      'survivalTime', v_survival_time,
      'bulletsDodged', v_bullets_dodged
    ),
    'device', jsonb_build_object(
      'deviceId', v_device_id,
      'deviceName', v_saved_device_name,
      'totalRuns', v_total_runs,
      'totalBulletsDodged', v_total_bullets_dodged
    )
  );
end;
$$;

grant usage on schema public to service_role;
grant select, insert, update on public.devices to service_role;
grant select, insert, update on public.run_summaries to service_role;
grant select on public.mode_leaderboards to service_role;
grant execute on function public.record_run_summary(jsonb) to service_role;

commit;
```

### 验证 Supabase 结构

运行 SQL 后，你可以在 SQL Editor 中执行：

```sql
select * from public.mode_leaderboards limit 5;
```

初始没有数据是正常的。

部署完成并上传过成绩后，再执行：

```sql
select * from public.run_summaries order by created_at desc limit 5;
select * from public.mode_leaderboards order by best_survival_time desc limit 20;
```

## Cloudflare Pages 部署教程

推荐使用 Cloudflare Pages，因为项目已经使用 `functions/api/*.js`，会自动映射为 Pages Functions。

### 方式一：Cloudflare Dashboard 连接 Git 仓库

1. 将本项目推送到 GitHub / GitLab。
2. 打开 Cloudflare Dashboard。
3. 进入：

```text
Workers & Pages -> Pages -> Create a project -> Connect to Git
```

4. 选择仓库。
5. 构建设置建议：

```text
Framework preset: None
Build command: 留空
Build output directory: /
Root directory: / 或留空（取决于仓库是否就是项目根目录）
```

如果 Cloudflare UI 不接受 `/`，可改为 `.`。

6. 展开环境变量配置，添加本文 “AI 环境变量” 和 “Supabase 排行榜环境变量” 中需要的变量。
7. 点击部署。
8. 部署完成后访问 Cloudflare Pages 分配的域名。
9. 进入游戏设置，点击“测试默认 API”，确认 `/api/dialogue?test=1` 可用。
10. 完成一局并上传昵称，确认排行榜可写入 Supabase。

### 方式二：Wrangler 直接部署

安装或直接使用 Wrangler：

```bash
npx wrangler --version
```

登录 Cloudflare：

```bash
npx wrangler login
```

首次部署：

```bash
npx wrangler pages deploy . --project-name=starfall
```

如果你想使用自己的项目名，将 `starfall` 改为你的 Pages 项目名。

部署后，到 Cloudflare Dashboard 中为这个 Pages 项目配置环境变量。

也可以使用 Wrangler 设置 Pages secrets（如果你的 Wrangler 版本支持）：

```bash
npx wrangler pages secret put AI_API_KEY --project-name=starfall
npx wrangler pages secret put SUPABASE_URL --project-name=starfall
npx wrangler pages secret put SUPABASE_SERVICE_ROLE_KEY --project-name=starfall
```

设置完环境变量后重新部署或触发一次新部署。

## Cloudflare 环境变量清单

最小在线 AI 配置：

```text
AI_API_KEY
```

推荐 AI 配置：

```text
AI_API_KEY
AI_BASE_URL
AI_MODEL
AI_TIMEOUT_MS
```

备用 AI 配置示例：

```text
AI_API_KEY_2
AI_BASE_URL_2
AI_MODEL_2
```

Supabase 排行榜配置：

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

完整可选变量：

```text
AI_API_KEY
AI_BASE_URL
AI_MODEL
AI_TIMEOUT_MS

AI_API_KEY_2
AI_BASE_URL_2
AI_MODEL_2
...
AI_API_KEY_10
AI_BASE_URL_10
AI_MODEL_10

SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

## 部署后检查清单

1. 打开首页，确认游戏正常加载。
2. 打开“AI 与声音设置”。
3. 点击“测试默认 API”。
4. 如果提示默认 API 可用，说明 Cloudflare AI 环境变量配置正确。
5. 开始普通模式，等待触发对话。
6. 发送一句话，确认 Luna 能根据上下文回复。
7. 完成或失败一局。
8. 输入昵称并上传成绩。
9. 打开排行榜，确认成绩出现。
10. 在 Supabase 中检查 `run_summaries` 和 `mode_leaderboards` 是否有数据。

## 常见问题

### 直接打开 `index.html`，AI 和排行榜不可用？

正常。直接打开文件时没有 Cloudflare Pages Functions，`/api/dialogue`、`/api/runs` 等接口不存在。

需要通过 Cloudflare Pages 部署，或用 Wrangler 本地模拟 Pages Functions。

### AI 调用失败但游戏还能继续？

正常。项目有本地规则兜底。

- 玩家回复失败：使用本地规则生成 Luna 回复和行为。
- Boss 主动开场失败：使用内置预设开场白。

### 为什么自定义 API 不走备用 API？

自定义 API 是玩家在浏览器里临时配置的 provider。为避免混淆和泄露，后端收到 custom 配置时只使用这个 custom provider，不再尝试 Cloudflare 环境变量里的默认/备用 provider。

### Supabase Service Role Key 可以放前端吗？

不可以。

`SUPABASE_SERVICE_ROLE_KEY` 权限很高，只能放在 Cloudflare Pages 的环境变量中，由 `functions/api/*.js` 在后端读取。

### 排行榜排序规则是什么？

每个模式下，每台设备取最好的一局。排序优先级：

1. 存活时间更长；
2. 闪避弹幕更多；
3. 最高等级更高；
4. 更早达成的记录优先。

## 开发说明

当前前端主要集中在 `index.html`，包括：

- 游戏循环和 Canvas 绘制；
- 玩家、Boss、弹幕、道具系统；
- 移动端适配；
- 对话框与 AI 调用；
- 本地成绩、设备名和聊天记忆。

后端接口位于 `functions/api/`，无额外构建步骤。

## 安全注意事项

- 不要把任何 API Key 写入 `index.html`。
- 不要把 `SUPABASE_SERVICE_ROLE_KEY` 提交到 Git 仓库。
- 玩家自定义 API Key 保存在玩家本机浏览器 `localStorage` 中。
- 跨局聊天记忆也只保存在玩家本机浏览器。
- Cloudflare 环境变量区分 Production / Preview，部署前确认变量添加到了正确环境。
