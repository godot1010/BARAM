// Cloudflare Pages Function: 여행지 날씨 → /api/weather?lat=..&lng=..
// - 기상청 단기예보 조회서비스(공공데이터포털, getVilageFcst)를 쓴다.
// - 공공데이터포털 인증키는 하나라서 관광정보와 같은 TOUR_API_SERVICE_KEY 를 쓴다.
//   (공공데이터포털에서 '기상청_단기예보 조회서비스' 활용신청이 되어 있어야 한다)
// - 기상청은 위도·경도 대신 5km 격자(nx, ny)로 묻는다. 같은 격자는 같은 결과라 격자 + 발표 시각으로 저장한다.
// - 실패하면 { error } 를 돌려주고, 앱은 날씨 줄을 조용히 숨긴다.

const KMA_BASE = "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst";
const CACHE_SECONDS = 3 * 60 * 60; // 발표 시각이 키에 들어가므로, 새 발표가 나오면 자동으로 새로 받는다
const memoryCache = new Map();

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", ...extraHeaders },
  });
}

function normalizeServiceKey(key) {
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
}

// 위도·경도 → 기상청 격자 (기상청 공식 변환식, 람베르트 정각원추도법)
function toGrid(lat, lng) {
  const RE = 6371.00877, GRID = 5.0, SLAT1 = 30.0, SLAT2 = 60.0, OLON = 126.0, OLAT = 38.0, XO = 43, YO = 136;
  const DEG = Math.PI / 180;
  const re = RE / GRID;
  const slat1 = SLAT1 * DEG, slat2 = SLAT2 * DEG, olon = OLON * DEG, olat = OLAT * DEG;
  let sn = Math.tan(Math.PI * 0.25 + slat2 * 0.5) / Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) / Math.log(sn);
  let sf = Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sf = (Math.pow(sf, sn) * Math.cos(slat1)) / sn;
  let ro = Math.tan(Math.PI * 0.25 + olat * 0.5);
  ro = (re * sf) / Math.pow(ro, sn);
  let ra = Math.tan(Math.PI * 0.25 + lat * DEG * 0.5);
  ra = (re * sf) / Math.pow(ra, sn);
  let theta = lng * DEG - olon;
  if (theta > Math.PI) theta -= 2 * Math.PI;
  if (theta < -Math.PI) theta += 2 * Math.PI;
  theta *= sn;
  return { nx: Math.floor(ra * Math.sin(theta) + XO + 0.5), ny: Math.floor(ro - ra * Math.cos(theta) + YO + 0.5) };
}

