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
// - detail    : 장소 하나의 자세한 정보 (소개글·전화·홈페이지 + 이용 시간 등 + 사진 여러 장)
// - barrierFree       : 위치 주변의 무장애 여행 장소 목록 (무장애 여행 정보 KorWithService2 locationBasedList2)
// - barrierFreeDetail : 장소 하나의 무장애 편의 정보 (detailWithTour2, 휠체어·화장실·유모차 등 - 비어 있지 않은 칸만)
// - camping           : 위치 주변 캠핑장 목록 (고캠핑 GoCamping locationBasedList)
// - mountains         : 100대 명산 전체 (위치·높이 = 한국등산트레킹지원센터 + 소개·선정 이유·교통 = 산림청 명산등산로, 산 코드로 합침)
// - localMountains    : 한 지역(시·군·구)의 산 목록 (산림청 산정보 전국 4,705곳, 좌표는 없어 소재지 주소로 고른다)
// - mountainPhotos    : 산 하나의 사진 (관광공사 관광지 사진 중 이름이 같은 곳 먼저 + 산림청 산 사진)
// - trails            : 한 지역의 걷기길 (코리아둘레길 두루누비 284코스 + 전국길관광정보 표준데이터 지자체 걷기길)
// - trailCourses      : 코리아둘레길 전체 코스 목록 (STAMP TOUR 걷기길 도장깨기용, 짧은 칸만)
// - walkPhoto         : 걷기길 사진 여러 장 (관광사진 포토코리아에서 코스·길 이름 → 지나는 장소, 없으면 관광지 사진. 모두 같은 시·군 안에서)

const TOUR_API_BASE = "https://apis.data.go.kr/B551011/KorService2";
// 무장애 여행 정보는 같은 공공데이터 키로 쓰는 다른 서비스다 (공공데이터포털에서 따로 활용신청해야 함)
const WITH_API_BASE = "https://apis.data.go.kr/B551011/KorWithService2";
// 고캠핑(전국 야영장)도 같은 키로 쓰는 다른 서비스 (2026-11-04 형이 활용신청·승인)
const CAMPING_API_BASE = "https://apis.data.go.kr/B551011/GoCamping";
// 100대 명산 (2026-11-04 형이 둘 다 활용신청·승인). 산림청 쪽은 XML만 준다
const MOUNTAIN_LIST_URL = "https://apis.data.go.kr/B553662/top100FamtListBasiInfoService/getTop100FamtListBasiInfoList";
const MOUNTAIN_INFO_URL = "https://apis.data.go.kr/1400000/cultureInfoService/gdTrailInfoOpenAPI";
// 산림청 산정보 (전국 산, 2026-11-04 형이 활용신청·승인). XML만, 좌표 없음
const LOCAL_MOUNTAIN_URL = "https://apis.data.go.kr/1400000/service/cultureInfoService2/mntInfoOpenAPI2";
const LOCAL_MOUNTAIN_INDEX_KEY = "https://baram-cache.internal/local-mountains-v1";

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
const CACHE_SECONDS = { nearby: DAY, festival: 6 * 60 * 60, pet: DAY, petNearby: DAY, detail: 7 * DAY, barrierFree: DAY, barrierFreeDetail: 7 * DAY, camping: DAY, mountains: 7 * DAY, localMountains: 7 * DAY, mountainPhotos: 7 * DAY, trails: 7 * DAY, walkPhoto: 7 * DAY, trailCourses: 7 * DAY, fishing: 3 * 60 * 60, seaside: 3 * 60 * 60 };
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

