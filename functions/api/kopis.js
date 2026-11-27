// Cloudflare Pages Function: 공연예술통합전산망(KOPIS) 공연 정보 → /api/kopis
// - 인증키는 Cloudflare 비밀 KOPIS_API_KEY (형이 직접 넣음, 코드에 넣지 않음)
// - 출처 표시 필수: (재)예술경영지원센터 공연예술통합전산망(www.kopis.or.kr)
// - 지금은 자료 모양을 보려는 '점검 통로'만 있음: 미리보기 주소에서만 동작하고, 응답에 키를 넣지 않는다.

const KOPIS_BASE = "https://www.kopis.or.kr/openApi/restful/";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const host = url.hostname;
  const isPreview = host !== "baram-bh4.pages.dev" && host.endsWith(".baram-bh4.pages.dev");
  const key = env.KOPIS_API_KEY || "";
  if (!key) return new Response("NO_KEY", { status: 500 });

  // 점검 통로: /api/kopis?probe=pblprfr&stdate=...&...  (미리보기 주소에서만)
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
      return new Response(text, {
        status: res.status,
        headers: { "content-type": "text/plain; charset=utf-8", "x-ms": String(Date.now() - started) },
      });
    } catch (e) {
      return new Response("FETCH_FAIL " + (e && e.message) + " after " + (Date.now() - started) + "ms", { status: 502 });
    }
  }
  return new Response("NOT_READY", { status: 404 });
}
