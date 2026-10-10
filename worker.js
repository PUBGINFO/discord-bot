const DISCORD_API = "https://discord.com/api/v10";
const DEFAULT_TZ = "Asia/Seoul";
const FRONTEND_CALLBACK = "https://pubginfo.site/SCRIM/DISCORD/";

/* 로그인 후 돌아갈 사이트 (login?return=키) */
const FRONTEND_TARGETS = {
  discord: "https://pubginfo.site/SCRIM/DISCORD/",
  role: "https://pubginfo.site/SCRIM/ROLE/"
};

const OAUTH_CALLBACK_URL =
  "https://discord-bot.pubgmk14-kr.workers.dev/api/auth/callback";

/* =========================================================
   고정 ROLE MANAGER 설정
========================================================= */

const FIXED_GUILD_ID = "1413099667667026063";
const BAIYA_ROLE_ID = "1541955349735538698";
const BAIYA_ROLE_NAME = "白夜";

/* =========================================================
   JSON / 유틸
========================================================= */

function json(data, status = 200, origin = "*") {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": origin,
      "access-control-allow-headers": "Content-Type, Authorization",
      "access-control-allow-methods": "GET,POST,DELETE,OPTIONS"
    }
  });
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function randomId(bytes = 24) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a]
    .map(x => x.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);

  return [...new Uint8Array(digest)]
    .map(x => x.toString(16).padStart(2, "0"))
    .join("");
}

/* =========================================================
   Discord API
========================================================= */

function discordHeaders(env) {
  return {
    "Authorization": `Bot ${env.DISCORD_BOT_TOKEN}`,
    "Content-Type": "application/json"
  };
}

async function discord(path, env, options = {}) {
  const res = await fetch(`${DISCORD_API}${path}`, {
    ...options,
    headers: {
      ...discordHeaders(env),
      ...(options.headers || {})
    }
  });

  if (res.status === 429) {
    let data = {};

    try {
      data = await res.json();
    } catch {}

    return new Response(
      JSON.stringify({
        error: "Discord API Rate Limited",
        retry_after: data.retry_after || 5,
        global: data.global || false
      }),
      {
        status: 429,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "retry-after": String(data.retry_after || 5)
        }
      }
    );
  }

  return res;
}

/* =========================================================
   Discord Slash Commands 등록
========================================================= */

async function registerCommands(env) {
  const appId =
    env.DISCORD_APPLICATION_ID ||
    env.DISCORD_CLIENT_ID;

  const botToken = env.DISCORD_BOT_TOKEN;

  if (!appId || !botToken) {
    return {
      ok: false,
      error: "Missing environment variables"
    };
  }

  const commands = [
    {
      name: "채팅삭제",
      description:
        "채널의 최근 메시지를 삭제합니다. 14일이 지난 메시지는 제외됩니다.",
      options: [
        {
          name: "개수",
          description: "삭제할 메시지 개수 (1 ~ 100)",
          type: 4,
          required: true,
          min_value: 1,
          max_value: 100
        },
        {
          name: "유저",
          description: "특정 유저의 메시지만 삭제합니다.",
          type: 6,
          required: false
        }
      ]
    },
    {
      name: "채팅삭제플러스",
      description: "14일이 지난 메시지도 개별적으로 삭제합니다.",
      options: [
        {
          name: "개수",
          description: "삭제할 메시지 개수 (1 ~ 100)",
          type: 4,
          required: true,
          min_value: 1,
          max_value: 100
        }
      ]
    }
  ];

  try {
    const res = await fetch(
      `${DISCORD_API}/applications/${appId}/commands`,
      {
        method: "PUT",
        headers: {
          "Authorization": `Bot ${botToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(commands)
      }
    );

    const text = await res.text();

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: text
      };
    }

    return {
      ok: true
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message
    };
  }
}

/* =========================================================
   Session
========================================================= */

async function requireSession(request, env) {
  const auth =
    request.headers.get("Authorization") || "";

  if (!auth.startsWith("Bearer ")) {
    console.log(
      "SESSION DEBUG: Authorization header 없음"
    );
    return null;
  }

  const token = auth.slice(7).trim();

  if (!token) {
    console.log(
      "SESSION DEBUG: Bearer token 없음"
    );
    return null;
  }

  const hash = await sha256(token);

  const row = await env.DB.prepare(`
    SELECT
      user_id,
      username,
      discord_access_token,
      expires_at
    FROM sessions
    WHERE token_hash = ?
  `)
    .bind(hash)
    .first();

  if (!row) {
    console.log(
      "SESSION DEBUG: DB에서 세션을 찾지 못함"
    );
    return null;
  }

  const expiresAt = Number(row.expires_at);
  const currentTime = nowSec();

  if (!Number.isFinite(expiresAt)) {
    console.log(
      "SESSION DEBUG: expires_at이 숫자가 아님"
    );
    return null;
  }

  if (expiresAt <= currentTime) {
    console.log(
      "SESSION DEBUG: 세션 만료",
      {
        expiresAt,
        currentTime
      }
    );
    return null;
  }

  return {
    userId: row.user_id,
    username: row.username,
    token,
    discordAccessToken: row.discord_access_token
  };
}

/* =========================================================
   권한 확인
========================================================= */

function hasManageGuildPermission(permissions) {
  try {
    const n = BigInt(permissions || "0");

    return (
      (n & 0x8n) !== 0n ||
      (n & 0x20n) !== 0n
    );
  } catch {
    return false;
  }
}

function hasManageMessagesPermission(interaction) {
  try {
    const permissions =
      interaction.member?.permissions || "0";

    const n = BigInt(permissions);

    return (n & 0x2000n) !== 0n;
  } catch {
    return false;
  }
}

/* =========================================================
   OAuth
========================================================= */

async function cleanupExpiredStates(env) {
  try {
    await env.DB.prepare(`
      DELETE FROM oauth_states
      WHERE expires_at <= ?
    `)
      .bind(nowSec())
      .run();
  } catch {}
}

async function login(request, env) {
  await cleanupExpiredStates(env);

  const reqUrl = new URL(request.url);

  const returnKey =
    reqUrl.searchParams.get("return");

  const target =
    FRONTEND_TARGETS[returnKey]
      ? returnKey
      : "discord";

  const state =
    `${randomId(24)}.${target}`;

  await env.DB.prepare(`
    INSERT INTO oauth_states
    (state, expires_at)
    VALUES (?, ?)
  `)
    .bind(
      state,
      nowSec() + 600
    )
    .run();

  const params = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    response_type: "code",
    redirect_uri: OAUTH_CALLBACK_URL,
    scope: "identify guilds",
    state
  });

  return Response.redirect(
    `https://discord.com/oauth2/authorize?${params.toString()}`,
    302
  );
}

async function oauthCallback(request, env) {
  const url = new URL(request.url);

  const code =
    url.searchParams.get("code");

  const state =
    url.searchParams.get("state");

  if (!code || !state) {
    return new Response(
      "Missing OAuth parameters",
      { status: 400 }
    );
  }

  const stateRow = await env.DB.prepare(`
    SELECT state
    FROM oauth_states
    WHERE state = ?
    AND expires_at > ?
  `)
    .bind(
      state,
      nowSec()
    )
    .first();

  if (!stateRow) {
    return new Response(
      "Invalid or expired OAuth state",
      { status: 400 }
    );
  }

  await env.DB.prepare(`
    DELETE FROM oauth_states
    WHERE state = ?
  `)
    .bind(state)
    .run();

  const tokenRes = await fetch(
    `${DISCORD_API}/oauth2/token`,
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID,
        client_secret:
          env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri:
          OAUTH_CALLBACK_URL
      })
    }
  );

  if (!tokenRes.ok) {
    const text =
      await tokenRes.text();

    return new Response(
      `OAuth token exchange failed: ${text}`,
      { status: 502 }
    );
  }

  const oauth =
    await tokenRes.json();

  const userRes = await fetch(
    `${DISCORD_API}/users/@me`,
    {
      headers: {
        Authorization:
          `Bearer ${oauth.access_token}`
      }
    }
  );

  if (!userRes.ok) {
    return new Response(
      "Could not read Discord user",
      { status: 502 }
    );
  }

  const user =
    await userRes.json();

  const session =
    randomId(32);

  const hash =
    await sha256(session);

  await env.DB.prepare(`
    INSERT INTO sessions
    (
      token_hash,
      user_id,
      username,
      discord_access_token,
      expires_at
    )
    VALUES (?, ?, ?, ?, ?)
  `)
    .bind(
      hash,
      user.id,
      user.username,
      oauth.access_token,
      nowSec() + 86400 * 7
    )
    .run();

  const targetKey =
    state.split(".")[1];

  const redirect =
    new URL(
      FRONTEND_TARGETS[targetKey]
        || FRONTEND_CALLBACK
    );

  redirect.searchParams.set(
    "session",
    session
  );

  return Response.redirect(
    redirect.toString(),
    302
  );
}

