// BARAM 만들기 스크립트 (2026-11-08)
// 원본 src/index.html 의 <script type="text/babel"> 화면 코드(JSX)를 미리 일반 자바스크립트로 번역해서
// 사이트 루트의 index.html 을 만든다. 폰이 열 때마다 하던 번역(Babel, 3MB)이 필요 없어져 빨리 열린다.
//
// 쓰는 법:  cd tools && npm install (처음 한 번) && npm run build
// 규칙: 화면을 고칠 때는 src/index.html 만 고치고, 꼭 이 스크립트를 돌린 뒤 index.html 과 함께 올린다.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { transform } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcPath = join(root, "src", "index.html");
const outPath = join(root, "index.html");
let html = readFileSync(srcPath, "utf8");

// 1) 번역기(Babel) 스크립트 태그는 사이트용에서 뺀다
const babelTag = /(<!-- 번역기\(Babel\)[^\n]*-->\r?\n)?<script src="[^"]*@babel\/standalone[^"]*"[^>]*><\/script>\r?\n?/;
if (!babelTag.test(html)) throw new Error("원본에서 Babel 스크립트 태그를 못 찾았어요");
html = html.replace(babelTag, "");

// 2) 화면 코드(JSX)를 번역한다. 이름은 줄이지 않는다(전역 함수 이름 그대로 — 시험할 때 콘솔에서 부를 수 있게)
const open = '<script type="text/babel" data-presets="react">';
const start = html.indexOf(open);
if (start < 0 || html.indexOf(open, start + 1) >= 0) throw new Error("text/babel 스크립트가 정확히 하나여야 해요");
const end = html.indexOf("</script>", start);
const jsx = html.slice(start + open.length, end);
const { code } = await transform(jsx, {
  loader: "jsx",
  jsx: "transform", // React.createElement (Babel preset-react 기본과 같음)
  target: "esnext", // 문법은 지금(Babel preset-react)처럼 그대로 두고 JSX만 바꾼다
  minifyWhitespace: true,
  minifySyntax: true,
  legalComments: "none",
});
// 일반 <script>로 바로 실행한다(#root 다음 자리라 화면 틀은 이미 있음). 맨 위 이름들은 전처럼 전역으로 남는다.
// (예전 Babel은 페이지를 다 읽은 뒤 돌렸지만, 뒤에 오는 집계·서비스워커 스크립트는 화면 코드에 기대지 않아 순서가 바뀌어도 됨)
const compiled = `<script>\n// ⚠ 자동 생성된 코드 — 고치지 말 것. 원본은 src/index.html, 만들기: tools/build.mjs\n${code}\n</script>`;
html = html.slice(0, start) + compiled + html.slice(end + "</script>".length);

const banner = "<!-- ⚠ 자동 생성된 파일 — 직접 고치지 말 것. 원본: src/index.html → tools/build.mjs 로 만듦 -->\n";
writeFileSync(outPath, html.replace(/^<!DOCTYPE html>\r?\n/i, (m) => m + banner));
console.log(`만듦: index.html (${Math.round(Buffer.byteLength(html) / 1024)}KB, 화면 코드 ${Math.round(jsx.length / 1024)}KB → ${Math.round(code.length / 1024)}KB)`);
