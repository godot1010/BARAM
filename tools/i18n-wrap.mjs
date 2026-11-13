// 다국어 감싸기 도구 (2026-11-13 영어판 2단계)
// 원본 화면 코드에서 '화면에 그대로 보이는' 한국어만 골라 tr("…")로 감싼다. 한국어 화면은 tr이 원문을 그대로 돌려주므로 바뀌지 않는다.
//  - 감싸는 것: JSX 글자(옆에 {값}이 붙지 않은 것), JSX 속성 글자(aria-label·placeholder 등),
//    JSX 안의 글자 중 조건식(a ? "x" : "y")·(a && "x") 결과로만 쓰이는 것
//  - 안 감싸는 것(사람이 직접): {값}이 섞인 문장, 비교(=== "전체")·함수 인자·배열·객체·`템플릿` 안 글자, JSX 밖 상수
// 쓰는 법: node i18n-wrap.mjs        → 무엇을 감쌀지 목록만 보여 줌
//          node i18n-wrap.mjs --write → src/index.html 을 고침 + 새 원문 목록을 i18n-new-keys.json 으로
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "@babel/parser";
import traverseMod from "@babel/traverse";
const traverse = traverseMod.default;
const srcUrl = new URL("../src/index.html", import.meta.url);
const html = readFileSync(srcUrl, "utf8");
const open = '<script type="text/babel" data-presets="react">';
const s = html.indexOf(open) + open.length, e = html.indexOf("</script>", s);
const code = html.slice(s, e);
const H = /[가-힣]/;
const ast = parse(code, { sourceType: "script", plugins: ["jsx"] });
const line = (n) => code.slice(0, n.start).split("\n").length;
const edits = []; const keys = new Set(); const mixed = [];

const isExprChild = (c) => c.type === "JSXExpressionContainer" && c.expression.type !== "JSXEmptyExpression";
traverse(ast, {
  JSXText(p) {
    const v = p.node.value;
    if (!H.test(v)) return;
    const sib = p.parent.children, i = sib.indexOf(p.node);
    // 바로 옆(공백 글자 건너뛰고)에 {값}이 있으면 문장이 쪼개지므로 사람이 직접
    const near = (d) => { for (let j = i + d; j >= 0 && j < sib.length; j += d) { const c = sib[j]; if (c.type === "JSXText" && !c.value.trim()) continue; return c; } return null; };
    if ([near(-1), near(1)].some((c) => c && isExprChild(c))) { mixed.push([line(p.node), v.trim().replace(/\s+/g, " ")]); return; }
    const lead = v.match(/^\s*/)[0], trail = v.match(/\s*$/)[0];
    const core = v.slice(lead.length, v.length - trail.length);
    const key = core.replace(/\s*\n\s*/g, " ");
    if (/[{}<>&]/.test(p.node.extra?.raw ?? "")) { mixed.push([line(p.node), "(특수문자) " + key]); return; }
    keys.add(key);
    edits.push([p.node.start + lead.length, p.node.end - trail.length, `{tr(${JSON.stringify(key)})}`]);
  },
  StringLiteral(p) {
    const v = p.node.value;
    if (!H.test(v)) return;
    if (p.parent.type === "JSXAttribute") {
      keys.add(v); edits.push([p.node.start, p.node.end, `{tr(${JSON.stringify(v)})}`]); return;
    }
    // 조건식 결과 자리만 따라 올라가서 JSX {…}에 닿으면 감싼다
    let q = p;
    while (true) {
      const par = q.parentPath;
      if (par.isConditionalExpression() && q.key !== "test") { q = par; continue; }
      if (par.isLogicalExpression() && q.key === "right") { q = par; continue; }
      if (par.isJSXExpressionContainer()) break;
      return;
    }
    keys.add(v); edits.push([p.node.start, p.node.end, `tr(${JSON.stringify(v)})`]);
  },
});
console.log(`감쌀 곳 ${edits.length}, 원문 ${keys.size}, 사람이 직접 볼 곳 ${mixed.length}`);
if (process.argv.includes("--write")) {
  let out = code;
  for (const [a, b, r] of edits.sort((x, y) => y[0] - x[0])) out = out.slice(0, a) + r + out.slice(b);
  writeFileSync(srcUrl, html.slice(0, s) + out + html.slice(e));
  writeFileSync(new URL("./i18n-new-keys.json", import.meta.url), JSON.stringify([...keys], null, 1));
  writeFileSync(new URL("./i18n-mixed.json", import.meta.url), JSON.stringify(mixed, null, 1));
  console.log("src/index.html 고침");
}
