// Cloudflare Pages Function: TourAPI(공공데이터포털) 프록시
// - 진짜 서비스키는 여기(서버)에만 있고, 브라우저에는 절대 노출되지 않는다.
// - 키는 Cloudflare Pages 프로젝트 설정 > Settings > Environment variables 에
//   TOUR_API_SERVICE_KEY 로 등록해야 한다. (Production/Preview 둘 다 등록 권장)
//   ("인증키(Decoding)" 원본 값을 그대로 넣으면 된다. 이미 URL 인코딩된 "Encoding" 키를
//    넣었어도 아래 normalizeServiceKey()가 자동으로 복원해서 처리한다.)
// - 파일 경로 functions/api/tourapi.js 는 Cloudflare Pages의 파일 기반 라우팅 규칙에 따라
//   자동으로 /api/tourapi 경로에 매핑된다 (별도 리다이렉트 설정 불필요).
//
// action 목록
// - nearby    : 위치 주변 관광정보 (locationBasedList2)
// - festival  : 축제 목록 (searchFestival2)
// - pet       : 반려동물 동반 여행 정보 원본 (detailPetTour2, 확인용)
// - petNearby : 위치 주변의 '반려동물 동반 가능' 장소만 모아서, 동반 조건과 함께 돌려준다

const TOUR_API_BASE = "https://apis.data.go.kr/B551011/KorService2";

function normalizeServiceKey(key) {
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
}

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // 이 함수를 다른 도메인(예: 개발 중 로컬 테스트)에서도 부를 수 있게 허용
      "access-control-allow-origin": "*",
      ...extraHeaders,
    },
  });
}

// ------------------------------------------------------------------
// 캐시: 같은 요청은 정해진 시간 동안 저장해 둔 결과를 돌려준다.
// - 공공데이터 서버는 하루 호출 한도가 있고 자주 느리거나 522/502를 내서, 같은 지역을 여러 사람이
//   조회해도 공공데이터 서버에는 한 번만 묻도록 한다. 성공한 응답만 저장한다.
// - 1단계: 이 서버 프로그램이 떠 있는 동안 메모리에 보관(같은 서버에서 바로 재사용)
// - 2단계: Cloudflare 캐시(caches.default)에 보관(다른 서버에서도 재사용)
// - 저장본은 STALE_SECONDS(7일) 동안 남겨 둔다. CACHE_SECONDS(24시간 등)가 지나면 새로 받아 오고,
//   그때 공공데이터 서버가 고장이면(522 등) 지난 저장본을 대신 돌려준다 (2026-10-04 추가).
// - 응답 헤더 x-baram-cache 로 HIT-MEMORY / HIT-EDGE / MISS / STALE(지난 저장본) 을 알 수 있다.
// ------------------------------------------------------------------
const DAY = 24 * 60 * 60;
const CACHE_SECONDS = { nearby: DAY, festival: 6 * 60 * 60, pet: DAY, petNearby: DAY };
const STALE_SECONDS = 7 * DAY;
const MEMORY_CACHE_MAX = 300;
const memoryCache = new Map(); // key -> { savedAt, body }

function memoryGet(key) {
  const hit = memoryCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.savedAt > STALE_SECONDS * 1000) {
    memoryCache.delete(key);
    return null;
  }
  return hit;
}

function memorySet(key, body, savedAt) {
  if (memoryCache.size >= MEMORY_CACHE_MAX) memoryCache.delete(memoryCache.keys().next().value); // 가장 오래된 것부터 정리
  memoryCache.set(key, { savedAt, body });
}

// 저장해 둔 문자열을 찾는다. 결과: { body, savedAt, source } 또는 null
// (7일 안의 것이면 오래됐어도 돌려준다. 새것인지는 isFresh로 따로 본다)
async function cacheGet(key) {
  const fromMemory = memoryGet(key);
  if (fromMemory) return { ...fromMemory, source: "HIT-MEMORY" };
  try {
    const fromEdge = await caches.default.match(key);
    if (fromEdge) {
      const body = await fromEdge.text();
      // 저장 시각이 없는 옛 저장본은 오래된 것으로 본다 (새로 받아 보고, 실패하면 이걸 쓴다)
      const savedAt = Number(fromEdge.headers.get("x-baram-saved-at")) || 0;
      if (savedAt && Date.now() - savedAt > STALE_SECONDS * 1000) return null; // 7일이 지난 것은 쓰지 않는다
      memorySet(key, body, savedAt);
      return { body, savedAt, source: "HIT-EDGE" };
    }
  } catch {
    // Cloudflare 캐시를 쓸 수 없는 환경이면 메모리 캐시만 쓴다
  }
  return null;
}