async function callTourApi(path, params, apiBase = TOUR_API_BASE) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${apiBase}/${path}?${qs}`);
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

// ------------------------------------------------------------------
// 장소 자세한 정보: 공통정보(소개글 등) + 소개정보(이용 시간·쉬는 날 등, 종류마다 항목이 다름) + 사진 목록
// 공통정보는 꼭 필요하고, 나머지 둘은 실패해도 공통정보만으로 보여준다(그때는 저장하지 않음).
// ------------------------------------------------------------------
const MAX_DETAIL_IMAGES = 10;

async function placeDetail(base, contentId, contentTypeId) {
  const [common, intro, images] = await Promise.all([
    callTourApi("detailCommon2", { ...base, contentId }),
    contentTypeId ? callTourApi("detailIntro2", { ...base, contentId, contentTypeId }).catch(() => null) : Promise.resolve({ items: [] }),
    callTourApi("detailImage2", { ...base, contentId, imageYN: "Y" }).catch(() => null),
  ]);
  const c = common.items[0];
  if (!c) throw new TourApiError({ error: "NOT_FOUND", message: "이 장소의 자세한 정보가 없어요." }, 404);
  // 소개정보는 비어 있지 않은 칸만 남긴다 (앱이 종류별로 이름을 붙여 보여준다)
  const introRaw = (intro && intro.items[0]) || {};
  const introFields = {};
  Object.entries(introRaw).forEach(([k, v]) => {
    if (k === "contentid" || k === "contenttypeid") return;
    if (typeof v === "string" && v.trim() && v.trim() !== "0") introFields[k] = v.trim();
  });
  return {
    items: [{
      contentid: c.contentid,
      contenttypeid: c.contenttypeid,
      title: c.title,
      addr1: c.addr1,
      tel: c.tel,
      homepage: c.homepage,
      overview: c.overview,
      firstimage: c.firstimage,
      intro: introFields,
      images: ((images && images.items) || []).slice(0, MAX_DETAIL_IMAGES).map((im) => ({ url: im.originimgurl, small: im.smallimageurl })),
    }],
    incomplete: !intro || !images,
  };
}

// Cloudflare Pages Functions는 (context) => Response 형태의 onRequest 핸들러를 쓴다.
// context.env 로 환경변수에 접근한다 (Node의 process.env 대신).
// XML의 <item> 안 칸들을 { 칸이름: 값 } 으로 (산림청 명산등산로는 JSON을 주지 않는다)
function xmlItems(text) {
  const decode = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").trim();
  return [...text.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
    const it = {};
    for (const f of m[1].matchAll(/<(\w+)>([\s\S]*?)<\/\1>/g)) it[f[1]] = decode(f[2]);
    return it;
  });
}

async function fetchText(url) {
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new TourApiError({ error: "UPSTREAM_ERROR", status: res.status, upstreamBody: text.slice(0, 300), message: `명산 정보 응답 오류 (HTTP ${res.status})` }, 502);
  return text;
}

async function mountains(serviceKey) {
  const listText = await fetchText(`${MOUNTAIN_LIST_URL}?${new URLSearchParams({ serviceKey, pageNo: "1", numOfRows: "200", type: "json" })}`);
  let list;
  try {
    const raw = JSON.parse(listText)?.response?.body?.items?.item;
    list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  } catch {
    // JSON이 아니면 XML로 읽어 본다
    list = xmlItems(listText);
  }
  if (list.length === 0) throw new TourApiError({ error: "UPSTREAM_EMPTY", upstreamBody: listText.slice(0, 300), message: "100대 명산 목록을 받지 못했어요." }, 502);
  // 소개 자료는 없어도 위치·높이만으로 보여줄 수 있게, 실패해도 목록은 돌려준다
  let infos = [];
  try {
    infos = xmlItems(await fetchText(`${MOUNTAIN_INFO_URL}?${new URLSearchParams({ serviceKey, pageNo: "1", numOfRows: "200" })}`));
  } catch {}
  const infoByCode = new Map(infos.map((it) => [String(it.mntncd), it]));
  const infoByName = new Map(infos.map((it) => [it.mntnm, it]));
  return {
    infoCount: infos.length,
    items: list.map((m) => {
      // 산 코드가 겹치는 산이 있어서(남산·내연산, 미륵산·민주지산, 월출산·유명산) 이름으로 먼저 맞춘다
      const info = infoByName.get(m.frtrlNm) || infoByCode.get(String(m.mtnCd)) || {};
      return {
        id: m.frtrlId || m.mtnCd, code: m.mtnCd, name: m.frtrlNm, sido: m.ctpvNm, addr: m.addrNm,
        lat: m.lat, lng: m.lot, height: m.aslAltide,
        sub: info.subnm || "", area: info.areanm || "", reason: info.aeatreason || "", overview: info.overview || "",
        details: info.details || "", transport: info.transport || "", course: info.etccourse || "",
      };
    }),
  };
}

// 산 사진: 관광공사 관광지 중 이름이 같은 곳(큰 사진)을 먼저, 그다음 산림청 산 사진(작고 오래된 사진)
// 산림청 사진은 파일 이름만 주므로 산림청 누리집 주소를 붙인다. 산 코드가 겹치는 산이 있어 사진 이름(imgname)도 맞춰 본다
const FOREST_IMAGE_BASE = "https://www.forest.go.kr/images/data/down/mountain/";
const plainName = (s) => (s || "").replace(/\(.*?\)/g, "").replace(/\s/g, "");
function kmBetween(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lng2 - lng1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}
// area = 동네 산의 시·군·구 이름(좌표가 없어 주소로 같은 산인지 본다). 이름이 같은 산이 전국에 많다(남산 등)
async function mountainPhotos(base, serviceKey, no, name, lat, lng, area) {
  const photos = [];
  const key = plainName(name);
  try {
    const { items } = await callTourApi("searchKeyword2", { ...base, keyword: key, contentTypeId: "12", numOfRows: "30", pageNo: "1", arrange: "O" });
    items.forEach((it) => {
      const t = plainName(it.title);
      const same = t === key || new RegExp(`^${key}(국립공원|도립공원|군립공원)`).test(t);
      if (!same || !it.firstimage) return;
      const near = lat && lng
        ? kmBetween(parseFloat(lat), parseFloat(lng), parseFloat(it.mapy), parseFloat(it.mapx)) <= 30
        : !!area && (it.addr1 || "").includes(area);
      if (near) photos.push({ url: it.firstimage, thumb: it.firstimage2 || it.firstimage, big: true });
    });
  } catch {}
  try {
    const text = await fetchText(`https://apis.data.go.kr/1400000/service/cultureInfoService2/mntInfoImgOpenAPI2?${new URLSearchParams({ ServiceKey: serviceKey, mntiListNo: no, pageNo: "1", numOfRows: "10" })}`);
    xmlItems(text)
      .filter((it) => it.imgfilename && plainName(it.imgname) === key)
      .sort((a, b) => Number(a.imgno) - Number(b.imgno))
      .forEach((it) => photos.push({ url: FOREST_IMAGE_BASE + it.imgfilename, thumb: FOREST_IMAGE_BASE + it.imgfilename, big: false }));
  } catch {}
  return { items: photos.slice(0, 8) };
}