/* =========================================================
   Guild / Channels / Roles
========================================================= */

async function listGuilds(session, env) {
  if (!session.discordAccessToken) {
    return json(
      {
        error:
          "Discord access token missing, please log in again"
      },
      401
    );
  }

  const res = await fetch(
    `${DISCORD_API}/users/@me/guilds`,
    {
      headers: {
        Authorization:
          `Bearer ${session.discordAccessToken}`
      }
    }
  );

  if (res.status === 429) {
    const rl =
      await res.json()
        .catch(() => ({}));

    return json(
      {
        error: "Rate limited",
        retry_after:
          rl.retry_after
      },
      429
    );
  }

  if (!res.ok) {
    return json(
      {
        error:
          "Could not read guilds"
      },
      502
    );
  }

  const guilds =
    await res.json();

  const manageable =
    guilds
      .filter(
        g =>
          g.owner ||
          hasManageGuildPermission(
            g.permissions
          )
      )
      .map(g => ({
        id: g.id,
        name: g.name,
        icon: g.icon,
        owner: !!g.owner
      }));

  return json(manageable);
}

async function listChannels(guildId, env) {
  const res =
    await discord(
      `/guilds/${guildId}/channels`,
      env
    );

  if (res.status === 429) {
    return res;
  }

  if (!res.ok) {
    return json(
      {
        error:
          "Bot is not in this server or cannot read channels"
      },
      403
    );
  }

  const channels =
    await res.json();

  return json(
    channels
      .filter(c => c.type === 0)
      .map(c => ({
        id: c.id,
        name: c.name
      }))
      .sort(
        (a, b) =>
          a.name.localeCompare(
            b.name
          )
      )
  );
}

async function listRoles(guildId, env) {
  const res =
    await discord(
      `/guilds/${guildId}/roles`,
      env
    );

  if (res.status === 429) {
    return res;
  }

  if (!res.ok) {
    return json(
      {
        error:
          "Bot is not in this server or cannot read roles"
      },
      403
    );
  }

  const roles =
    await res.json();

  return json(
    roles
      .filter(
        r =>
          r.name !== "@everyone" &&
          !r.managed
      )
      .map(r => ({
        id: r.id,
        name: r.name,
        color:
          r.color
            ? `#${r.color
                .toString(16)
                .padStart(6, "0")}`
            : null
      }))
      .sort(
        (a, b) =>
          a.name.localeCompare(
            b.name
          )
      )
  );
}

/* =========================================================
   Google CSV
========================================================= */

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (
    let i = 0;
    i < text.length;
    i++
  ) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"') {
      if (
        quoted &&
        next === '"'
      ) {
        cell += '"';
        i++;
      } else {
        quoted = !quoted;
      }

      continue;
    }

    if (
      char === "," &&
      !quoted
    ) {
      row.push(cell);
      cell = "";
      continue;
    }

    if (
      (char === "\n" ||
        char === "\r") &&
      !quoted
    ) {
      if (
        char === "\r" &&
        next === "\n"
      ) {
        i++;
      }

      row.push(cell);
      cell = "";

      rows.push(row);
      row = [];

      continue;
    }

    cell += char;
  }

  if (
    cell.length ||
    row.length
  ) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

/* =========================================================
   Google Sheets B4:C21
========================================================= */

async function getRoleSheet(request, env) {
  const url =
    new URL(request.url);

  const sourceUrl =
    url.searchParams.get("url");

  if (!sourceUrl) {
    return json(
      {
        error:
          "Google Sheets URL이 없습니다."
      },
      400
    );
  }

  let source;

  try {
    source =
      new URL(sourceUrl);
  } catch {
    return json(
      {
        error:
          "잘못된 Google Sheets URL입니다."
      },
      400
    );
  }

  if (
    source.hostname !==
    "docs.google.com"
  ) {
    return json(
      {
        error:
          "Google Sheets 주소만 사용할 수 있습니다."
      },
      400
    );
  }

  const match =
    source.pathname.match(
      /^\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/
    );

  if (!match) {
    return json(
      {
        error:
          "Google Spreadsheet ID를 찾을 수 없습니다."
      },
      400
    );
  }

  const csvUrl =
    `https://docs.google.com/spreadsheets/d/${match[1]}/export?format=csv`;

  const response =
    await fetch(csvUrl);

  if (!response.ok) {
    return json(
      {
        error:
          `Google Sheets 요청 실패 (${response.status})`
      },
      502
    );
  }

  const rows =
    parseCsv(
      await response.text()
    );

  const result = [];

  for (
    let i = 3;
    i <= 20;
    i++
  ) {
    const row =
      rows[i] || [];

    const seed =
      String(
        row[1] ?? ""
      ).trim();

    const nickname =
      String(
        row[2] ?? ""
      ).trim();

    if (!nickname) {
      continue;
    }

    result.push({
      seed,
      nickname
    });
  }

  return json({
    rows: result
  });
}

