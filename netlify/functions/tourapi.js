// Netlify Function: TourAPI(공공데이터포털) 프록시
// - 진짜 서비스키는 여기(서버)에만 있고, 브라우저에는 절대 노출되지 않는다.
// - 키는 Netlify 사이트 설정 > Environment variables 에 TOUR_API_SERVICE_KEY 로 등록해야 한다.
//   ("인증키(Decoding)" 원본 값을 그대로 넣으면 된다. 이미 URL 인코딩된 "Encoding" 키를 넣었어도
//    아래 normalizeServiceKey()가 자동으로 복원해서 처리한다.)

const TOUR_API_BASE = "https://apis.data.go.kr/B551011/KorService2";

function normalizeServiceKey(key) {
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // 이 함수를 다른 도메인(예: 개발 중 로컬 테스트)에서도 부를 수 있게 허용
      "access-control-allow-origin": "*",
    },
  });
}

export default async (req) => {
  try {
    const url = new URL(req.url);
    const action = url.searchParams.get("action");
    const rawServiceKey = process.env.TOUR_API_SERVICE_KEY;

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
    } else {
      return json({ error: "INVALID_ACTION", message: "action은 nearby 또는 festival 이어야 해요." }, 400);
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
    return json({ items });
  } catch (err) {
    return json({ error: "SERVER_ERROR", message: String((err && err.message) || err) }, 500);
  }
};

// 친절한 경로(/api/tourapi)로 이 함수를 노출 (Netlify Functions 2.0 방식)
export const config = { path: "/api/tourapi" };