function isFresh(hit, seconds) {
  return Date.now() - hit.savedAt < seconds * 1000;
}

async function cachePut(key, body) {
  const savedAt = Date.now();
  memorySet(key, body, savedAt);
  try {
    await caches.default.put(
      key,
      new Response(body, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": `public, max-age=${STALE_SECONDS}`,
          "x-baram-saved-at": String(savedAt),
        },
      })
    );
  } catch {
    // Cloudflare 캐시를 쓸 수 없는 환경이면 메모리 캐시만 쓴다
  }
}

// 캐시 키는 서비스키 없이, action과 조회 조건만으로 만든다 (좌표는 소수 넷째 자리로 맞춰 같은 지역끼리 묶음)
function cacheKeyFor(url) {
  const p = new URLSearchParams();
  [...url.searchParams.keys()].sort().forEach((k) => {
    if (k === "n" || k === "_") return; // 브라우저가 붙이는 무작위 값은 무시
    let v = url.searchParams.get(k);
    if ((k === "lat" || k === "lng") && !Number.isNaN(parseFloat(v))) v = parseFloat(v).toFixed(4);
    p.set(k, v);
  });
  return `https://baram-cache.internal/tourapi?${p.toString()}`;
}

// ------------------------------------------------------------------
// 공공데이터 서버 호출. 실패하면 화면에 보여줄 오류 정보(payload, status)를 담은 예외를 던진다.
// ------------------------------------------------------------------
class TourApiError extends Error {
  constructor(payload, status) {
    super(payload.message);
    this.payload = payload;
    this.status = status;
  }
}