/* =========================================================
   고정 서버 권한 확인
========================================================= */

async function checkFixedGuildPermission(
  session,
  env
) {
  if (
    !session?.discordAccessToken
  ) {
    return {
      ok: false,
      error:
        "Discord 로그인 정보가 없습니다. 다시 로그인해주세요."
    };
  }

  const response =
    await fetch(
      `${DISCORD_API}/users/@me/guilds`,
      {
        headers: {
          Authorization:
            `Bearer ${session.discordAccessToken}`
        }
      }
    );

  if (!response.ok) {
    return {
      ok: false,
      error:
        "Discord 서버 권한을 확인할 수 없습니다."
    };
  }

  const guilds =
    await response.json();

  const guild =
    guilds.find(
      g =>
        g.id ===
        FIXED_GUILD_ID
    );

  if (!guild) {
    return {
      ok: false,
      error:
        "고정된 Discord 서버에 접근할 수 없습니다."
    };
  }

  let permissions = 0n;

  try {
    permissions =
      BigInt(
        guild.permissions ||
        "0"
      );
  } catch {
    permissions = 0n;
  }

  const canManage =
    guild.owner === true ||
    (permissions & 0x8n) !== 0n ||
    (permissions & 0x20n) !== 0n ||
    (permissions & 0x10000000n) !== 0n;

  if (!canManage) {
    return {
      ok: false,
      error:
        "이 Discord 서버의 역할을 관리할 권한이 없습니다."
    };
  }

  return {
    ok: true,
    guild
  };
}

/* =========================================================
   고정 白夜 역할 확인
========================================================= */

async function getBaiyaRole(env) {
  const response =
    await discord(
      `/guilds/${FIXED_GUILD_ID}/roles`,
      env
    );

  if (response.status === 429) {
    return {
      ok: false,
      rateLimited: true
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      error:
        "Discord 역할 목록을 가져오지 못했습니다."
    };
  }

  const roles =
    await response.json();

  const role =
    roles.find(
      r =>
        r.id ===
        BAIYA_ROLE_ID
    );

  if (!role) {
    return {
      ok: false,
      error:
        `白夜 역할(${BAIYA_ROLE_ID})을 찾을 수 없습니다.`
    };
  }

  if (
    role.managed ||
    role.name === "@everyone"
  ) {
    return {
      ok: false,
      error:
        "白夜 역할을 관리할 수 없는 상태입니다."
    };
  }

  return {
    ok: true,
    role,
    roles
  };
}

/* =========================================================
   Bot 역할 계층 확인
========================================================= */

async function checkBotRoleHierarchy(
  env,
  roles
) {
  const botUserResponse =
    await discord(
      "/users/@me",
      env
    );

  if (!botUserResponse.ok) {
    return {
      ok: false,
      error:
        "Discord Bot 정보를 가져오지 못했습니다."
    };
  }

  const botUser =
    await botUserResponse.json();

  const botMemberResponse =
    await discord(
      `/guilds/${FIXED_GUILD_ID}/members/${botUser.id}`,
      env
    );

  if (!botMemberResponse.ok) {
    return {
      ok: false,
      error:
        "Discord Bot이 해당 서버에 없습니다."
    };
  }

  const botMember =
    await botMemberResponse.json();

  let highest = 0;

  for (const role of roles) {
    if (
      Array.isArray(
        botMember.roles
      ) &&
      botMember.roles.includes(
        role.id
      )
    ) {
      highest =
        Math.max(
          highest,
          Number(role.position)
        );
    }
  }

  return {
    ok: true,
    highest
  };
}

/* =========================================================
   Discord 멤버 검색
========================================================= */

async function findRoleMembers(
  request,
  env,
  session
) {
  const permission =
    await checkFixedGuildPermission(
      session,
      env
    );

  if (!permission.ok) {
    return json(
      {
        error:
          permission.error
      },
      403
    );
  }

  const url =
    new URL(request.url);

  const nickname =
    (
      url.searchParams.get(
        "nickname"
      ) || ""
    ).trim();

  if (!nickname) {
    return json(
      {
        error:
          "nickname이 없습니다."
      },
      400
    );
  }

  const matches = [];
  let after = null;

  while (true) {
    const params =
      new URLSearchParams();

    params.set(
      "limit",
      "1000"
    );

    if (after) {
      params.set(
        "after",
        after
      );
    }

    const response =
      await discord(
        `/guilds/${FIXED_GUILD_ID}/members?${params.toString()}`,
        env
      );

    if (
      response.status === 429
    ) {
      const data =
        await response.json()
          .catch(
            () => ({})
          );

      const retry =
        Math.ceil(
          Number(
            data.retry_after ||
            1
          )
        );

      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            retry * 1000
          )
      );

      continue;
    }

    if (!response.ok) {
      const text =
        await response.text();

      return json(
        {
          error:
            `Discord 멤버 목록 조회 실패: ${text}`
        },
        response.status
      );
    }

    const page =
      await response.json();

    for (
      const member of page
    ) {
      if (
        typeof member.nick ===
          "string" &&
        member.nick ===
          nickname
      ) {
        matches.push({
          id:
            member.user.id,
          username:
            member.user.username,
          globalName:
            member.user.global_name ||
            null,
          nick:
            member.nick,
          roles:
            member.roles ||
            []
        });
      }
    }

    if (
      page.length < 1000
    ) {
      break;
    }

    after =
      page[
        page.length - 1
      ]?.user?.id;

    if (!after) {
      break;
    }
  }

  return json({
    members: matches
  });
}

/* =========================================================
   선택된 멤버 역할 처리 (20명 이하 극속도 + 429 Auto-Retry + 구분 유지)
========================================================= */

