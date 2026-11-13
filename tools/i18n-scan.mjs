// 다국어 점검 도구 (2026-11-13): 원본 화면 코드에서 한국어 글자가 어디에 몇 개 있는지 센다.
import { readFileSync } from "node:fs";
import { parse } from "@babel/parser";
import traverseMod from "@babel/traverse";
const traverse = traverseMod.default;
const html = readFileSync(new URL("../src/index.html", import.meta.url), "utf8");
const open = '<script type="text/babel" data-presets="react">';
const s = html.indexOf(open) + open.length, e = html.indexOf("</script>", s);
const code = html.slice(s, e);
export const HANGUL = /[가-힣]/;
const ast = parse(code, { sourceType: "script", plugins: ["jsx"] });
const kinds = {}; const uniq = {};
const add = (k, v) => { kinds[k] = (kinds[k] || 0) + 1; (uniq[k] ||= new Set()).add(v); };
traverse(ast, {
  JSXText(p) { if (HANGUL.test(p.node.value)) add("jsxText", p.node.value.trim()); },
  StringLiteral(p) {
    if (!HANGUL.test(p.node.value)) return;
    if (p.parent.type === "JSXAttribute") return add("jsxAttr", p.node.value);
    if (p.parent.type === "CallExpression" && p.parent.callee.name === "tr") return add("tr", p.node.value);
    add(p.findParent((q) => q.isJSXExpressionContainer()) ? "inJsxExpr" : "other", p.node.value);
  },
  TemplateLiteral(p) {
    const raw = p.node.quasis.map((q) => q.value.cooked).join("{}");
    if (!HANGUL.test(raw)) return;
    add(p.findParent((q) => q.isJSXExpressionContainer()) ? "tplInJsx" : "tplOther", raw);
  },
});
for (const k in kinds) console.log(k, kinds[k], "고유", uniq[k].size);
