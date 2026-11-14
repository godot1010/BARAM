// Cloudflare Pages Function: 익명 사용 집계 → /api/ping (2026-10-19)
// - 구글 Play 통계의 '일일 활성 사용자'가 BARAM(웹을 감싼 앱)에서는 거의 잡히지 않아서, 우리가 직접 하루 사용 수만 센다.
// - 이름·이메일·위치·기기 번호 같은 식별 정보는 받지도 저장하지도 않는다. 날짜별 숫자만 올린다.
// - 저장소: Cloudflare KV. Pages 프로젝트 설정에서 KV 네임스페이스를 BARAM_STATS 라는 이름으로 연결해야 한다.
//   연결 전에는 아무것도 저장하지 않고 조용히 넘어간다(앱 동작에는 영향 없음).
//
// POST /api/ping?src=app|web&day=1   — 앱이 열릴 때. day=1 이면 그 폰의 '오늘 첫 사용'(사용한 폰 수)도 하나 올린다.
// POST /api/ping?err=종류              — 앱이 오류를 만났을 때 (2026-11-15). 오류 '종류'(짧은 글자)만 받아 날짜별로 센다.
//                                        폰마다 같은 종류는 하루 한 번, 하루 5종류까지만 보낸다(앱이 폰 안에서 막음) → 숫자 ≈ 그 오류를 만난 폰 수.
// GET  /api/ping?view=stats           — 최근 21일 집계 (stats.html·자동 점검기가 읽는다)

const SOURCES = ["app", "web"];
const DAYS_TO_SHOW = 21;
const MAX_ERROR_KINDS = 40; // 하루에 이보다 많은 종류는 '(그 밖의 오류)'로 묶는다 (저장 크기 제한)

// 오류 종류 글자 다듬기: 길이 제한, 줄바꿈·제어 문자 빼기 (앱에서도 숫자·주소를 지우고 보낸다)
function cleanKind(s) {
  return String(s || "").replace(/[\u0000-\u001f]/g, " ").replace(/https?:\/\/\S+/g, "(주소)").replace(/\d[\d.]{3,}/g, "#").replace(/\s+/g, " ").trim().slice(0, 80);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

// 한국 시간 기준 날짜 (YYYY-MM-DD)
function kstDate(offsetDays = 0) {
  return new Date(Date.now() + 9 * 3600 * 1000 - offsetDays * 86400 * 1000).toISOString().slice(0, 10);
}

async function increment(kv, key) {
  // KV에는 '1 올리기'가 없어 읽고 쓴다. 동시에 들어오면 가끔 하나쯤 덜 셀 수 있지만 대략적인 사용량을 보는 데는 충분하다.
  const now = Number(await kv.get(key)) || 0;
  await kv.put(key, String(now + 1), { expirationTtl: 400 * 86400 }); // 1년 넘게 보관하지 않는다
}

export async function onRequest({ request, env }) {
  const kv = env.BARAM_STATS;
  const url = new URL(request.url);

  if (request.method === "GET" && url.searchParams.get("view") === "stats") {
    if (!kv) return json({ connected: false, days: [] });
    const days = [];
    for (let i = 0; i < DAYS_TO_SHOW; i++) {
      const date = kstDate(i);
      const row = { date };
      for (const src of SOURCES) {
        const [devices, opens] = await Promise.all([kv.get(`d:${date}:${src}`), kv.get(`o:${date}:${src}`)]);
        row[src] = { devices: Number(devices) || 0, opens: Number(opens) || 0 };
      }
      row.errors = (await kv.get(`e:${date}`, "json")) || {};
      days.push(row);
    }
    return json({ connected: true, days });
  }

  if (request.method === "POST" && url.searchParams.has("err")) {
    let kind = cleanKind(url.searchParams.get("err"));
    if (!kind) return json({ ok: false }, 400);
    if (!kv) return json({ ok: true, stored: false });
    try {
      const key = `e:${kstDate()}`;
      const counts = (await kv.get(key, "json")) || {};
      if (!(kind in counts) && Object.keys(counts).length >= MAX_ERROR_KINDS) kind = "(그 밖의 오류)";
      counts[kind] = (counts[kind] || 0) + 1;
      await kv.put(key, JSON.stringify(counts), { expirationTtl: 400 * 86400 });
    } catch {
      // 집계 실패는 무시한다
    }
    return json({ ok: true, stored: true });
  }

  if (request.method === "POST") {
    const src = url.searchParams.get("src");
    if (!SOURCES.includes(src)) return json({ ok: false }, 400);
    if (!kv) return json({ ok: true, stored: false });
    const date = kstDate();
    try {
      await increment(kv, `o:${date}:${src}`);
      if (url.searchParams.get("day") === "1") await increment(kv, `d:${date}:${src}`);
    } catch {
      // 집계 실패는 무시한다 (앱 동작과 무관)
    }
    return json({ ok: true, stored: true });
  }

  return json({ ok: false }, 405);
}