async function processSelectedBaiyaRoles(
  request,
  env,
  session,
  action
) {
  const permission = await checkFixedGuildPermission(session, env);
  if (!permission.ok) {
    return json({ error: permission.error }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "잘못된 JSON입니다." }, 400);
  }

  const userIds = Array.isArray(body?.userIds)
    ? [...new Set(body.userIds.map(id => String(id).trim()).filter(Boolean))]
    : [];

  if (userIds.length === 0) {
    return json({ error: "선택된 멤버가 없습니다." }, 400);
  }

  if (userIds.length > 100) {
    return json({ error: "한 번에 최대 100명까지 처리할 수 있습니다." }, 400);
  }

  const roleInfo = await getBaiyaRole(env);
  if (!roleInfo.ok) {
    if (roleInfo.rateLimited) {
      return json({ error: "Discord API 요청 제한에 걸렸습니다. 잠시 후 다시 시도해주세요." }, 429);
    }
    return json({ error: roleInfo.error }, 500);
  }

  const hierarchy = await checkBotRoleHierarchy(env, roleInfo.roles);
  if (!hierarchy.ok) {
    return json({ error: hierarchy.error }, 403);
  }

  const role = roleInfo.role;
  if (Number(role.position) >= hierarchy.highest) {
    return json({ error: "白夜 역할이 Bot의 최고 역할보다 높거나 같아서 관리할 수 없습니다." }, 403);
  }

  // ---------------------------------------------------------
  // 429 Rate Limit 자동 재시도가 포함된 Discord API 호출 함수
  // ---------------------------------------------------------
  async function fetchDiscordWithRetry(path, options = {}, maxRetries = 3) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const res = await discord(path, env, options);

      if (res.status === 429) {
        let retryAfter = 1;
        try {
          const data = await res.json();
          retryAfter = Number(data.retry_after || 1);
        } catch {}

        // 지연 시간이 너무 길면(5초 이상) 대기 없이 바로 에러 반환
        if (retryAfter > 5) return res;

        // Discord가 지정한 시간 만큼 대기 후 재시도
        await new Promise(resolve => setTimeout(resolve, Math.ceil(retryAfter * 1000) + 100));
        continue;
      }

      return res;
    }
    return new Response(JSON.stringify({ error: "Max retries exceeded" }), { status: 429 });
  }

  // ---------------------------------------------------------
  // 단일 유저 처리 로직 (GET 확인 -> PUT/DELETE 처리)
  // ---------------------------------------------------------
  async function processSingleUser(userId) {
    // 1. 해당 멤버 단건 정보 조회
    const memberRes = await fetchDiscordWithRetry(`/guilds/${FIXED_GUILD_ID}/members/${userId}`);

    if (!memberRes.ok) {
      return { status: "failed", userId, error: `멤버 조회 실패 (HTTP ${memberRes.status})` };
    }

    const member = await memberRes.json();
    const hasRole = Array.isArray(member.roles) && member.roles.includes(BAIYA_ROLE_ID);

    // 2. 역할 추가 / 제거 조건부 실행
    if (action === "assign") {
      if (hasRole) {
        return { status: "already" }; // 이미 보유 중
      }

      const res = await fetchDiscordWithRetry(
        `/guilds/${FIXED_GUILD_ID}/members/${userId}/roles/${BAIYA_ROLE_ID}`,
        { method: "PUT" }
      );

      if (res.ok) {
        return { status: "success" }; // 새로 지급 성공
      } else {
        return { status: "failed", userId, error: `HTTP ${res.status}` };
      }
    } else {
      if (!hasRole) {
        return { status: "already" }; // 이미 미보유 중
      }

      const res = await fetchDiscordWithRetry(
        `/guilds/${FIXED_GUILD_ID}/members/${userId}/roles/${BAIYA_ROLE_ID}`,
        { method: "DELETE" }
      );

      if (res.ok) {
        return { status: "success" }; // 제거 성공
      } else {
        return { status: "failed", userId, error: `HTTP ${res.status}` };
      }
    }
  }

  // ---------------------------------------------------------
  // Promise.all 기반 비동기 병렬 실행
  // ---------------------------------------------------------
  let success = 0;
  let already = 0;
  let failed = 0;
  const failedMembers = [];

  const results = await Promise.all(userIds.map(id => processSingleUser(id)));

  for (const res of results) {
    if (res.status === "success") {
      success++;
    } else if (res.status === "already") {
      already++;
    } else {
      failed++;
      failedMembers.push({ userId: res.userId, error: res.error });
    }
  }

  // 기존 프론트엔드 결과 포맷 100% 동일 응답
  return json({
    ok: true,
    action,
    role: {
      id: role.id,
      name: role.name
    },
    total: userIds.length,
    success,
    already,
    failed,
    failedMembers
  });
}

/* =========================================================
   서버 전체 白夜 제거
========================================================= */

async function removeAllBaiyaRoles(
  request,
  env,
  session
) {
  const permission =
    await checkFixedGuildPermission(
      session,
      env
    );

  if (!permission.ok) {
    return json(
      {
        error:
          permission.error
      },
      403
    );
  }

  const roleInfo =
    await getBaiyaRole(env);

  if (!roleInfo.ok) {
    return json(
      {
        error:
          roleInfo.error ||
          "白夜 역할을 확인할 수 없습니다."
      },
      500
    );
  }

  const members = [];
  let after = null;

  while (true) {
    const params =
      new URLSearchParams();

    params.set(
      "limit",
      "1000"
    );

    if (after) {
      params.set(
        "after",
        after
      );
    }

    const response =
      await discord(
        `/guilds/${FIXED_GUILD_ID}/members?${params.toString()}`,
        env
      );

    if (
      response.status ===
      429
    ) {
      const data =
        await response.json()
          .catch(
            () => ({})
          );

      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            Math.ceil(
              Number(
                data.retry_after ||
                1
              ) * 1000
            )
          )
      );

      continue;
    }

    if (!response.ok) {
      return json(
        {
          error:
            "Discord 서버 멤버 목록을 가져오지 못했습니다."
        },
        response.status
      );
    }

    const page =
      await response.json();

    for (
      const member of page
    ) {
      if (
        Array.isArray(
          member.roles
        ) &&
        member.roles.includes(
          BAIYA_ROLE_ID
        )
      ) {
        members.push(member);
      }
    }

    if (
      page.length < 1000
    ) {
      break;
    }

    after =
      page[
        page.length - 1
      ]?.user?.id;

    if (!after) {
      break;
    }
  }

  let success = 0;
  let failed = 0;

  const failedMembers = [];

  for (
    const member of members
  ) {
    const response =
      await discord(
        `/guilds/${FIXED_GUILD_ID}/members/${member.user.id}/roles/${BAIYA_ROLE_ID}`,
        env,
        {
          method: "DELETE"
        }
      );

    if (response.ok) {
      success++;
    } else {
      failed++;

      failedMembers.push({
        userId:
          member.user.id,
        nick:
          member.nick,
        error:
          `HTTP ${response.status}`
      });
    }
  }

  return json({
    ok: true,
    role: {
      id: BAIYA_ROLE_ID,
      name: BAIYA_ROLE_NAME
    },
    totalFound:
      members.length,
    success,
    failed,
    failedMembers
  });
}