// 시·도 이름을 하나로 맞춘다 ("경상남도"·"경남"·"경상남" → 경남, "광주광역시"·"광주" → 광주)
const SIDO_KEYS = [["서울", "서울"], ["부산", "부산"], ["대구", "대구"], ["인천", "인천"], ["광주", "광주"], ["대전", "대전"], ["울산", "울산"], ["세종", "세종"],
  ["경기", "경기"], ["강원", "강원"], ["충청북", "충북"], ["충북", "충북"], ["충청남", "충남"], ["충남", "충남"], ["전라북", "전북"], ["전북", "전북"],
  ["전라남", "전남"], ["전남", "전남"], ["경상북", "경북"], ["경북", "경북"], ["경상남", "경남"], ["경남", "경남"], ["제주", "제주"]];
function sidoKey(s) {
  const hit = SIDO_KEYS.find(([p]) => (s || "").startsWith(p));
  return hit ? hit[1] : "";
}
// 주소 앞부분이 그 지역인지: sido(앞글자)·sgg(시·군·구)
function addrInArea(addr, sido, sgg) {
  const parts = (addr || "").trim().split(/\s+/);
  if (sido && sidoKey(parts[0]) !== sidoKey(sido)) return false;
  return !sgg || parts.slice(1, 3).includes(sgg);
}

// 걷기길 전체 목록(두루누비 284 + 표준데이터 약 1,350)을 한 주에 한 번 받아 저장해 두고 지역마다 골라 준다
const TRAIL_INDEX_KEY = "https://baram-cache.internal/trails-v2";
async function getTrailIndex(base, serviceKey) {
  const hit = await cacheGet(TRAIL_INDEX_KEY);
  if (hit && isFresh(hit, 7 * DAY)) return JSON.parse(hit.body);
  try {
    const { items: courses } = await callTourApi("courseList", { ...base, numOfRows: "400", pageNo: "1", brdDiv: "DNWW" }, "https://apis.data.go.kr/B551011/Durunubi");
    const durunubi = courses.map((c) => ({
      src: "duru", id: c.crsIdx, name: c.crsKorNm, area: c.sigun, km: c.crsDstnc, minutes: c.crsTotlRqrmHour, level: c.crsLevel,
      cycle: c.crsCycle, summary: c.crsSummary, contents: c.crsContents, tour: c.crsTourInfo, traveler: c.travelerinfo,
    }));
    const local = [];
    for (let pageNo = 1; pageNo <= 5; pageNo++) {
      const text = await fetchText(`https://api.data.go.kr/openapi/tn_pubr_public_stret_tursm_info_api?${new URLSearchParams({ serviceKey, pageNo: String(pageNo), numOfRows: "1000", type: "json" })}`);
      const body = JSON.parse(text)?.response?.body || JSON.parse(text)?.body || {};
      const raw = body?.items?.item || body?.items || [];
      const items = Array.isArray(raw) ? raw : [raw];
      items.forEach((t, i) => {
        if (!t || !t.stretNm || /자전거/.test(t.stretNm)) return; // 자전거길은 뺀다
        local.push({
          // 식별자는 기관 코드 + 길 이름 (걷기길 도장이 이 값으로 저장되므로 자료 순서가 바뀌어도 같게)
          src: "local", id: `${t.insttCode || t.insttNm || ""}-${t.stretNm}`, name: t.stretNm, intro: t.stretIntrcn, km: t.stretLt, time: t.reqreTime,
          begin: t.beginSpotNm, beginAddr: t.beginRdnmadr || t.beginLnmadr, end: t.endSpotNm, endAddr: t.endRdnmadr || t.endLnmadr,
          course: t.coursInfo, tel: t.phoneNumber, org: t.institutionNm, inst: t.insttNm,
        });
      });
      if (items.length < 1000 || local.length >= (Number(body.totalCount) || 0)) break;
    }
    const all = { durunubi, local };
    await cachePut(TRAIL_INDEX_KEY, JSON.stringify(all));
    return all;
  } catch (err) {
    if (hit) return JSON.parse(hit.body);
    throw err;
  }
}

