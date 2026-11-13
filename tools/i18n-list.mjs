// 다국어 점검 (2026-11-13): 아직 tr()로 감싸지 않은 한국어를 종류별로 줄 번호와 함께 보여 준다.
// 쓰는 법: node i18n-list.mjs [jsx|tpl|other]   (jsx = JSX 안 글자·템플릿, tpl = JSX 밖 템플릿, other = JSX 밖 글자)
import { readFileSync } from "node:fs";
import { parse } from "@babel/parser";
import traverseMod from "@babel/traverse";
const traverse = traverseMod.default;
const html = readFileSync(new URL("../src/index.html", import.meta.url), "utf8");
const open = '<script type="text/babel" data-presets="react">';
const s = html.indexOf(open) + open.length, e = html.indexOf("</script>", s);
const code = html.slice(s, e);
const base = html.slice(0, s).split("\n").length - 1;
const H = /[가-힣]/;
const want = process.argv[2] || "jsx";
const ast = parse(code, { sourceType: "script", plugins: ["jsx"] });
const L = (n) => base + n.loc.start.line;
const inTr = (p) => p.findParent((q) => q.isCallExpression() && q.node.callee.name === "tr");
traverse(ast, {
  StringLiteral(p) {
    if (!H.test(p.node.value) || inTr(p) || p.parent.type === "JSXAttribute") return;
    const jsx = !!p.findParent((q) => q.isJSXExpressionContainer());
    if ((want === "jsx" && jsx) || (want === "other" && !jsx)) console.log(L(p.node), p.parent.type, JSON.stringify(p.node.value));
  },
  TemplateLiteral(p) {
    const raw = p.node.quasis.map((q) => q.value.cooked).join("${}");
    if (!H.test(raw) || inTr(p)) return;
    const jsx = !!p.findParent((q) => q.isJSXExpressionContainer());
    if ((want === "jsx" && jsx) || (want === "tpl" && !jsx)) console.log(L(p.node), "`" + raw + "`");
  },
});
