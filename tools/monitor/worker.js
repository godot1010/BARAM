// BARAM 자동 점검 (2026-11-15 형 결정: 카카오톡 '나에게 보내기'로 알림)
// - 1시간마다(cron) 실제 사이트(https://baram-bh4.pages.dev)를 앱과 같은 방법으로 불러 본다.
// - 두 번 연속 실패할 때만 형 카톡으로 알림, 고쳐지면 '복구' 알림 한 번.
// - 매주 월요일 9시(한국)에 '이번 주도 정상' 한 줄 → 점검기가 살아 있는지 형이 알 수 있게 + 카카오 토큰이 만료되지 않게.
// 비밀 값(코드에 넣지 않음, 형이 Cloudflare에 직접 넣음): KAKAO_REST_KEY (카카오 앱 REST API 키), KAKAO_CLIENT_SECRET(쓸 때만)
// 저장(KV, 바인딩 이름 MONITOR): "state"(점검 상태), "kakao"(카카오 토큰), (로그인 확인 값은 쿠키)
// 카카오 로그인을 다시 연결하려면 KV의 "kakao" 열쇠를 지우고 /kakao/login 을 다시 연다.

const SITE = "https://baram-bh4.pages.dev";
const TIMEOUT_MS = 25000;
// 강릉 — 늘 같은 값으로 물어서 서버 저장본(24시간)을 주로 쓰게 한다 → 공공데이터 호출은 하루 몇 번뿐
const SPOT = { lat: "37.7519", lng: "128.8761", sido: "강원", sgg: "강릉시", name: "강릉" };

