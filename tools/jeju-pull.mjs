// 🍊 비짓제주(제주관광공사) 자료 받기 (2026-11-08)
// 미리보기 서버의 jejuProbe(키는 Cloudflare 환경변수 VISITJEJU_API_KEY)로 관광지(c1)·숙박(c3)·음식점(c4)을 모두 받아
// 사이트 루트의 /jeju/<권역코드>.json 으로 나눠 저장한다. 앱은 여행지 권역의 파일만 받는다.
// 쓰는 법: cd tools && node jeju-pull.mjs   (한 달에 한 번쯤, 받은 뒤 jeju/ 폴더를 커밋)
// 출처 표시: 앱 화면에 '제주관광공사 VISIT JEJU'를 꼭 적는다.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "https://preview.baram-bh4.pages.dev/api/tourapi?action=jejuProbe&full=1";
const CATS = { c1: "1", c3: "3", c4: "4" }; // 관광지 / 숙박 / 음식점
const SKIP_TAGS = /^(비짓제주|visitjeju|제주|제주도|제주여행|\d{4}.*|.*페스타)$/i;

async function getPage(cat, page) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`${BASE}&category=${cat}&page=${page}&t=${Date.now()}`, { headers: { "user-agent": "Mozilla/5.0 BARAM-tools" } });
    if (r.ok) { const d = await r.json(); if (d.items) return d; }
    await new Promise((res) => setTimeout(res, 1500));
  }
  throw new Error(`${cat} ${page}쪽을 못 받았어요`);
}

const byArea = {};
for (const [cat, short] of Object.entries(CATS)) {
  const first = await getPage(cat, 1);
  const pages = first.head.pageCount;
  const list = [...first.items];
  for (let p = 2; p <= pages; p++) list.push(...(await getPage(cat, p)).items);
  let kept = 0;
  for (const it of list) {
    if (!it.lat || !it.lng || !it.r2) continue; // 위치 없는 곳은 거리·길찾기를 못 해서 뺀다
    const tags = [...new Set(it.tag.split(",").map((t) => t.trim()).filter((t) => t && !SKIP_TAGS.test(t)))].slice(0, 6);
    (byArea[it.r2] ||= { code: it.r2, name: it.r2n, items: [] }).items.push({
      id: it.id, t: it.t.trim(), c: short, a: it.a, tags, intro: it.intro.trim(),
      lat: Math.round(it.lat * 1e6) / 1e6, lng: Math.round(it.lng * 1e6) / 1e6, ph: it.ph, th: it.thumb, img: it.img,
    });
    kept++;
  }
  console.log(`${cat}: ${list.length}곳 받음, 위치 있는 ${kept}곳 저장`);
}

const outDir = join(root, "jeju");
mkdirSync(outDir, { recursive: true });
const index = [];
for (const area of Object.values(byArea)) {
  writeFileSync(join(outDir, `${area.code}.json`), JSON.stringify({ code: area.code, name: area.name, updated: new Date().toISOString().slice(0, 10), items: area.items }));
  index.push({ code: area.code, name: area.name, count: area.items.length });
}
index.sort((a, b) => a.code.localeCompare(b.code));
writeFileSync(join(outDir, "index.json"), JSON.stringify({ updated: new Date().toISOString().slice(0, 10), source: "제주관광공사 VISIT JEJU", areas: index }));
console.log(index.map((a) => `${a.code} ${a.name} ${a.count}`).join("\n"));