// 관광사진(포토코리아, 2026-11-05 형이 활용신청·승인, 개발계정 하루 1,000건). 같은 검색어는 7일 동안 다시 묻지 않는다
const GALLERY_API_BASE = "https://apis.data.go.kr/B551011/PhotoGalleryService1";
async function gallerySearch(base, keyword) {
  const key = `https://baram-cache.internal/gallery-v1?k=${encodeURIComponent(keyword)}`;
  const hit = await cacheGet(key);
  if (hit && isFresh(hit, 7 * DAY)) return JSON.parse(hit.body);
  try {
    const { items } = await callTourApi("gallerySearchList1", { ...base, keyword, numOfRows: "40", pageNo: "1", arrange: "A" }, GALLERY_API_BASE);
    const slim = items.map((g) => ({ title: g.galTitle, url: g.galWebImageUrl, loc: g.galPhotographyLocation, by: g.galPhotographer, kw: g.galSearchKeyword }));
    await cachePut(key, JSON.stringify(slim));
    return slim;
  } catch (err) {
    if (hit) return JSON.parse(hit.body);
    return [];
  }
}
async function walkPhotos(base, { title, base: trailName, names, area }) {
  const photos = [];
  const seen = new Set();
  const add = (url, thumb, credit, place, max) => {
    if (!url || seen.has(url) || photos.length >= max) return;
    seen.add(url);
    photos.push({ url, thumb: thumb || url, credit, place });
  };
  const inArea = (g) => (g.loc || "").includes(area) || (g.kw || "").includes(area);
  const credit = (g) => `한국관광공사 포토코리아${g.by ? ` (${g.by.replace(/^한국관광공사\s*/, "")})` : ""}`;
  // 순서: 1) 코스 사진(예: 해파랑길11코스) 2) 지나는 장소의 포토코리아 사진 3) 지나는 장소의 관광지 사진 4) 길 이름 사진(예: 강릉바우길)
  // 길 이름 사진은 여러 구간이 같은 사진이 되므로 맨 뒤 (2026-11-05)
  if (title) (await gallerySearch(base, title)).filter((g) => plainName(g.title) === plainName(title)).forEach((g) => add(g.url, null, credit(g), g.title, 4));
  for (const name of names.slice(0, 2)) {
    if (photos.length >= 4) break;
    (await gallerySearch(base, name)).filter((g) => inArea(g) && plainName(g.title).includes(plainName(name))).slice(0, 2).forEach((g) => add(g.url, null, credit(g), g.title, 6));
  }
  for (const name of names) {
    if (photos.length >= 4) break;
    const key = plainName(name);
    try {
      const { items } = await callTourApi("searchKeyword2", { ...base, keyword: key, numOfRows: "20", pageNo: "1", arrange: "O" });
      items.filter((it) => {
        const t = plainName(it.title);
        return it.firstimage && (it.addr1 || "").includes(area) && (t.includes(key) || (t.length >= 3 && key.includes(t)));
      }).slice(0, 1).forEach((it) => add(it.firstimage, it.firstimage2, "한국관광공사", it.title, 6));
    } catch {}
  }
  // 길 이름 사진: 제목이나 검색 키워드에 길 이름이 있는 것 (예: 제주시의 '올레길' 키워드 사진)
  if (trailName && trailName.length >= 2) (await gallerySearch(base, trailName)).filter((g) => inArea(g) && (plainName(g.title).includes(plainName(trailName)) || plainName(g.kw).includes(plainName(trailName)))).forEach((g) => add(g.url, null, credit(g), g.title, 6));
  return { items: photos };
}