// 한국 시각 기준 날짜 문자열(YYYYMMDD)
function ymd(d) {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

// 단기예보는 하루 8번(02·05·08·11·14·17·20·23시) 발표되고, 발표 10분 뒤부터 받을 수 있다.
// latest = 지금 받을 수 있는 가장 새 발표, dayStart = 오늘 하루 전체(최저기온 포함)가 들어 있는 오늘 02시 발표
function baseTimes(kst) {
  const minutes = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  const yesterday = new Date(kst.getTime() - 24 * 60 * 60 * 1000);
  const hours = [2, 5, 8, 11, 14, 17, 20, 23].filter((h) => h * 60 + 10 <= minutes);
  const latest = hours.length
    ? { date: ymd(kst), time: `${String(hours[hours.length - 1]).padStart(2, "0")}00` }
    : { date: ymd(yesterday), time: "2300" };
  const dayStart = minutes >= 2 * 60 + 10 ? { date: ymd(kst), time: "0200" } : { date: ymd(yesterday), time: "2300" };
  return { latest, dayStart };
}

async function fetchForecast(serviceKey, base, grid) {
  const key = `https://baram-cache.internal/weather?d=${base.date}&t=${base.time}&x=${grid.nx}&y=${grid.ny}`;
  const mem = memoryCache.get(key);
  if (mem && Date.now() - mem.savedAt < CACHE_SECONDS * 1000) return mem.items;
  try {
    const hit = await caches.default.match(key);
    if (hit) {
      const items = JSON.parse(await hit.text());
      memoryCache.set(key, { savedAt: Date.now(), items });
      return items;
    }
  } catch {
    // Cloudflare 캐시를 쓸 수 없는 환경이면 메모리만 쓴다
  }

  const qs = new URLSearchParams({
    serviceKey, pageNo: "1", numOfRows: "1000", dataType: "JSON",
    base_date: base.date, base_time: base.time, nx: String(grid.nx), ny: String(grid.ny),
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  let text;
  try {
    const res = await fetch(`${KMA_BASE}?${qs}`, { signal: controller.signal });
    text = await res.text();
  } finally {
    clearTimeout(timer);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // 키 미등록 등은 XML로 온다 (예: SERVICE_KEY_IS_NOT_REGISTERED_ERROR)
    const reason = (text.match(/<returnAuthMsg>([^<]+)/) || text.match(/<resultMsg>([^<]+)/) || [])[1] || "응답이 JSON이 아님";
    throw new Error(`기상청 응답 오류: ${reason}`);
  }
  const header = data?.response?.header;
  if (header?.resultCode !== "00") throw new Error(`기상청 응답 오류: ${header?.resultMsg || "알 수 없음"}`);
  const items = data.response.body?.items?.item || [];
  if (!items.length) throw new Error("기상청 예보가 비어 있어요.");

  if (memoryCache.size > 500) memoryCache.delete(memoryCache.keys().next().value);
  memoryCache.set(key, { savedAt: Date.now(), items });
  try {
    await caches.default.put(key, new Response(JSON.stringify(items), { headers: { "cache-control": `public, max-age=${CACHE_SECONDS}` } }));
  } catch {
    // 무시
  }
  return items;
}

// 예보 항목들을 날짜·시각별로 모은다. 뒤에 넣은 것(더 새 발표)이 앞의 값을 덮는다
function collect(lists) {
  const slots = new Map(); // "YYYYMMDD HHMM" -> { TMP, SKY, PTY, POP, ... }
  const daily = new Map(); // "YYYYMMDD" -> { TMN, TMX }
  for (const items of lists) {
    for (const it of items) {
      const v = it.fcstValue;
      if (it.category === "TMN" || it.category === "TMX") {
        const d = daily.get(it.fcstDate) || {};
        d[it.category] = Number(v);
        daily.set(it.fcstDate, d);
        continue;
      }
      const k = `${it.fcstDate} ${it.fcstTime}`;
      const s = slots.get(k) || { date: it.fcstDate, hour: Number(it.fcstTime.slice(0, 2)) };
      s[it.category] = Number(v);
      slots.set(k, s);
    }
  }
  return { slots: [...slots.values()].sort((a, b) => (a.date + String(a.hour).padStart(2, "0")).localeCompare(b.date + String(b.hour).padStart(2, "0"))), daily };
}

function lowHigh(temps, extreme, pick) {
  const all = Number.isFinite(extreme) ? [...temps, extreme] : temps;
  return all.length ? Math.round(pick(...all)) : null;
}

// 하루 요약: 최저·최고, 낮(6~21시) 중 가장 높은 강수확률, 비·눈 소식이 있는 시각
function summarize(date, slots, daily, fromHour) {
  const day = slots.filter((s) => s.date === date);
  if (!day.length) return null;
  const temps = day.map((s) => s.TMP).filter((t) => Number.isFinite(t));
  const d = daily.get(date) || {};
  const daytime = day.filter((s) => s.hour >= Math.max(6, fromHour) && s.hour <= 21);
  const rainHours = daytime.filter((s) => s.PTY > 0 || s.POP >= 60).map((s) => s.hour);
  const snow = daytime.some((s) => s.PTY === 2 || s.PTY === 3);
  return {
    // 최저·최고 예보(TMN·TMX)와 시간별 기온을 함께 본다 (밤에 '지금'이 최저보다 낮게 나오는 일이 없게)
    min: lowHigh(temps, d.TMN, Math.min),
    max: lowHigh(temps, d.TMX, Math.max),
    pop: daytime.length ? Math.max(...daytime.map((s) => s.POP || 0)) : null,
    rainHours,
    snow,
  };
}

export async function onRequest({ request, env }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS" } });
  }
  try {
    const url = new URL(request.url);
    const lat = parseFloat(url.searchParams.get("lat"));
    const lng = parseFloat(url.searchParams.get("lng"));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return json({ error: "BAD_REQUEST", message: "lat/lng가 필요해요." }, 400);
    if (!env.TOUR_API_SERVICE_KEY) return json({ error: "SERVER_NO_KEY", message: "서버에 공공데이터 키가 없어요." }, 500);
    const serviceKey = normalizeServiceKey(env.TOUR_API_SERVICE_KEY);

    const grid = toGrid(lat, lng);
    const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const { latest, dayStart } = baseTimes(kst);
    const same = latest.date === dayStart.date && latest.time === dayStart.time;
    const [dayItems, latestItems] = await Promise.all([
      fetchForecast(serviceKey, dayStart, grid),
      same ? null : fetchForecast(serviceKey, latest, grid),
    ]);
    const { slots, daily } = collect(latestItems ? [dayItems, latestItems] : [dayItems]);

    const today = ymd(kst);
    const tomorrow = ymd(new Date(kst.getTime() + 24 * 60 * 60 * 1000));
    const hour = kst.getUTCHours();
    const now = slots.find((s) => s.date > today || (s.date === today && s.hour >= hour)) || slots[slots.length - 1];

    return json(
      {
        grid,
        base: latest,
        hour,
        now: now ? { temp: now.TMP, sky: now.SKY, pty: now.PTY, pop: now.POP } : null,
        today: summarize(today, slots, daily, hour),
        tomorrow: summarize(tomorrow, slots, daily, 0),
      },
      200,
      { "cache-control": "public, max-age=600" }
    );
  } catch (err) {
    return json({ error: "WEATHER_ERROR", message: String((err && err.message) || err) }, 502);
  }
}