/* =========================================================
   Schedule
========================================================= */

function validateSchedule(body) {
  const numbers = [
    "months",
    "days",
    "hours",
    "minutes"
  ];

  for (
    const key of numbers
  ) {
    body[key] =
      Number(
        body[key] || 0
      );

    if (
      !Number.isInteger(
        body[key]
      ) ||
      body[key] < 0
    ) {
      throw new Error(
        `${key} must be a non-negative integer`
      );
    }
  }

  if (
    body.months +
      body.days +
      body.hours +
      body.minutes ===
    0
  ) {
    throw new Error(
      "Repeat interval must be greater than zero"
    );
  }

  if (
    !body.guildId ||
    !body.channelId ||
    !body.message ||
    !body.startAt
  ) {
    throw new Error(
      "guildId, channelId, message and startAt are required"
    );
  }

  body.timezone =
    body.timezone ||
    DEFAULT_TZ;
}

function calculateNext(
  currentUtcIso,
  body
) {
  const date =
    new Date(currentUtcIso);

  date.setUTCMonth(
    date.getUTCMonth() +
      Number(
        body.months || 0
      )
  );

  date.setUTCDate(
    date.getUTCDate() +
      Number(
        body.days || 0
      )
  );

  date.setUTCHours(
    date.getUTCHours() +
      Number(
        body.hours || 0
      )
  );

  date.setUTCMinutes(
    date.getUTCMinutes() +
      Number(
        body.minutes || 0
      )
  );

  return date.toISOString();
}

async function syncDOAlarm(env) {
  if (env.SCHEDULER_DO) {
    try {
      const id = env.SCHEDULER_DO.idFromName("global_precision_scheduler");
      const stub = env.SCHEDULER_DO.get(id);
      await stub.fetch("https://do/sync");
    } catch (e) {
      console.error("DO Alarm Sync Error:", e);
    }
  }
}

async function createSchedule(
  request,
  env,
  session
) {
  const body =
    await request.json();

  validateSchedule(body);

  const start =
    new Date(
      body.startAt
    );

  if (
    isNaN(
      start.getTime()
    )
  ) {
    throw new Error(
      "Invalid startAt"
    );
  }

  const roleIds =
    Array.isArray(
      body.roleIds
    )
      ? body.roleIds
          .filter(Boolean)
          .join(",")
      : body.roleId ||
        null;

  const id =
    randomId(16);

  await env.DB.prepare(`
    INSERT INTO schedules
    (
      id,
      user_id,
      guild_id,
      channel_id,
      message,
      role_id,
      timezone,
      start_at,
      next_run_at,
      months,
      days,
      hours,
      minutes,
      enabled,
      last_run_key,
      created_at
    )
    VALUES
    (
      ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, 1, NULL, ?
    )
  `)
    .bind(
      id,
      session.userId,
      body.guildId,
      body.channelId,
      body.message,
      roleIds || null,
      body.timezone,
      start.toISOString(),
      start.toISOString(),
      body.months,
      body.days,
      body.hours,
      body.minutes,
      new Date().toISOString()
    )
    .run();

  await syncDOAlarm(env);

  return json({
    ok: true,
    id
  });
}

async function listSchedules(
  session,
  env
) {
  const result =
    await env.DB.prepare(`
      SELECT
        id,
        guild_id,
        channel_id,
        message,
        role_id,
        timezone,
        start_at,
        next_run_at,
        months,
        days,
        hours,
        minutes,
        enabled,
        last_run_key
      FROM schedules
      WHERE user_id = ?
      ORDER BY next_run_at ASC
    `)
      .bind(
        session.userId
      )
      .all();

  return json(
    result.results || []
  );
}

async function deleteSchedule(
  id,
  session,
  env
) {
  await env.DB.prepare(`
    DELETE FROM schedules
    WHERE id = ?
    AND user_id = ?
  `)
    .bind(
      id,
      session.userId
    )
    .run();

  await syncDOAlarm(env);

  return json({
    ok: true
  });
}

async function toggleSchedule(
  id,
  session,
  env
) {
  const row =
    await env.DB.prepare(`
      SELECT enabled
      FROM schedules
      WHERE id = ?
      AND user_id = ?
    `)
      .bind(
        id,
        session.userId
      )
      .first();

  if (!row) {
    return json(
      {
        error:
          "Not found"
      },
      404
    );
  }

  const next =
    Number(row.enabled)
      ? 0
      : 1;

  await env.DB.prepare(`
    UPDATE schedules
    SET enabled = ?
    WHERE id = ?
    AND user_id = ?
  `)
    .bind(
      next,
      id,
      session.userId
    )
    .run();

  await syncDOAlarm(env);

  return json({
    ok: true,
    enabled: !!next
  });
}

/* =========================================================
   Scheduler (Cron 및 DO Alarm 기반 실행)
========================================================= */

async function runScheduler(env) {
  const nowIso =
    new Date().toISOString();

  console.log(
    "SCHEDULER RUN",
    {
      nowIso
    }
  );

  const result =
    await env.DB.prepare(`
      SELECT *
      FROM schedules
      WHERE enabled = 1
      AND next_run_at <= ?
      ORDER BY next_run_at ASC
      LIMIT 50
    `)
      .bind(nowIso)
      .all();

  const rows =
    result.results || [];

  console.log(
    "SCHEDULER DUE",
    {
      nowIso,
      count: rows.length
    }
  );

  for (
    const row of rows
  ) {
    const dueKey =
      row.next_run_at;

    if (
      row.last_run_key ===
      dueKey
    ) {
      console.log(
        "SCHEDULER SKIP",
        {
          id: row.id,
          reason:
            "already executed",
          dueKey
        }
      );

      continue;
    }

    const content =
      row.role_id
        ? `${row.role_id
            .split(",")
            .map(
              r => `<@&${r}>`
            )
            .join(" ")} ${row.message}`
        : row.message;

    console.log(
      "SCHEDULER SEND",
      {
        id: row.id,
        channelId:
          row.channel_id,
        dueKey,
        nowIso
      }
    );

    const res =
      await discord(
        `/channels/${row.channel_id}/messages`,
        env,
        {
          method: "POST",
          body: JSON.stringify({
            content
          })
        }
      );

    if (!res.ok) {
      console.log(
        "SCHEDULER SEND FAILED",
        {
          id: row.id,
          status:
            res.status
        }
      );

      continue;
    }

    const next =
      calculateNext(
        row.next_run_at,
        {
          months:
            row.months,
          days:
            row.days,
          hours:
            row.hours,
          minutes:
            row.minutes
        }
      );

    const updateResult =
      await env.DB.prepare(`
        UPDATE schedules
        SET
          last_run_key = ?,
          next_run_at = ?
        WHERE id = ?
        AND last_run_key IS NOT ?
      `)
        .bind(
          dueKey,
          next,
          row.id,
          dueKey
        )
        .run();

    console.log(
      "SCHEDULER SUCCESS",
      {
        id: row.id,
        previousRun:
          dueKey,
        nextRun:
          next,
        updated:
          updateResult.success
      }
    );
  }
}