// ------------------------------------------------------------------
// 🎣 낚시 · 🌊 바다 (2026-11-05 형 결정, 국립해양조사원 지수 3개 활용신청·승인)
// 전국 예보(바다낚시 49곳, 서핑 18곳, 해수욕 49곳 × 7일 × 오전/오후)를 3시간에 한 번 통째로 받아
// 장소별로 묶어 저장해 두고, 여행지 주변 것만 골라 준다. 응답 모양: { header, body: { items: { item } } }
// ------------------------------------------------------------------
const KHOA_BASE = "https://apis.data.go.kr/1192136";
const SEA_FORECASTS = {
  fish: { path: "fcstFishingv2/GetFcstFishingApiServicev2", extra: { gubun: "갯바위" }, name: "seafsPstnNm" }, // gubun을 바꿔도 같은 자료가 와서 하나만
  surf: { path: "fcstSurfingv2/GetFcstSurfingApiServicev2", extra: {}, name: "surfPlcNm" },
  beach: { path: "fcstBeachv2/GetFcstBeachApiServicev2", extra: {}, name: "bbchNm" },
};
async function fetchKhoaPage(serviceKey, kind, pageNo) {
  const f = SEA_FORECASTS[kind];
  const res = await fetch(`${KHOA_BASE}/${f.path}?${new URLSearchParams({ serviceKey, type: "json", pageNo: String(pageNo), numOfRows: "300", ...f.extra })}`);
  const text = await res.text();
  if (!res.ok) throw new TourApiError({ error: "UPSTREAM_ERROR", status: res.status, upstreamBody: text.slice(0, 300), message: `바다 예보 응답 오류 (HTTP ${res.status})` }, 502);
  let data;
  try { data = JSON.parse(text); } catch { throw new TourApiError({ error: "UPSTREAM_NOT_JSON", upstreamBody: text.slice(0, 300), message: "바다 예보가 JSON이 아니에요." }, 502); }
  const code = data?.header?.resultCode;
  if (code === "03") return { items: [], total: 0 }; // 자료 없음
  if (code && code !== "00") throw new TourApiError({ error: "UPSTREAM_RESULT_ERROR", resultCode: code, message: `바다 예보 오류: ${data?.header?.resultMsg || ""}` }, 502);
  const raw = data?.body?.items?.item;
  return { items: Array.isArray(raw) ? raw : raw ? [raw] : [], total: Number(data?.body?.totalCount) || 0 };
}
const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
async function getSeaForecast(serviceKey, kind) {
  const key = `https://baram-cache.internal/sea-${kind}-v1`;
  const hit = await cacheGet(key);
  if (hit && isFresh(hit, 3 * 60 * 60)) return JSON.parse(hit.body);
  try {
    const rows = [];
    for (let pageNo = 1; pageNo <= 15; pageNo++) {
      const { items, total } = await fetchKhoaPage(serviceKey, kind, pageNo);
      rows.push(...items);
      if (items.length === 0 || rows.length >= total) break;
    }
    // 장소 → 날짜·오전/오후별 한 칸
    const places = new Map();
    rows.forEach((r) => {
      const name = r[SEA_FORECASTS[kind].name];
      if (!name || !r.lat || !r.lot) return;
      if (!places.has(name)) places.set(name, { name, lat: Number(r.lat), lng: Number(r.lot), fc: new Map() });
      const fcKey = `${r.predcYmd} ${r.predcNoonSeCd}`;
      const fc = places.get(name).fc;
      if (kind === "fish") {
        if (!fc.has(fcKey)) fc.set(fcKey, { d: r.predcYmd, t: r.predcNoonSeCd, tide: r.tdlvHrCn || "", wv: [num(r.minWvhgt), num(r.maxWvhgt)], wt: [num(r.minWtem), num(r.maxWtem)], ws: [num(r.minWspd), num(r.maxWspd)], fish: [] });
        fc.get(fcKey).fish.push([r.seafsTgfshNm, r.totalIndex || ""]);
      } else if (kind === "surf") {
        if (!fc.has(fcKey)) fc.set(fcKey, { d: r.predcYmd, t: r.predcNoonSeCd, wv: num(r.avgWvhgt), wp: num(r.avgWvpd), ws: num(r.avgWspd), wt: num(r.avgWtem), grade: {} });
        fc.get(fcKey).grade[r.grdCn || ""] = r.totalIndex || "";
      } else {
        fc.set(fcKey, { d: r.predcYmd, t: r.predcNoonSeCd, wv: num(r.maxWvhgt), wt: num(r.avgWtem), at: num(r.avgArtmp), ws: num(r.maxWspd), open: r.opnStat || "", idx: r.totalIndex || "" });
      }
    });
    const list = [...places.values()].map((pl) => ({ ...pl, fc: [...pl.fc.values()].sort((a, c) => (a.d + (a.t === "오전" ? 0 : 1)).localeCompare(c.d + (c.t === "오전" ? 0 : 1))) }));
    if (list.length === 0 && hit) return JSON.parse(hit.body);
    await cachePut(key, JSON.stringify(list));
    return list;
  } catch (err) {
    if (hit) return JSON.parse(hit.body);
    throw err;
  }
}
// 여행지 주변 예보 장소 (가까운 순)
async function seaForecastNear(serviceKey, kind, lat, lng, km) {
  try {
    const list = await getSeaForecast(serviceKey, kind);
    return list.map((pl) => ({ ...pl, km: kmBetween(lat, lng, pl.lat, pl.lng) })).filter((pl) => pl.km <= km).sort((a, c) => a.km - c.km);
  } catch {
    return []; // 예보가 안 와도 관광정보 장소는 보여준다
  }
}
// 관광정보 새 분류(lclsSystm)로 주변 장소 찾기. 예: LS020500 민물낚시, LS020600 바다낚시, LS020100 윈드서핑, NA020900 해변·해수욕장
// 위치 기반 목록(locationBasedList2)에 분류를 붙이면 0곳이 오고, 분류 없이 받으면 해수욕장이 빠진다(2026-11-05 강릉으로 확인).
// 그래서 분류별 전국 목록(해수욕장 약 410곳, 낚시터 약 215곳)을 한 주에 한 번 받아 두고 거리로 고른다
async function getClassIndex(base, code) {
  const key = `https://baram-cache.internal/class-${code}-v1`;
  const hit = await cacheGet(key);
  if (hit && isFresh(hit, 7 * DAY)) return JSON.parse(hit.body);
  try {
    const all = [];
    for (let pageNo = 1; pageNo <= 5; pageNo++) {
      const { items, totalCount } = await callTourApi("areaBasedList2", {
        ...base, numOfRows: "1000", pageNo: String(pageNo), arrange: "A",
        lclsSystm1: code.slice(0, 2), lclsSystm2: code.slice(0, 4), lclsSystm3: code,
      });
      items.forEach((it) => all.push({
        contentid: it.contentid, contenttypeid: it.contenttypeid, title: it.title, addr1: it.addr1, mapx: it.mapx, mapy: it.mapy,
        firstimage: it.firstimage, firstimage2: it.firstimage2, cls: code,
      }));
      if (items.length === 0 || all.length >= totalCount) break;
    }
    if (all.length === 0 && hit) return JSON.parse(hit.body);
    await cachePut(key, JSON.stringify(all));
    return all;
  } catch (err) {
    if (hit) return JSON.parse(hit.body);
    return [];
  }
}
async function tourNearByClass(base, lat, lng, code, km = 20) {
  const list = await getClassIndex(base, code);
  return list
    .map((it) => ({ ...it, km: kmBetween(lat, lng, Number(it.mapy), Number(it.mapx)) }))
    .filter((it) => it.km <= km)
    .sort((a, c) => a.km - c.km)
    .slice(0, 60)
    .map(({ km: d, ...it }) => ({ ...it, dist: String(Math.round(d * 1000)) }));
}

