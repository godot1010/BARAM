# BARAM 배포 프로젝트

## 폴더 구성
- `index.html` — 프론트엔드 전체 (React/Tailwind CDN, 빌드 도구 불필요)
- `netlify/functions/tourapi.js` — 공공데이터포털(TourAPI) 프록시 서버 함수
- `netlify.toml` — Netlify 배포 설정

## 배포 방법 (요약)
1. 이 폴더 전체를 GitHub 저장소에 올린다.
2. Netlify → "Add new site" → "Import an existing project" → GitHub 저장소 연결.
3. Netlify 사이트 설정 → Environment variables → `TOUR_API_SERVICE_KEY` 추가
   (공공데이터포털에서 발급받은 서비스키, Encoding/Decoding 아무 값이나 넣어도 됨).
4. 배포 완료 후 사이트 접속 — 이제 사용자가 API 키를 입력할 필요가 전혀 없다.