/* =========================================================
   Message 시간 계산
========================================================= */

function snowflakeToTimestamp(
  id
) {
  return (
    Number(id) / 4194304 +
    1420070400000
  );
}

function isWithin14Days(
  messageId
) {
  const created =
    snowflakeToTimestamp(
      messageId
    );

  const fourteenDays =
    14 *
    24 *
    60 *
    60 *
    1000;

  return (
    Date.now() -
      created <
    fourteenDays
  );
}

function interactionResponse(
  content
) {
  return json({
    type: 4,
    data: {
      content,
      flags: 64
    }
  });
}

/* =========================================================
   /채팅삭제
========================================================= */

async function deleteNormalMessages(
  interaction,
  env,
  channelId,
  count,
  targetUserId
) {
  const res =
    await discord(
      `/channels/${channelId}/messages?limit=${count}`,
      env
    );

  if (
    res.status === 429
  ) {
    return interactionResponse(
      "⚠️ Discord API 요청 제한에 걸렸습니다. 잠시 후 다시 시도해주세요."
    );
  }

  if (!res.ok) {
    return interactionResponse(
      `❌ 메시지를 가져오지 못했습니다.\nHTTP ${res.status}`
    );
  }

  let messages =
    await res.json();

  if (targetUserId) {
    messages =
      messages.filter(
        m =>
          m.author?.id ===
          targetUserId
      );
  }

  const recentMessages =
    messages.filter(
      m =>
        isWithin14Days(
          m.id
        )
    );

  const oldMessages =
    messages.filter(
      m =>
        !isWithin14Days(
          m.id
        )
    );

  if (
    recentMessages.length ===
    0
  ) {
    return interactionResponse(
      oldMessages.length > 0
        ? `⚠️ 삭제할 수 있는 메시지가 없습니다.\n14일이 지난 메시지 ${oldMessages.length}개는 제외되었습니다.`
        : "ℹ️ 조건에 맞는 메시지가 없습니다."
    );
  }

  let deletedCount = 0;
  let failedCount = 0;

  const recentIds =
    recentMessages.map(
      m => m.id
    );

  if (
    recentIds.length >= 2
  ) {
    const bulkRes =
      await discord(
        `/channels/${channelId}/messages/bulk-delete`,
        env,
        {
          method: "POST",
          body: JSON.stringify({
            messages:
              recentIds
          })
        }
      );

    if (bulkRes.ok) {
      deletedCount =
        recentIds.length;
    } else {
      failedCount =
        recentIds.length;
    }
  } else {
    const deleteRes =
      await discord(
        `/channels/${channelId}/messages/${recentIds[0]}`,
        env,
        {
          method: "DELETE"
        }
      );

    if (deleteRes.ok) {
      deletedCount = 1;
    } else {
      failedCount = 1;
    }
  }

  let message =
    `🗑️ 메시지 삭제 완료\n삭제: ${deletedCount}개`;

  if (
    failedCount > 0
  ) {
    message +=
      `\n실패: ${failedCount}개`;
  }

  if (
    oldMessages.length > 0
  ) {
    message +=
      `\n⚠️ 14일 초과 메시지 ${oldMessages.length}개 제외`;
  }

  if (targetUserId) {
    message +=
      `\n👤 대상 유저: <@${targetUserId}>`;
  }

  return interactionResponse(
    message
  );
}

/* =========================================================
   Interaction 원본 수정
========================================================= */

async function editOriginalInteractionResponse(
  interaction,
  env,
  content
) {
  const applicationId =
    interaction.application_id ||
    env.DISCORD_APPLICATION_ID ||
    env.DISCORD_CLIENT_ID;

  const token =
    interaction.token;

  if (
    !applicationId ||
    !token
  ) {
    return false;
  }

  const res =
    await fetch(
      `${DISCORD_API}/webhooks/${applicationId}/${token}/messages/@original`,
      {
        method: "PATCH",
        headers: {
          "Authorization":
            `Bot ${env.DISCORD_BOT_TOKEN}`,
          "Content-Type":
            "application/json"
        },
        body: JSON.stringify({
          content
        })
      }
    );

  return res.ok;
}

/* =========================================================
   Plus DELETE
========================================================= */

async function deleteMessageWithRetry(
  env,
  channelId,
  messageId
) {
  for (
    let attempt = 0;
    attempt <= 5;
    attempt++
  ) {
    const res =
      await fetch(
        `${DISCORD_API}/channels/${channelId}/messages/${messageId}`,
        {
          method: "DELETE",
          headers:
            discordHeaders(env)
        }
      );

    if (res.ok) {
      return {
        ok: true
      };
    }

    if (
      res.status === 429
    ) {
      let data = {};

      try {
        data =
          await res.json();
      } catch {}

      const waitMs =
        Math.min(
          Math.ceil(
            Number(
              data.retry_after ||
              1
            ) * 1000
          ),
          10000
        );

      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            waitMs
          )
      );

      continue;
    }

    return {
      ok: false,
      status: res.status
    };
  }

  return {
    ok: false,
    status: 429
  };
}

/* =========================================================
   /채팅삭제플러스
========================================================= */