// 전국 산 목록(4,705곳)을 한 주에 한 번 통째로 받아 저장해 두고, 지역마다 골라 준다
async function getLocalMountainIndex(serviceKey) {
  const hit = await cacheGet(LOCAL_MOUNTAIN_INDEX_KEY);
  if (hit && isFresh(hit, 7 * DAY)) return JSON.parse(hit.body);
  try {
    const all = [];
    for (let pageNo = 1; pageNo <= 10; pageNo++) {
      const text = await fetchText(`${LOCAL_MOUNTAIN_URL}?${new URLSearchParams({ ServiceKey: serviceKey, pageNo: String(pageNo), numOfRows: "1000" })}`);
      const items = xmlItems(text);
      items.forEach((it) => all.push({
        id: it.mntilistno, name: it.mntiname, addr: it.mntiadd, height: it.mntihigh,
        details: (it.mntidetails || "").replace(/&#xD;/g, "").trim(), admin: it.mntiadmin, tel: it.mntiadminnum,
      }));
      const total = Number((text.match(/<totalCount>(\d+)<\/totalCount>/) || [])[1]) || 0;
      if (items.length === 0 || all.length >= total) break;
    }
    if (all.length === 0) throw new Error("산정보 목록이 비어 있어요.");
    await cachePut(LOCAL_MOUNTAIN_INDEX_KEY, JSON.stringify(all));
    return all;
  } catch (err) {
    if (hit) return JSON.parse(hit.body); // 새로 받기 실패하면 지난 목록이라도
    throw err;
  }
}

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
    } else if (action === "detail") {
      const contentId = url.searchParams.get("contentId");
      const contentTypeId = url.searchParams.get("contentTypeId") || "";
      if (!contentId || !/^\d+$/.test(contentId)) return json({ error: "BAD_REQUEST", message: "contentId가 필요해요." }, 400);
      payload = await placeDetail(base, contentId, /^\d+$/.test(contentTypeId) ? contentTypeId : "");
    } else if (action === "barrierFree") {
      const lat = url.searchParams.get("lat");
      const lng = url.searchParams.get("lng");
      if (!lat || !lng) return json({ error: "BAD_REQUEST", message: "lat/lng가 필요해요." }, 400);
      // 종류를 가리지 않고 가까운 순으로 받는다 (관광지·음식점·숙박 등이 섞여 온다)
      // 도시는 주변에 장소가 많아 60곳으로는 우리 지역 장소가 잘린다 → 앱이 rows로 더 받는다 (테마 룰렛, 최대 300곳)
      const rows = Math.min(Math.max(parseInt(url.searchParams.get("rows"), 10) || 60, 60), 300);
      const { items } = await callTourApi("locationBasedList2", { ...base, arrange: "E", mapX: lng, mapY: lat, radius: "20000", numOfRows: String(rows), pageNo: "1" }, WITH_API_BASE);
      payload = { items };
    } else if (action === "barrierFreeDetail") {
      const contentId = url.searchParams.get("contentId");
      if (!contentId || !/^\d+$/.test(contentId)) return json({ error: "BAD_REQUEST", message: "contentId가 필요해요." }, 400);
      const { items } = await callTourApi("detailWithTour2", { ...base, contentId }, WITH_API_BASE);
      // 비어 있지 않은 칸만 남긴다 (앱이 항목마다 이름과 그림을 붙여 보여준다)
      const fields = {};
      Object.entries(items[0] || {}).forEach(([k, v]) => {
        if (k === "contentid") return;
        if (typeof v === "string" && v.trim() && v.trim() !== "0") fields[k] = v.trim();
      });
      payload = { items: [{ contentid: contentId, ...fields }] };
    } else if (action === "camping") {
      const lat = url.searchParams.get("lat");
      const lng = url.searchParams.get("lng");
      if (!lat || !lng) return json({ error: "BAD_REQUEST", message: "lat/lng가 필요해요." }, 400);
      const { items } = await callTourApi("locationBasedList", { ...base, mapX: lng, mapY: lat, radius: "20000", numOfRows: "100", pageNo: "1" }, CAMPING_API_BASE);
      // 칸이 80개가 넘어 앱에 필요한 것만 남긴다. 운영 중인 곳만 (휴장·폐업 빼기)
      payload = {
        items: items.filter((it) => it.manageSttus === "운영").map((it) => ({
          id: it.contentId, name: it.facltNm, line: it.lineIntro, intro: it.intro, kinds: it.induty, env: it.lctCl,
          facilities: it.sbrsCl, pet: it.animalCmgCl, addr: it.addr1, lat: it.mapY, lng: it.mapX, tel: it.tel,
          homepage: it.homepage, reserveUrl: it.resveUrl, reserve: it.resveCl, season: it.operPdCl, days: it.operDeCl,
          trailer: it.trlerAcmpnyAt, caravan: it.caravAcmpnyAt, image: it.firstImageUrl,
        })),
      };
    } else if (action === "mountains") {
      payload = await mountains(serviceKey);
    } else if (action === "mountainPhotos") {
      // no = 산정보 ID(9자리), name = 산 이름, lat/lng = 정상 좌표(100대 명산만 있음)
      const no = url.searchParams.get("no") || "";
      const name = url.searchParams.get("name") || "";
      const lat = url.searchParams.get("lat");
      const lng = url.searchParams.get("lng");
      if (!/^\d{6,12}$/.test(no) || !name) return json({ error: "BAD_REQUEST", message: "no와 name이 필요해요." }, 400);
      payload = await mountainPhotos(base, serviceKey, no, name, lat, lng, url.searchParams.get("area") || "");
    } else if (action === "walkPhoto") {
      // 걷기길 사진: title = 코스 사진 제목(예: 해파랑길11코스), base = 길 이름(예: 바우길), names = 지나는 장소들("|"), area = 시·군·구
      const names = (url.searchParams.get("names") || "").split("|").map((s) => s.trim()).filter((s) => s.length >= 2).slice(0, 6);
      const area = url.searchParams.get("area") || "";
      if (!area) return json({ error: "BAD_REQUEST", message: "area가 필요해요." }, 400);
      payload = await walkPhotos(base, { title: url.searchParams.get("title") || "", base: url.searchParams.get("base") || "", names, area });
    } else if (action === "bikeProbe") {
      // 임시 점검 (자전거도로 표준데이터 세기, 확인 후 지울 것)
      const res = await fetch(`https://api.data.go.kr/openapi/tn_pubr_public_bike_road_api?${new URLSearchParams({ serviceKey, pageNo: url.searchParams.get("pageNo") || "1", numOfRows: "1000", type: "json" })}`);
      const text = await res.text();
      let out;
      try {
        const d = JSON.parse(text);
        const body = d?.response?.body || {};
        const raw = body?.items?.item || body?.items || [];
        const items = Array.isArray(raw) ? raw : [raw];
        out = { total: body.totalCount, head: d?.response?.header, items: items.map((t) => [t.bcyclRoadNm || t.routeNm || t.roadNm, t.ctprvnNm, t.signguNm, t.totLt || t.totalLt, t.bcyclRoadTy || t.bcyclRoadKnd, t.mainStpgSpot || t.mainViaSpot, t.beginLat || t.bgngLatitude, t.beginLng || t.bgngLongitude, t.endLat || t.endLatitude, t.endLng || t.endLongitude]), keys: items[0] ? Object.keys(items[0]) : [], raw: items.length ? undefined : text.slice(0, 600) };
      } catch { out = { raw: text.slice(0, 500) }; }
      return json(out);
    } else if (action === "fishing") {
      // 🎣 바다낚시 지수 포인트(40km 안) + 관광정보 낚시터(민물·바다, 20km 안)
      const lat = Number(url.searchParams.get("lat"));
      const lng = Number(url.searchParams.get("lng"));
      if (!lat || !lng) return json({ error: "BAD_REQUEST", message: "lat/lng가 필요해요." }, 400);
      const [points, fresh, sea] = await Promise.all([
        seaForecastNear(serviceKey, "fish", lat, lng, 40),
        tourNearByClass(base, lat, lng, "LS020500"),
        tourNearByClass(base, lat, lng, "LS020600"),
      ]);
      payload = { items: [{ points, places: [...sea, ...fresh] }] }; // 앱은 items만 읽는다
    } else if (action === "seaside") {
      // 🌊 해수욕장(관광정보) + 서핑 지수(30km) + 해수욕 지수(30km) + 서핑 업체(관광정보 윈드서핑 분류 중 이름에 서핑/서프)
      const lat = Number(url.searchParams.get("lat"));
      const lng = Number(url.searchParams.get("lng"));
      if (!lat || !lng) return json({ error: "BAD_REQUEST", message: "lat/lng가 필요해요." }, 400);
      const [beaches, surf, beachIdx, shops] = await Promise.all([
        tourNearByClass(base, lat, lng, "NA020900"),
        seaForecastNear(serviceKey, "surf", lat, lng, 30),
        seaForecastNear(serviceKey, "beach", lat, lng, 30),
        tourNearByClass(base, lat, lng, "LS020100"),
      ]);
      payload = { items: [{ beaches, surf, beachIdx, shops: shops.filter((it) => /서핑|서프|surf/i.test(it.title || "")) }] };
    } else if (action === "trailCourses") {
      const { durunubi } = await getTrailIndex(base, serviceKey);
      payload = { items: durunubi.map((c) => ({ id: c.id, name: c.name, area: c.area, km: c.km, minutes: c.minutes, level: c.level })) };
    } else if (action === "trails") {
      // 동네 산과 같은 방식: sgg(시·군·구), sido(시·도 앞글자). 두루누비는 '지나는 시·군'(sigun), 지자체 걷기길은 시작 지점 주소로 고른다
      const sgg = url.searchParams.get("sgg") || "";
      const sido = url.searchParams.get("sido") || "";
      if (!sgg && !sido) return json({ error: "BAD_REQUEST", message: "sgg 또는 sido가 필요해요." }, 400);
      const { durunubi, local } = await getTrailIndex(base, serviceKey);
      const inArea = (addr) => addrInArea(addr, sido, sgg);
      payload = {
        items: [
          ...durunubi.filter((c) => {
            const parts = (c.area || "").trim().split(/\s+/);
            // "부산 남구"처럼 시·도가 붙은 것과 "고성군"처럼 시·군만 있는 것이 섞여 있다
            if (parts.length >= 2) return inArea(c.area);
            return !!sgg && parts[0] === sgg && (!sido || sgg !== "고성군");
          }),
          ...local.filter((t) => inArea(t.beginAddr) || (!t.beginAddr && inArea(t.inst))),
        ],
      };
    } else if (action === "localMountains") {
      // sgg: 시·군·구 이름(예: 가평군, 종로구), sido: 시·도 앞글자(예: 서울, 강원 - 광역시 구나 고성군처럼 이름이 겹칠 때)
      const sgg = url.searchParams.get("sgg") || "";
      const sido = url.searchParams.get("sido") || "";
      if (!sgg && !sido) return json({ error: "BAD_REQUEST", message: "sgg 또는 sido가 필요해요." }, 400);
      const all = await getLocalMountainIndex(serviceKey);
      const items = all.filter((m) => {
        const parts = (m.addr || "").split(/\s+/);
        if (sido && !(parts[0] || "").startsWith(sido)) return false;
        return !sgg || parts.slice(1, 3).includes(sgg);
      });
      payload = { items };
    } else {
      return json({ error: "INVALID_ACTION", message: "action은 nearby, festival, pet, petNearby, detail, barrierFree, barrierFreeDetail, camping, mountains 중 하나여야 해요." }, 400);
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