async function callTourApi(path, params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${TOUR_API_BASE}/${path}?${qs}`);
  const bodyText = await res.text();

  if (!res.ok) {
    throw new TourApiError({ error: "UPSTREAM_ERROR", status: res.status, upstreamBody: bodyText.slice(0, 500), message: `TourAPI 응답 오류 (HTTP ${res.status})` }, 502);
  }

  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    // TourAPI가 200인데도 XML(에러 메시지)을 줄 때가 있다 - 예: 키 미등록/승인대기 등
    throw new TourApiError({ error: "UPSTREAM_NOT_JSON", upstreamBody: bodyText.slice(0, 500), message: "TourAPI가 JSON이 아닌 응답을 줬어요 (키 상태를 확인해주세요)." }, 502);
  }

  const resultCode = data?.response?.header?.resultCode;
  if (resultCode && resultCode !== "0000" && resultCode !== "00") {
    const resultMsg = data?.response?.header?.resultMsg || "알 수 없는 오류";
    throw new TourApiError({ error: "UPSTREAM_RESULT_ERROR", resultCode, message: `TourAPI 오류: ${resultMsg} (코드 ${resultCode})` }, 502);
  }

  const rawItems = data?.response?.body?.items?.item;
  const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];
  return { items, totalCount: Number(data?.response?.body?.totalCount) || items.length };
}

// ------------------------------------------------------------------
// 반려동물 동반 정보 색인
// 전국 목록(약 1만 곳)에는 장소 번호와 동반 조건만 있고 위치는 없다. 그래서 하루에 한 번 전체를 받아
// '장소 번호 → 동반 조건' 색인을 만들어 두고, 지역 주변 장소 목록과 맞춰 본다.
// 동반 조건 문구는 대부분 같아서 조건 묶음(conds)과 번호별 묶음 순번(byId)으로 작게 저장한다.
// ------------------------------------------------------------------
const PET_INDEX_KEY = "https://baram-cache.internal/pet-index-v1";
const PET_PAGE_SIZE = 1000;
// 주변에서 찾아볼 종류: 관광지, 문화시설, 레포츠, 숙박, 쇼핑, 음식점
const PET_CONTENT_TYPES = ["12", "14", "28", "32", "38", "39"];

function petCondition(it) {
  return {
    area: it.acmpyTypeCd || "", // 동반 구역 (예: 전구역 동반가능)
    animals: it.acmpyPsblCpam || "", // 동반 가능 동물 (예: 전 견종 동반 가능)
    need: it.acmpyNeedMtr || "", // 필요 사항 (예: 목줄 착용)
    etc: it.etcAcmpyInfo || "", // 기타 안내
  };
}

async function getPetIndex(base) {
  const cached = await cacheGet(PET_INDEX_KEY);
  if (cached && isFresh(cached, DAY)) return JSON.parse(cached.body);
  try {
    return await buildPetIndex(base);
  } catch (err) {
    // 공공데이터 서버가 고장이면 지난 색인(7일 안)을 그대로 쓴다
    if (cached) return JSON.parse(cached.body);
    throw err;
  }
}

async function buildPetIndex(base) {
  const first = await callTourApi("detailPetTour2", { ...base, numOfRows: String(PET_PAGE_SIZE), pageNo: "1" });
  const pages = Math.ceil(first.totalCount / PET_PAGE_SIZE);
  const rest = await Promise.all(
    Array.from({ length: Math.max(0, pages - 1) }, (_, i) =>
      callTourApi("detailPetTour2", { ...base, numOfRows: String(PET_PAGE_SIZE), pageNo: String(i + 2) })
    )
  );

  const conds = [];
  const condIndex = new Map();
  const byId = {};
  [first, ...rest].forEach(({ items }) => {
    items.forEach((it) => {
      const c = petCondition(it);
      const key = `${c.area}|${c.animals}|${c.need}|${c.etc}`;
      if (!condIndex.has(key)) {
        condIndex.set(key, conds.length);
        conds.push(c);
      }
      byId[String(it.contentid)] = condIndex.get(key);
    });
  });
  const index = { conds, byId, total: first.totalCount };
  await cachePut(PET_INDEX_KEY, JSON.stringify(index));
  return index;
}

async function petNearby(base, lat, lng) {
  const index = await getPetIndex(base);
  // 종류별로 주변 20km 안의 장소를 넉넉히 받아서, 반려동물 색인에 있는 곳만 남긴다
  let failed = 0;
  let lastError = null;
  const lists = await Promise.all(
    PET_CONTENT_TYPES.map((contentTypeId) =>
      callTourApi("locationBasedList2", {
        ...base, arrange: "E", mapX: lng, mapY: lat, radius: "20000", contentTypeId, numOfRows: "300", pageNo: "1",
      }).catch((err) => { // 한 종류가 실패해도 나머지는 보여준다
        failed += 1;
        lastError = err;
        return { items: [] };
      })
    )
  );
  // 전부 실패했으면 빈 목록이 아니라 오류로 (빈 목록을 저장해 버리면 하루 동안 '정보 없음'이 된다)
  if (failed === PET_CONTENT_TYPES.length) throw lastError;
  const items = [];
  lists.forEach(({ items: list }) => {
    list.forEach((it) => {
      const condIdx = index.byId[String(it.contentid)];
      if (condIdx === undefined) return;
      items.push({
        contentid: it.contentid,
        contenttypeid: it.contenttypeid,
        title: it.title,
        addr1: it.addr1,
        dist: it.dist,
        mapx: it.mapx,
        mapy: it.mapy,
        firstimage: it.firstimage,
        firstimage2: it.firstimage2,
        cat2: it.cat2,
        cat3: it.cat3,
        pet: index.conds[condIdx],
      });
    });
  });
  items.sort((a, b) => parseFloat(a.dist) - parseFloat(b.dist));
  // incomplete: 일부 종류를 못 받음 → 저장하지 않고, 지난 저장본이 있으면 그걸 쓴다
  return { items: items.slice(0, 80), petTotal: index.total, incomplete: failed > 0 };
}

// Cloudflare Pages Functions는 (context) => Response 형태의 onRequest 핸들러를 쓴다.
// context.env 로 환경변수에 접근한다 (Node의 process.env 대신).
export async function onRequest(context) {
  // 지난 저장본(새로 받을 때가 됐지만 7일 안의 것). 공공데이터 서버가 실패하면 이걸 돌려준다
  let stale = null;
  const staleResponse = () =>
    json(JSON.parse(stale.body), 200, { "x-baram-cache": "STALE", "x-baram-saved-at": new Date(stale.savedAt).toISOString() });
  try {
    const { request, env } = context;
    const url = new URL(request.url);
    const action = url.searchParams.get("action");
    const ttl = CACHE_SECONDS[action];

    // 저장해 둔 결과가 새것이면 공공데이터 서버에 묻지 않고 바로 돌려준다
    const cacheKey = ttl ? cacheKeyFor(url) : null;
    if (cacheKey) {
      const hit = await cacheGet(cacheKey);
      if (hit && isFresh(hit, ttl)) return json(JSON.parse(hit.body), 200, { "x-baram-cache": hit.source });
      stale = hit;
    }

    const rawServiceKey = env.TOUR_API_SERVICE_KEY;
    if (!rawServiceKey) {
      return json({ error: "SERVER_NO_KEY", message: "서버에 TOUR_API_SERVICE_KEY 환경변수가 설정되지 않았어요." }, 500);
    }
    const serviceKey = normalizeServiceKey(rawServiceKey);
    const base = { serviceKey, MobileOS: "ETC", MobileApp: "BARAM", _type: "json" };

    let payload;
    if (action === "nearby") {
      const lat = url.searchParams.get("lat");
      const lng = url.searchParams.get("lng");
      const contentTypeId = url.searchParams.get("contentTypeId");
      const radius = url.searchParams.get("radius") || "20000";
      const num = url.searchParams.get("num") || "5";
      if (!lat || !lng || !contentTypeId) return json({ error: "BAD_REQUEST", message: "lat/lng/contentTypeId가 필요해요." }, 400);
      const { items } = await callTourApi("locationBasedList2", { ...base, arrange: "E", mapX: lng, mapY: lat, radius, contentTypeId, numOfRows: num, pageNo: "1" });
      payload = { items };
    } else if (action === "festival") {
      const eventStartDate = url.searchParams.get("eventStartDate");
      const numOfRows = url.searchParams.get("numOfRows") || "30";
      if (!eventStartDate) return json({ error: "BAD_REQUEST", message: "eventStartDate가 필요해요." }, 400);
      const { items } = await callTourApi("searchFestival2", { ...base, arrange: "A", numOfRows, pageNo: "1", eventStartDate });
      payload = { items };
    } else if (action === "pet") {
      // 반려동물 동반 여행 정보 원본. contentId가 있으면 그 장소만, 없으면 목록을 받는다
      const contentId = url.searchParams.get("contentId");
      const numOfRows = url.searchParams.get("numOfRows") || "100";
      const pageNo = url.searchParams.get("pageNo") || "1";
      payload = await callTourApi("detailPetTour2", { ...base, numOfRows, pageNo, ...(contentId ? { contentId } : {}) });
    } else if (action === "petNearby") {
      const lat = url.searchParams.get("lat");
      const lng = url.searchParams.get("lng");
      if (!lat || !lng) return json({ error: "BAD_REQUEST", message: "lat/lng가 필요해요." }, 400);
      payload = await petNearby(base, lat, lng);
    } else {
      return json({ error: "INVALID_ACTION", message: "action은 nearby, festival, pet, petNearby 중 하나여야 해요." }, 400);
    }

    // 일부만 받은 결과는 저장하지 않는다. 지난 저장본이 있으면 그쪽이 더 완전하다
    if (payload.incomplete) {
      if (stale) return staleResponse();
      delete payload.incomplete;
      return json(payload, 200, { "x-baram-cache": "MISS-PARTIAL" });
    }
    delete payload.incomplete;

    // 성공한 결과만 저장한다
    if (cacheKey) await cachePut(cacheKey, JSON.stringify(payload));
    return json(payload, 200, { "x-baram-cache": "MISS" });
  } catch (err) {
    // 공공데이터 서버가 고장이면(522 등) 지난 저장본이라도 돌려준다
    if (stale) return staleResponse();
    if (err instanceof TourApiError) return json(err.payload, err.status);
    return json({ error: "SERVER_ERROR", message: String((err && err.message) || err) }, 500);
  }
}
