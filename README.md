# BARAM - Cloudflare Pages 배포 가이드

Netlify 크레딧 문제 없이 무료로 계속 운영하기 위해 Cloudflare Pages로 옮기는 패키지입니다.
구조와 동작은 기존 Netlify 배포와 동일하고, TourAPI 서버 프록시만 Cloudflare Pages Functions
형식으로 옮겼습니다.

## 폴더 구성

```
baram-cloudflare-project/
├─ index.html                 # 룰렛 앱 (Babel Standalone + React UMD, 빌드 과정 없이 그대로 배포)
└─ functions/
   └─ api/
      └─ tourapi.js           # TourAPI(공공데이터포털) 프록시 - /api/tourapi 로 자동 매핑됨
```

Cloudflare Pages는 `functions/` 폴더 안의 파일 경로를 그대로 URL 경로로 매핑합니다.
`functions/api/tourapi.js` 파일은 별도 설정 없이 자동으로 `/api/tourapi` 주소에서 동작합니다.

## 배포 순서

### 1. GitHub 저장소 준비
- 기존에 Netlify와 연결했던 저장소를 그대로 써도 되고, 새 저장소를 만들어도 됩니다.
- 이 폴더 안의 `index.html`과 `functions/` 폴더를 저장소 루트에 올리세요
  (GitHub 웹 화면에서 파일 업로드 → Commit changes로도 충분합니다).

### 2. Cloudflare Pages 프로젝트 생성
1. https://dash.cloudflare.com 접속 → 로그인(가입 시 카드 등록 불필요)
2. 왼쪽 메뉴 **Workers & Pages** → **Create application** → **Pages** 탭 → **Connect to Git**
3. 방금 준비한 GitHub 저장소 선택
4. 빌드 설정:
   - **Framework preset**: None
   - **Build command**: (비워둠)
   - **Build output directory**: `/` (루트, 즉 `index.html`이 있는 위치)
5. **Save and Deploy** 클릭 → 몇 분 내로 `https://<프로젝트이름>.pages.dev` 주소가 생성됩니다.

### 3. 환경변수(서비스 키) 등록
1. 방금 만든 Pages 프로젝트 → **Settings** → **Environment variables**
2. **Add variable** 클릭
   - Variable name: `TOUR_API_SERVICE_KEY`
   - Value: 공공데이터포털에서 발급받은 서비스 키 원본 값
     ("인증키(Decoding)" 값을 그대로 넣으면 됩니다. "Encoding" 키를 넣어도 서버 코드가
     자동으로 처리하므로 상관없습니다.)
   - **Production**과 **Preview** 환경 둘 다 체크해서 등록해주세요.
3. 저장 후 **Deployments** 탭에서 최신 배포를 다시 **Retry deployment** 하면 환경변수가 적용됩니다.

### 4. 확인
- `https://<프로젝트이름>.pages.dev` 접속해서 룰렛이 정상적으로 도는지 확인
- 결과가 나온 뒤 "명소/맛집/축제" 탭을 열어봤을 때 데이터가 뜨면 TourAPI 프록시(`/api/tourapi`)도
  정상 동작하는 것입니다.

## 이후 업데이트 방법
지금까지와 동일하게, GitHub 저장소의 `index.html`을 새 버전으로 교체하고 커밋하면
Cloudflare Pages가 자동으로 다시 배포합니다 (Netlify와 동일한 방식).

## Netlify와 달라지는 점
- 프록시 함수 URL이 `/.netlify/functions/tourapi` → **`/api/tourapi`** 로 바뀌었습니다
  (앱 코드에도 이미 반영되어 있습니다).
- 대역폭/요청 수 제한이 훨씬 넉넉하고(대역폭 무제한, 함수 요청 10만 건/일), 크레딧이 소진돼서
  배포가 막히는 구조가 아닙니다.
