// Cloudflare Pages Function: 공연예술통합전산망(KOPIS) 공연 정보 → /api/kopis (2026-11-27)
// - 인증키는 Cloudflare 비밀 KOPIS_API_KEY (형이 직접 넣음, 코드에 넣지 않음). 응답에 키를 넣지 않는다.
// - 출처 표시 필수: (재)예술경영지원센터 공연예술통합전산망(www.kopis.or.kr) — 앱 화면에 적는다.
// - 키는 3개월 넘게 안 쓰면 승인이 취소되고, 1년마다 연장해야 한다(kopis@gokams.or.kr).
//
// action=list&codes=1111,1114   → 그 구·군(행정표준코드 앞 4자리, 앱의 KOPIS_CODES)에서 오늘부터 2주 안에 하는 공연
// action=detail&id=PF000000     → 공연 상세 + 공연장 주소·좌표·전화
// probe=...                     → 자료 모양 점검용 (미리보기 주소에서만)

const KOPIS_BASE = "https://www.kopis.or.kr/openApi/restful/";
const LIST_DAYS = 14;
const LIST_SECONDS = 6 * 60 * 60; // 목록은 6시간
const DETAIL_SECONDS = 24 * 60 * 60; // 상세는 하루
const memoryCache = new Map();

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", ...extra },
  });
}