async function getJson(path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(SITE + path, { signal: ctrl.signal, headers: { "user-agent": "baram-monitor" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    throw new Error(e.name === "AbortError" ? "응답 없음(25초)" : e.message);
  } finally {
    clearTimeout(timer);
  }
}

function nearbyPath(contentTypeId) {
  const q = new URLSearchParams({ action: "nearby", lat: SPOT.lat, lng: SPOT.lng, contentTypeId, radius: "20000", num: "50", sido: SPOT.sido, sgg: SPOT.sgg });
  return `/api/tourapi?${q}`;
}

function kstNow() {
  return new Date(Date.now() + 9 * 3600 * 1000); // getUTC*로 읽으면 한국 시간
}
function kstLabel(d = kstNow()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// 점검 하나하나: [이름, 함수] — 함수가 오류를 던지면 실패
function buildChecks() {
  let firstAttractionId = null;
  return [
    ["첫 화면", async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(SITE + "/", { signal: ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();
        if (!html.includes("BARAM")) throw new Error("내용이 이상함");
      } finally { clearTimeout(timer); }
    }],
    [`명소(${SPOT.name})`, async () => {
      const d = await getJson(nearbyPath("12"));
      const n = (d.items || []).length;
      if (n < 10) throw new Error(`${n}곳`);
      firstAttractionId = d.items[0].contentid;
    }],
    [`맛집·카페(${SPOT.name})`, async () => {
      const items = (await getJson(nearbyPath("39"))).items || [];
      if (items.length < 10) throw new Error(`${items.length}곳`);
      const cafes = items.filter((x) => x.cat3 === "A05020900" || String(x.lclsSystm3 || "").startsWith("FD05")).length;
      if (cafes < 1) throw new Error("카페 0곳(카페 구분 고장?)");
    }],
    [`숙소(${SPOT.name})`, async () => {
      const n = ((await getJson(nearbyPath("32"))).items || []).length;
      if (n < 5) throw new Error(`${n}곳`);
    }],
    ["축제", async () => {
      const d = kstNow();
      const ym = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}01`;
      const n = ((await getJson(`/api/tourapi?action=festival&eventStartDate=${ym}&numOfRows=1000`)).items || []).length;
      if (n < 1) throw new Error("0건");
    }],
    ["장소 정보 창", async () => {
      if (!firstAttractionId) throw new Error("명소가 없어 못 봄");
      const n = ((await getJson(`/api/tourapi?action=detail&contentId=${firstAttractionId}&contentTypeId=12`)).items || []).length;
      if (n < 1) throw new Error("내용 없음");
    }],
    ["날씨", async () => {
      const w = await getJson(`/api/weather?lat=${SPOT.lat}&lng=${SPOT.lng}`);
      if (!w.now || typeof w.now.temp !== "number") throw new Error("기온 없음");
    }],
    ["STAR 목록", async () => {
      const d = await getJson("/star-places.json?v=6");
      const n = (d.places || []).length;
      if (n < 100) throw new Error(`${n}곳`);
    }],
  ];
}

async function runChecks() {
  const results = [];
  for (const [name, fn] of buildChecks()) { // 차례로 (장소 정보 창은 명소 결과를 씀)
    try { await fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, why: String(e.message || e) }); }
  }
  return results;
}

// ---------- 카카오톡 나에게 보내기 ----------
async function kakaoToken(env, params) {
  const body = new URLSearchParams({ client_id: env.KAKAO_REST_KEY, ...params });
  if (env.KAKAO_CLIENT_SECRET) body.set("client_secret", env.KAKAO_CLIENT_SECRET);
  const res = await fetch("https://kauth.kakao.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=utf-8" },
    body,
  });
  const d = await res.json();
  if (!res.ok || !d.access_token) throw new Error(`카카오 토큰 실패: ${d.error_description || d.error || res.status}`);
  return d;
}

// 저장된 토큰을 새로 받는다(force면 아직 쓸 수 있어도). 새 refresh_token이 오면(만료 1달 안쪽일 때) 같이 바꾼다.
async function freshAccess(env, force = false) {
  const saved = await env.MONITOR.get("kakao", "json");
  if (!saved || !saved.refresh) throw new Error("카카오 연결 안 됨(/kakao/login 필요)");
  if (!force && saved.access && saved.accessExp > Date.now() + 5 * 60 * 1000) return saved.access;
  const d = await kakaoToken(env, { grant_type: "refresh_token", refresh_token: saved.refresh });
  const next = {
    access: d.access_token,
    accessExp: Date.now() + (d.expires_in || 3600) * 1000,
    refresh: d.refresh_token || saved.refresh,
    refreshExp: d.refresh_token ? Date.now() + (d.refresh_token_expires_in || 0) * 1000 : saved.refreshExp,
  };
  await env.MONITOR.put("kakao", JSON.stringify(next));
  return next.access;
}

async function sendKakao(env, text) {
  const access = await freshAccess(env);
  const template = {
    object_type: "text",
    text: text.slice(0, 200), // 카카오 기본 텍스트는 200자까지
    link: { web_url: SITE, mobile_web_url: SITE },
    button_title: "BARAM 열기",
  };
  const res = await fetch("https://kapi.kakao.com/v2/api/talk/memo/default/send", {
    method: "POST",
    headers: { authorization: `Bearer ${access}`, "content-type": "application/x-www-form-urlencoded;charset=utf-8" },
    body: new URLSearchParams({ template_object: JSON.stringify(template) }),
  });
  if (!res.ok) throw new Error(`카카오 보내기 실패: ${res.status} ${await res.text()}`);
}

// ---------- 정해진 시간 실행 ----------
async function hourly(env) {
  const results = await runChecks();
  const bad = results.filter((r) => !r.ok);
  const prev = (await env.MONITOR.get("state", "json")) || { fails: 0, alerted: false };
  const state = { fails: bad.length ? prev.fails + 1 : 0, alerted: bad.length ? prev.alerted : false, last: kstLabel(), results };

  if (bad.length && state.fails >= 2 && !prev.alerted) {
    const lines = bad.map((r) => `· ${r.name}: ${r.why}`).join("\n");
    await sendKakao(env, `⚠️ BARAM 이상 (${state.fails}번 연속)\n${lines}\n${kstLabel()}`).then(() => { state.alerted = true; }).catch((e) => { state.sendError = String(e.message); });
  } else if (!bad.length && prev.alerted) {
    await sendKakao(env, `✅ BARAM 복구됐어요\n모든 점검 정상 · ${kstLabel()}`).catch((e) => { state.sendError = String(e.message); });
  }

  const k = kstNow();
  // 매주 월요일 9시: 살아 있다는 한 줄 (토큰도 이때 새로 받아 만료를 막음)
  if (k.getUTCDay() === 1 && k.getUTCHours() === 9) {
    const msg = bad.length ? `🔎 BARAM 주간 점검: 지금 ${bad.length}개 이상` : "🔎 BARAM 주간 점검: 이번 주도 정상이에요";
    await freshAccess(env, true).then(() => sendKakao(env, `${msg} · ${kstLabel()}`)).catch((e) => { state.sendError = String(e.message); });
  }
  await env.MONITOR.put("state", JSON.stringify(state));
  return state;
}

// ---------- 주소로 여는 화면 ----------
function page(title, body) {
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:sans-serif;max-width:520px;margin:24px auto;padding:0 16px;line-height:1.6"><h2>${title}</h2>${body}</body>`, { headers: { "content-type": "text/html;charset=utf-8" } });
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function resultList(results) {
  return "<ul>" + results.map((r) => `<li>${r.ok ? "✅" : "❌"} ${esc(r.name)}${r.ok ? "" : ` — ${esc(r.why)}`}</li>`).join("") + "</ul>";
}

async function handle(request, env) {
  const url = new URL(request.url);
  const redirectUri = `${url.origin}/kakao/callback`;

  if (url.pathname === "/") {
    const state = await env.MONITOR.get("state", "json");
    const kakao = await env.MONITOR.get("kakao", "json");
    return page("BARAM 자동 점검", `
      <p>카카오 연결: ${kakao ? "✅ 됨" : "❌ 안 됨 — <a href='/kakao/login'>카카오 로그인</a>"}</p>
      ${state ? `<p>마지막 점검: ${esc(state.last)} · 연속 실패 ${state.fails}번${state.alerted ? " · 알림 보냄" : ""}</p>${resultList(state.results || [])}${state.sendError ? `<p>보내기 오류: ${esc(state.sendError)}</p>` : ""}` : "<p>아직 점검 기록 없음</p>"}
      <p><a href="/check">지금 점검해 보기</a> (알림은 안 보냄)</p>`);
  }

  if (url.pathname === "/check") {
    return page("지금 점검", resultList(await runChecks()));
  }

  if (url.pathname === "/kakao/login") {
    if (!env.KAKAO_REST_KEY) return page("준비 안 됨", "<p>Cloudflare에 KAKAO_REST_KEY 비밀 값을 먼저 넣어 주세요.</p>");
    if (await env.MONITOR.get("kakao")) return page("이미 연결됨", "<p>카카오가 이미 연결돼 있어요. 다시 연결하려면 KV의 'kakao'를 지운 뒤 여세요.</p>");
    // 확인 값은 KV가 아니라 쿠키에 (KV는 방금 쓴 값을 다른 곳에서 바로 못 읽을 때가 있어 '확인 값이 맞지 않아요'가 났음, 2026-11-15)
    const st = crypto.randomUUID();
    const q = new URLSearchParams({ client_id: env.KAKAO_REST_KEY, redirect_uri: redirectUri, response_type: "code", scope: "talk_message", state: st });
    return new Response(null, { status: 302, headers: {
      location: `https://kauth.kakao.com/oauth/authorize?${q}`,
      "set-cookie": `oauth_state=${st}; Path=/kakao; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
    } });
  }

  if (url.pathname === "/kakao/callback") {
    const expect = (/(?:^|;\s*)oauth_state=([\w-]+)/.exec(request.headers.get("cookie") || "") || [])[1];
    if (!expect || url.searchParams.get("state") !== expect) return page("연결 실패", "<p>확인 값이 맞지 않아요. /kakao/login 부터 다시 해 주세요.</p>");
    if (await env.MONITOR.get("kakao")) return page("이미 연결됨", "<p>카카오가 이미 연결돼 있어요.</p>");
    const code = url.searchParams.get("code");
    if (!code) return page("연결 실패", `<p>${esc(url.searchParams.get("error_description") || "동의하지 않았어요.")}</p>`);
    try {
      const d = await kakaoToken(env, { grant_type: "authorization_code", redirect_uri: redirectUri, code });
      // 메시지 전송은 '선택 동의'라 체크를 안 하면 토큰에 권한이 없다 (2026-11-15 첫 시도에서 이렇게 실패)
      if (!String(d.scope || "").split(" ").includes("talk_message")) {
        return page("한 번 더 해 주세요", "<p>카카오 동의 화면에서 <b>'카카오톡 메시지 전송'</b>에 체크가 안 됐어요.<br><a href='/kakao/login'>다시 로그인</a>하고 그 칸에 체크해 주세요.</p>");
      }
      await env.MONITOR.put("kakao", JSON.stringify({
        access: d.access_token,
        accessExp: Date.now() + (d.expires_in || 3600) * 1000,
        refresh: d.refresh_token,
        refreshExp: Date.now() + (d.refresh_token_expires_in || 0) * 1000,
      }));
      await sendKakao(env, `🔔 BARAM 자동 점검이 연결됐어요.\n문제가 2시간 연속 생기면 여기로 알려 드릴게요. · ${kstLabel()}`);
      return page("연결 완료 🎉", "<p>카카오톡 '나와의 채팅'에 시험 메시지를 보냈어요. 알림음이 울렸는지 확인해 주세요.</p>");
    } catch (e) {
      return page("연결 실패", `<p>${esc(e.message)}</p>`);
    }
  }

  return new Response("Not found", { status: 404 });
}

export default {
  fetch: (request, env) => handle(request, env),
  scheduled: (event, env, ctx) => { ctx.waitUntil(hourly(env)); },
};
