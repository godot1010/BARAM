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
const CACHE_SECONDS = { nearby: DAY, festival: 6 * 60 * 60, pet: DAY, petNearby: DAY, detail: 7 * DAY, barrierFree: DAY, barrierFreeDetail: 7 * DAY, camping: DAY, mountains: 7 * DAY, localMountains: 7 * DAY, mountainPhotos: 7 * DAY };
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