async function deletePlusMessagesAndReply(
  interaction,
  env,
  channelId,
  count
) {
  const res =
    await discord(
      `/channels/${channelId}/messages?limit=${count}`,
      env
    );

  if (!res.ok) {
    await editOriginalInteractionResponse(
      interaction,
      env,
      `❌ 메시지를 가져오지 못했습니다.\nHTTP ${res.status}`
    );

    return;
  }

  const messages =
    await res.json();

  if (
    !Array.isArray(
      messages
    ) ||
    messages.length === 0
  ) {
    await editOriginalInteractionResponse(
      interaction,
      env,
      "ℹ️ 삭제할 메시지가 없습니다."
    );

    return;
  }

  const total =
    messages.length;

  let deletedCount = 0;
  let failedCount = 0;
  let recentCount = 0;
  let oldCount = 0;

  await editOriginalInteractionResponse(
    interaction,
    env,
    `🗑️ 채팅 삭제 진행 중...\n0/${total} 삭제 처리 완료`
  );

  for (
    let i = 0;
    i < messages.length;
    i++
  ) {
    const message =
      messages[i];

    if (
      isWithin14Days(
        message.id
      )
    ) {
      recentCount++;
    } else {
      oldCount++;
    }

    const result =
      await deleteMessageWithRetry(
        env,
        channelId,
        message.id
      );

    if (result.ok) {
      deletedCount++;
    } else {
      failedCount++;
    }

    const completed =
      i + 1;

    if (
      completed % 10 === 0 ||
      completed === total
    ) {
      await editOriginalInteractionResponse(
        interaction,
        env,
        `🗑️ 채팅 삭제 진행 중...\n` +
          `${completed}/${total} 삭제 처리 완료\n` +
          `성공: ${deletedCount}개\n` +
          `실패: ${failedCount}개`
      );
    }
  }

  await editOriginalInteractionResponse(
    interaction,
    env,
    `🗑️ 채팅 삭제 완료\n` +
      `${total}/${total} 삭제 처리 완료\n` +
      `성공: ${deletedCount}개\n` +
      `실패: ${failedCount}개\n` +
      `14일 이내: ${recentCount}개\n` +
      `14일 초과: ${oldCount}개`
  );
}

/* =========================================================
   Durable Object: 정각 00초 정밀 스케줄러 Alarm
========================================================= */

export class PrecisionSchedulerDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  // 알람 발생 시 정각 00초 즉시 스케줄러 실행 및 다음 알람 예약
  async alarm() {
    console.log("DO ALARM TRIGGERED:", new Date().toISOString());
    await runScheduler(this.env);
    await this.scheduleNextAlarm();
  }

  // DB에서 가장 가까운 next_run_at을 찾아 alarm 설정
  async scheduleNextAlarm() {
    try {
      const row = await this.env.DB.prepare(`
        SELECT MIN(next_run_at) as next_time
        FROM schedules
        WHERE enabled = 1
      `).first();

      if (row && row.next_time) {
        const nextTimeMs = new Date(row.next_time).getTime();
        const currentAlarm = await this.state.storage.getAlarm();

        // 설정할 타겟 시각이 현재 시각보다 이전이면 즉시/최소 대기 후 실행되도록
        const targetAlarm = Math.max(nextTimeMs, Date.now() + 100);

        if (!currentAlarm || Math.abs(currentAlarm - targetAlarm) > 1000) {
          await this.state.storage.setAlarm(targetAlarm);
          console.log("DO ALARM SET TO:", new Date(targetAlarm).toISOString());
        }
      } else {
        await this.state.storage.deleteAlarm();
        console.log("DO ALARM CLEARED (NO SCHEDULES)");
      }
    } catch (e) {
      console.error("DO scheduleNextAlarm error:", e);
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/sync") {
      await this.scheduleNextAlarm();
      return json({ ok: true, message: "DO Alarm Synced" });
    }
    return new Response("Not Found", { status: 404 });
  }
}

/* =========================================================
   Worker Main Export
========================================================= */