// 한국 시각 날짜 YYYYMMDD
function kstYmd(offsetDays = 0) {
  const d = new Date(Date.now() + 9 * 3600 * 1000 + offsetDays * 86400000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

function decodeXml(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .trim();
}
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? decodeXml(m[1]) : "";
}
function dbs(text) {
  return [...String(text).matchAll(/<db>([\s\S]*?)<\/db>/g)].map((m) => m[1]);
}

async function cacheGet(key, seconds) {
  const m = memoryCache.get(key);
  if (m && Date.now() - m.at < seconds * 1000) return m.body;
  try {
    const hit = await caches.default.match(key);
    if (hit) {
      const at = Number(hit.headers.get("x-baram-saved-at")) || 0;
      if (Date.now() - at < seconds * 1000) {
        const body = await hit.text();
        memoryCache.set(key, { body, at });
        return body;
      }
    }
  } catch {}
  return null;
}
async function cachePut(key, body, seconds) {
  const at = Date.now();
  memoryCache.set(key, { body, at });
  if (memoryCache.size > 300) memoryCache.delete(memoryCache.keys().next().value);
  try {
    await caches.default.put(key, new Response(body, {
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": `public, max-age=${seconds}`, "x-baram-saved-at": String(at) },
    }));
  } catch {}
}

async function kopis(path, params, key) {
  const q = new URLSearchParams({ service: key, ...params });
  const res = await fetch(KOPIS_BASE + path + "?" + q.toString(), { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error("KOPIS " + res.status);
  const text = await res.text();
  if (/<returncode>|<errmsg>/i.test(text) && !/<db>/.test(text)) throw new Error("KOPIS error");
  return text;
}

// 구·군 하나의 2주 공연 목록 (최대 3쪽 × 100)
async function listForCode(code, key) {
  const sido = code.slice(0, 2);
  const st = kstYmd(0), ed = kstYmd(LIST_DAYS);
  const out = [];
  for (let page = 1; page <= 3; page++) {
    const text = await kopis("pblprfr", { stdate: st, eddate: ed, cpage: String(page), rows: "100", signgucode: sido, signgucodesub: code }, key);
    const rows = dbs(text);
    rows.forEach((b) => {
      out.push({
        id: tag(b, "mt20id"),
        title: tag(b, "prfnm"),
        from: tag(b, "prfpdfrom"),
        to: tag(b, "prfpdto"),
        venue: tag(b, "fcltynm"),
        poster: tag(b, "poster").replace(/^http:\/\//, "https://"),
        genre: tag(b, "genrenm"),
        state: tag(b, "prfstate"),
        openrun: tag(b, "openrun") === "Y",
      });
    });
    if (rows.length < 100) break;
  }
  return out;
}

async function handleList(url, key) {
  const codes = String(url.searchParams.get("codes") || "")
    .split(",").map((s) => s.trim()).filter((s) => /^\d{4}$/.test(s)).slice(0, 3);
  if (codes.length === 0) return json({ error: "codes" }, 400);
  const day = kstYmd(0);
  const results = await Promise.all(codes.map(async (code) => {
    const ck = `https://baram-cache.internal/kopis/list/v1/${code}/${day}`;
    const hit = await cacheGet(ck, LIST_SECONDS);
    if (hit) return JSON.parse(hit);
    const list = await listForCode(code, key);
    await cachePut(ck, JSON.stringify(list), LIST_SECONDS);
    return list;
  }));
  const seen = new Set();
  const items = [];
  results.flat().forEach((p) => {
    if (!p.id || seen.has(p.id)) return;
    seen.add(p.id);
    items.push(p);
  });
  return json({ items }, 200, { "cache-control": "public, max-age=600" });
}

async function handleDetail(url, key) {
  const id = String(url.searchParams.get("id") || "");
  if (!/^PF\d{4,}$/.test(id)) return json({ error: "id" }, 400);
  const ck = `https://baram-cache.internal/kopis/detail/v1/${id}`;
  const hit = await cacheGet(ck, DETAIL_SECONDS);
  if (hit) return json(JSON.parse(hit), 200, { "cache-control": "public, max-age=3600" });
  const text = await kopis("pblprfr/" + id, {}, key);
  const b = dbs(text)[0];
  if (!b) return json({ error: "notfound" }, 404);
  const detail = {
    id,
    title: tag(b, "prfnm"),
    from: tag(b, "prfpdfrom"),
    to: tag(b, "prfpdto"),
    venue: tag(b, "fcltynm"),
    cast: tag(b, "prfcast"),
    runtime: tag(b, "prfruntime"),
    age: tag(b, "prfage"),
    price: tag(b, "pcseguidance"),
    times: tag(b, "dtguidance"),
    genre: tag(b, "genrenm"),
    state: tag(b, "prfstate"),
    poster: tag(b, "poster").replace(/^http:\/\//, "https://"),
    images: [...b.matchAll(/<styurl>([\s\S]*?)<\/styurl>/g)].map((m) => decodeXml(m[1]).replace(/^http:\/\//, "https://")).filter(Boolean).slice(0, 6),
    links: [...b.matchAll(/<relate>([\s\S]*?)<\/relate>/g)].map((m) => ({ name: tag(m[1], "relatenm"), url: tag(m[1], "relateurl") }))
      .filter((l) => /^https?:\/\//.test(l.url)).slice(0, 4),
    venueId: tag(b, "mt10id"),
  };
  // 공연장 주소·좌표·전화 (실패해도 공연 정보는 보여 준다)
  if (/^FC\d+$/.test(detail.venueId)) {
    try {
      const v = dbs(await kopis("prfplc/" + detail.venueId, {}, key))[0];
      if (v) {
        detail.address = tag(v, "adres");
        detail.lat = Number(tag(v, "la")) || null;
        detail.lng = Number(tag(v, "lo")) || null;
        detail.tel = tag(v, "telno");
        detail.venueName = tag(v, "fcltynm");
      }
    } catch {}
  }
  await cachePut(ck, JSON.stringify(detail), DETAIL_SECONDS);
  return json(detail, 200, { "cache-control": "public, max-age=3600" });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const host = url.hostname;
  const isPreview = host !== "baram-bh4.pages.dev" && host.endsWith(".baram-bh4.pages.dev");
  const key = env.KOPIS_API_KEY || "";
  if (!key) return json({ error: "NO_KEY" }, 500);

  // 점검 통로: /api/kopis?probe=pblprfr&stdate=...  (미리보기 주소에서만)
  const probe = url.searchParams.get("probe");
  if (probe !== null) {
    if (!isPreview) return new Response("NOT_HERE", { status: 404 });
    if (!/^[a-z]+(\/[A-Za-z0-9]+)?$/.test(probe)) return new Response("BAD_PATH", { status: 400 });
    const q = new URLSearchParams();
    q.set("service", key);
    for (const [k, v] of url.searchParams) if (k !== "probe") q.set(k, v);
    const started = Date.now();
    try {
      const res = await fetch(KOPIS_BASE + probe + "?" + q.toString(), { signal: AbortSignal.timeout(10000) });
      const text = (await res.text()).split(key).join("(KEY)");
      return new Response(text, { status: res.status, headers: { "content-type": "text/plain; charset=utf-8", "x-ms": String(Date.now() - started) } });
    } catch (e) {
      return new Response("FETCH_FAIL " + (e && e.message) + " after " + (Date.now() - started) + "ms", { status: 502 });
    }
  }

  const action = url.searchParams.get("action");
  try {
    if (action === "list") return await handleList(url, key);
    if (action === "detail") return await handleDetail(url, key);
  } catch (e) {
    return json({ error: String((e && e.message) || e).split(key).join("") }, 502);
  }
  return json({ error: "action" }, 400);
}
