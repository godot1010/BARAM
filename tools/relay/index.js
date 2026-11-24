// BARAM 중계 서버 — 구글 클라우드 서울(Cloud Run 서비스 baram-relay, asia-northeast3)
// 2026-11-24: 공공데이터포털(apis.data.go.kr)이 해외 IP를 막는 것으로 보여, Cloudflare(우리 서버)에서 바로 묻기가 실패할 때만 여기를 거친다.
// 하는 일: 비밀 암호(x-relay-token)가 맞으면, 받은 주소(공공데이터포털 주소만)를 대신 불러 그대로 돌려준다.
// 공공데이터 키는 주소 안에 들어 있고, 여기서는 저장하지도 기록하지도 않는다(주소는 POST 본문으로 받아 요청 기록에 안 남음).
// 비밀 암호는 구글 클라우드 Secret Manager 'relay-token'(Cloud Run 환경변수 RELAY_TOKEN)과 Cloudflare 비밀 RELAY_TOKEN이 같아야 한다.
// 올리기: tools/relay 폴더 내용을 Cloud Shell ~/relay에 두고
//   gcloud run deploy baram-relay --source . --region asia-northeast3 --allow-unauthenticated \
//     --set-secrets RELAY_TOKEN=relay-token:latest --max-instances 3 --memory 256Mi --quiet
const http = require("http");
const crypto = require("crypto");

const TOKEN = process.env.RELAY_TOKEN || "";
const HOSTS = new Set(["apis.data.go.kr", "api.data.go.kr"]);
const UPSTREAM_MS = 9000;

function sameToken(given) {
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(TOKEN);
  return TOKEN.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "x-relay": "1" });
  res.end(body);
}

http
  .createServer((req, res) => {
    if (req.method === "GET") return send(res, 200, "ok");
    if (req.method !== "POST") return send(res, 405, "method not allowed");
    if (!sameToken(req.headers["x-relay-token"])) return send(res, 403, "forbidden");

    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 8192) req.destroy();
    });
    req.on("end", async () => {
      let target;
      try {
        target = new URL(JSON.parse(raw).url);
      } catch {
        return send(res, 400, "bad url");
      }
      if (!/^https?:$/.test(target.protocol) || !HOSTS.has(target.hostname)) return send(res, 400, "host not allowed");

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), UPSTREAM_MS);
      try {
        const up = await fetch(target, { signal: controller.signal });
        const body = Buffer.from(await up.arrayBuffer());
        send(res, up.status, body, up.headers.get("content-type") || "application/octet-stream");
      } catch {
        send(res, 504, "upstream timeout");
      } finally {
        clearTimeout(timer);
      }
    });
  })
  .listen(process.env.PORT || 8080);
