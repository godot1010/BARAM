// Cloudflare Pages Function: TourAPI(공공데이터포털) 프록시
// - 진짜 서비스키는 여기(서버)에만 있고, 브라우저에는 절대 노출되지 않는다.
// - 키는 Cloudflare Pages 프로젝트 설정 > Settings > Environment variables 에
//   TOUR_API_SERVICE_KEY 로 등록해야 한다. (Production/Preview 둘 다 등록 권장)
//   ("인증키(Decoding)" 원본 값을 그대로 넣으면 된다. 이미 URL 인코딩된 "Encoding" 키를
//    넣었어도 아래 normalizeServiceKey()가 자동으로 복원해서 처리한다.)
// - 파일 경로 functions/api/tourapi.js 는 Cloudflare Pages의 파일 기반 라우팅 규칙에 따라
//   자동으로 /api/tourapi 경로에 매핑된다 (별도 리다이렉트 설정 불필요).

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
// - 2단계: Cloudflare 캐시(caches.default)에 보관(다른 서버에서도 재사용, 지원되는 환경에서만)
// - 응답 헤더 x-baram-cache 로 HIT-MEMORY / HIT-EDGE / MISS 를 알 수 있다.
// ------------------------------------------------------------------
const CACHE_SECONDS = { nearby: 24 * 60 * 60, festival: 6 * 60 * 60, pet: 24 * 60 * 60 };
const MEMORY_CACHE_MAX = 300;
const memoryCache = new Map(); // key -> { expires, body }

function memoryGet(key) {
  const hit = memoryCache.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    memoryCache.delete(key);
    return null;
  }
  return hit.body;
}

function memorySet(key, body, seconds) {
  if (memoryCache.size >= MEMORY_CACHE_MAX) memoryCache.delete(memoryCache.keys().next().value); // 가장 오래된 것부터 정리
  memoryCache.set(key, { expires: Date.now() + seconds * 1000, body });
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

// Cloudflare Pages Functions는 (context) => Response 형태의 onRequest 핸들러를 쓴다.
// context.env 로 환경변수에 접근한다 (Node의 process.env 대신).
export async function onRequest(context) {
  try {
    const { request, env } = context;
    const url = new URL(request.url);
    const action = url.searchParams.get("action");
    const ttl = CACHE_SECONDS[action];

    // 저장해 둔 결과가 있으면 공공데이터 서버에 묻지 않고 바로 돌려준다
    const cacheKey = ttl ? cacheKeyFor(url) : null;
    if (cacheKey) {
      const fromMemory = memoryGet(cacheKey);
      if (fromMemory) return json(JSON.parse(fromMemory), 200, { "x-baram-cache": "HIT-MEMORY" });
      try {
        const fromEdge = await caches.default.match(cacheKey);
        if (fromEdge) {
          const body = await fromEdge.text();
          memorySet(cacheKey, body, ttl);
          return json(JSON.parse(body), 200, { "x-baram-cache": "HIT-EDGE" });
        }
      } catch {
        // Cloudflare 캐시를 쓸 수 없는 환경이면 메모리 캐시만 쓴다
      }
    }

    const rawServiceKey = env.TOUR_API_SERVICE_KEY;

    if (!rawServiceKey) {
      return json({ error: "SERVER_NO_KEY", message: "서버에 TOUR_API_SERVICE_KEY 환경변수가 설정되지 않았어요." }, 500);
    }
    const serviceKey = normalizeServiceKey(rawServiceKey);
    const base = { serviceKey, MobileOS: "ETC", MobileApp: "BARAM", _type: "json" };

    let path, params;

    if (action === "nearby") {
      const lat = url.searchParams.get("lat");
      const lng = url.searchParams.get("lng");
      const contentTypeId = url.searchParams.get("contentTypeId");
      const radius = url.searchParams.get("radius") || "20000";
      const num = url.searchParams.get("num") || "5";
      if (!lat || !lng || !contentTypeId) return json({ error: "BAD_REQUEST", message: "lat/lng/contentTypeId가 필요해요." }, 400);
      path = "locationBasedList2";
      params = { ...base, arrange: "E", mapX: lng, mapY: lat, radius, contentTypeId, numOfRows: num, pageNo: "1" };
    } else if (action === "festival") {
      const eventStartDate = url.searchParams.get("eventStartDate");
      const numOfRows = url.searchParams.get("numOfRows") || "30";
      if (!eventStartDate) return json({ error: "BAD_REQUEST", message: "eventStartDate가 필요해요." }, 400);
      path = "searchFestival2";
      params = { ...base, arrange: "A", numOfRows, pageNo: "1", eventStartDate };
    } else if (action === "pet") {
      // 반려동물 동반 여행 정보. contentId가 있으면 그 장소만, 없으면 목록(지원되는 경우)을 받는다
      const contentId = url.searchParams.get("contentId");
      const numOfRows = url.searchParams.get("numOfRows") || "100";
      const pageNo = url.searchParams.get("pageNo") || "1";
      path = "detailPetTour2";
      params = { ...base, numOfRows, pageNo, ...(contentId ? { contentId } : {}) };
    } else {
      return json({ error: "INVALID_ACTION", message: "action은 nearby, festival, pet 중 하나여야 해요." }, 400);
    }

    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${TOUR_API_BASE}/${path}?${qs}`);
    const bodyText = await res.text();

    if (!res.ok) {
      return json({ error: "UPSTREAM_ERROR", status: res.status, upstreamBody: bodyText.slice(0, 500), message: `TourAPI 응답 오류 (HTTP ${res.status})` }, 502);
    }

    let data;
    try {
      data = JSON.parse(bodyText);
    } catch {
      // TourAPI가 200인데도 XML(에러 메시지)을 줄 때가 있다 - 예: 키 미등록/승인대기 등
      return json({ error: "UPSTREAM_NOT_JSON", upstreamBody: bodyText.slice(0, 500), message: "TourAPI가 JSON이 아닌 응답을 줬어요 (키 상태를 확인해주세요)." }, 502);
    }

    const resultCode = data?.response?.header?.resultCode;
    if (resultCode && resultCode !== "0000" && resultCode !== "00") {
      const resultMsg = data?.response?.header?.resultMsg || "알 수 없는 오류";
      return json({ error: "UPSTREAM_RESULT_ERROR", resultCode, message: `TourAPI 오류: ${resultMsg} (코드 ${resultCode})` }, 502);
    }

    const rawItems = data?.response?.body?.items?.item;
    const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];
    const totalCount = data?.response?.body?.totalCount;
    const payload = action === "pet" ? { items, totalCount } : { items };

    // 성공한 결과만 저장한다
    if (cacheKey) {
      const body = JSON.stringify(payload);
      memorySet(cacheKey, body, ttl);
      try {
        await caches.default.put(
          cacheKey,
          new Response(body, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": `public, max-age=${ttl}` } })
        );
      } catch {
        // Cloudflare 캐시를 쓸 수 없는 환경이면 메모리 캐시만 쓴다
      }
    }
    return json(payload, 200, { "x-baram-cache": "MISS" });
  } catch (err) {
    return json({ error: "SERVER_ERROR", message: String((err && err.message) || err) }, 500);
  }
}