export default {
  async fetch(
    request,
    env,
    ctx
  ) {
    const origin = "*";
    const url =
      new URL(request.url);

    /* ---------- Favicon ---------- */

    if (
      url.pathname.includes(
        "favicon.ico"
      ) ||
      url.pathname.includes(
        "apple-touch-icon"
      )
    ) {
      return new Response(
        null,
        {
          status: 204
        }
      );
    }

    /* ---------- CORS ---------- */

    if (
      request.method ===
      "OPTIONS"
    ) {
      return new Response(
        null,
        {
          headers: {
            "access-control-allow-origin":
              origin,
            "access-control-allow-headers":
              "Content-Type, Authorization",
            "access-control-allow-methods":
              "GET,POST,DELETE,OPTIONS"
          }
        }
      );
    }

    try {
      /* =====================================================
         Worker /
         명령어 등록
      ===================================================== */

      if (
        request.method ===
          "GET" &&
        url.pathname === "/"
      ) {
        const result =
          await registerCommands(
            env
          );

        if (result.ok) {
          return new Response(
            "✅ /채팅삭제 및 /채팅삭제플러스 명령어가 디스코드에 성공적으로 등록되었습니다!",
            {
              status: 200
            }
          );
        }

        return new Response(
          `❌ 명령어 등록 실패:\n${JSON.stringify(
            result,
            null,
            2
          )}`,
          {
            status: 500,
            headers: {
              "content-type":
                "text/plain; charset=utf-8"
            }
          }
        );
      }

      /* ---------- Login ---------- */

      if (
        url.pathname ===
        "/api/login"
      ) {
        return login(
          request,
          env
        );
      }

      /* ---------- OAuth Callback ---------- */

      if (
        url.pathname ===
        "/api/auth/callback"
      ) {
        return oauthCallback(
          request,
          env
        );
      }

      /* ---------- Discord Interaction ---------- */

      if (
        request.method ===
          "POST" &&
        url.pathname === "/"
      ) {
        const signature =
          request.headers.get(
            "X-Signature-Ed25519"
          );

        const timestamp =
          request.headers.get(
            "X-Signature-Timestamp"
          );

        const bodyText =
          await request.text();

        if (
          !signature ||
          !timestamp ||
          !env.DISCORD_PUBLIC_KEY
        ) {
          return new Response(
            "Invalid request signature",
            {
              status: 401
            }
          );
        }

        try {
          const hexToUint8Array =
            hex =>
              new Uint8Array(
                hex
                  .match(
                    /.{1,2}/g
                  )
                  .map(
                    b =>
                      parseInt(
                        b,
                        16
                      )
                  )
              );

          const key =
            await crypto.subtle.importKey(
              "raw",
              hexToUint8Array(
                env.DISCORD_PUBLIC_KEY.trim()
              ),
              {
                name:
                  "Ed25519",
                namedCurve:
                  "Ed25519"
              },
              false,
              ["verify"]
            );

          const valid =
            await crypto.subtle.verify(
              "Ed25519",
              key,
              hexToUint8Array(
                signature
              ),
              new TextEncoder().encode(
                timestamp +
                  bodyText
              )
            );

          if (!valid) {
            return new Response(
              "Invalid request signature",
              {
                status: 401
              }
            );
          }
        } catch {
          return new Response(
            "Invalid request signature",
            {
              status: 401
            }
          );
        }

        let interaction;

        try {
          interaction =
            JSON.parse(
              bodyText
            );
        } catch {
          return new Response(
            "Bad Request",
            {
              status: 400
            }
          );
        }

        /* ---------- PING ---------- */

        if (
          interaction.type === 1
        ) {
          return json({
            type: 1
          });
        }

        /* ---------- Slash Command ---------- */

        if (
          interaction.type === 2
        ) {
          const {
            name,
            options = []
          } = interaction.data;

          const channelId =
            interaction
              .channel
              .id;

          if (
            name ===
              "채팅삭제" ||
            name ===
              "채팅삭제플러스"
          ) {
            if (
              !hasManageMessagesPermission(
                interaction
              )
            ) {
              return interactionResponse(
                "❌ 이 명령어를 사용하려면 메시지 관리 권한이 필요합니다."
              );
            }
          }

          /* ---------- /채팅삭제 ---------- */

          if (
            name ===
            "채팅삭제"
          ) {
            const countOption =
              options.find(
                o =>
                  o.name ===
                  "개수"
              );

            const userOption =
              options.find(
                o =>
                  o.name ===
                  "유저"
              );

            const count =
              Number(
                countOption?.value
              );

            const targetUserId =
              userOption?.value ||
              null;

            if (
              !Number.isInteger(
                count
              ) ||
              count < 1 ||
              count > 100
            ) {
              return interactionResponse(
                "❌ 개수는 1~100 사이로 입력해주세요."
              );
            }

            return deleteNormalMessages(
              interaction,
              env,
              channelId,
              count,
              targetUserId
            );
          }

          /* ---------- /채팅삭제플러스 ---------- */

          if (
            name ===
            "채팅삭제플러스"
          ) {
            const countOption =
              options.find(
                o =>
                  o.name ===
                  "개수"
              );

            const count =
              Number(
                countOption?.value
              );

            if (
              !Number.isInteger(
                count
              ) ||
              count < 1 ||
              count > 100
            ) {
              return interactionResponse(
                "❌ 개수는 1~100 사이로 입력해주세요."
              );
            }

            ctx.waitUntil(
              deletePlusMessagesAndReply(
                interaction,
                env,
                channelId,
                count
              )
            );

            return json({
              type: 5
            });
          }
        }

        return json(
          {
            error:
              "Unknown interaction"
          },
          400
        );
      }

      /* ---------- Session API ---------- */

      const session =
        await requireSession(
          request,
          env
        );

      if (!session) {
        return json(
          {
            error:
              "Unauthorized"
          },
          401,
          origin
        );
      }

      /* ---------- /api/me ---------- */

      if (
        url.pathname ===
        "/api/me"
      ) {
        return json(
          {
            id:
              session.userId,
            username:
              session.username
          },
          200,
          origin
        );
      }

      /* ---------- Guilds ---------- */

      if (
        url.pathname ===
          "/api/guilds" &&
        request.method ===
          "GET"
      ) {
        return listGuilds(
          session,
          env
        );
      }

      /* ---------- Channels ---------- */

      const guildMatch =
        url.pathname.match(
          /^\/api\/guilds\/(\d+)\/channels$/
        );

      if (
        guildMatch &&
        request.method ===
          "GET"
      ) {
        return listChannels(
          guildMatch[1],
          env
        );
      }

      /* ---------- Roles ---------- */

      const rolesMatch =
        url.pathname.match(
          /^\/api\/guilds\/(\d+)\/roles$/
        );

      if (
        rolesMatch &&
        request.method ===
          "GET"
      ) {
        return listRoles(
          rolesMatch[1],
          env
        );
      }

      /* =====================================================
         ROLE MANAGER
      ===================================================== */

      if (
        request.method ===
          "GET" &&
        url.pathname ===
          "/api/role/sheet"
      ) {
        return getRoleSheet(
          request,
          env
        );
      }

      if (
        request.method ===
          "GET" &&
        url.pathname ===
          "/api/role/members"
      ) {
        return findRoleMembers(
          request,
          env,
          session
        );
      }

      if (
        request.method ===
          "POST" &&
        url.pathname ===
          "/api/role/assign-selected"
      ) {
        return processSelectedBaiyaRoles(
          request,
          env,
          session,
          "assign"
        );
      }

      if (
        request.method ===
          "POST" &&
        url.pathname ===
          "/api/role/remove-selected"
      ) {
        return processSelectedBaiyaRoles(
          request,
          env,
          session,
          "remove"
        );
      }

      if (
        request.method ===
          "POST" &&
        url.pathname ===
          "/api/role/remove-all"
      ) {
        return removeAllBaiyaRoles(
          request,
          env,
          session
        );
      }

      /* =====================================================
         Schedules
      ===================================================== */

      if (
        url.pathname ===
          "/api/schedules" &&
        request.method ===
          "GET"
      ) {
        return listSchedules(
          session,
          env
        );
      }

      if (
        url.pathname ===
          "/api/schedules" &&
        request.method ===
          "POST"
      ) {
        return createSchedule(
          request,
          env,
          session
        );
      }

      const scheduleMatch =
        url.pathname.match(
          /^\/api\/schedules\/([a-f0-9]+)$/
        );

      if (
        scheduleMatch &&
        request.method ===
          "DELETE"
      ) {
        return deleteSchedule(
          scheduleMatch[1],
          session,
          env
        );
      }

      const toggleMatch =
        url.pathname.match(
          /^\/api\/schedules\/([a-f0-9]+)\/toggle$/
        );

      if (
        toggleMatch &&
        request.method ===
          "POST"
      ) {
        return toggleSchedule(
          toggleMatch[1],
          session,
          env
        );
      }

      return json(
        {
          error:
            "Not found"
        },
        404,
        origin
      );
    } catch (error) {
      console.error(
        "WORKER ERROR",
        error
      );

      return json(
        {
          error:
            error.message ||
            "Server error"
        },
        500,
        origin
      );
    }
  },

  /* =========================================================
     Cloudflare Cron Scheduled Event
  ========================================================= */

  async scheduled(
    event,
    env,
    ctx
  ) {
    const scheduledTime =
      new Date(
        event.scheduledTime
      ).toISOString();

    const actualTime =
      new Date().toISOString();

    const delayMs =
      new Date(
        actualTime
      ).getTime() -
      new Date(
        scheduledTime
      ).getTime();

    console.log(
      "CRON DEBUG",
      {
        cron:
          event.cron,
        scheduledTime,
        actualTime,
        delayMs,
        delaySeconds:
          Math.round(
            delayMs / 1000
          )
      }
    );

    ctx.waitUntil(
      (async () => {
        await runScheduler(env);
        await syncDOAlarm(env);
      })()
    );
  }
};
