// 다국어 점검 (2026-11-13): 화면 코드의 tr("…") 원문이 영어 번역표(i18n/en.js)에 모두 있는지, 표에 쓰지 않는 열쇠가 있는지 본다.
import { readFileSync } from "node:fs";
import { parse } from "@babel/parser";
import traverseMod from "@babel/traverse";
const traverse = traverseMod.default;
const html = readFileSync(new URL("../src/index.html", import.meta.url), "utf8");
const open = '<script type="text/babel" data-presets="react">';
const s = html.indexOf(open) + open.length, e = html.indexOf("</script>", s);
const ast = parse(html.slice(s, e), { sourceType: "script", plugins: ["jsx"] });
const used = new Set(); const dynamic = [];
traverse(ast, { CallExpression(p) {
  if (p.node.callee.name !== "tr") return;
  const a = p.node.arguments[0];
  if (a && a.type === "StringLiteral") used.add(a.value); else dynamic.push(p.node.loc.start.line);
} });
const window = {}; eval(readFileSync(new URL("../i18n/en.js", import.meta.url), "utf8"));
const en = window.BARAM_I18N_EN;
const missing = [...used].filter((k) => !(k in en)), unused = Object.keys(en).filter((k) => !used.has(k));
const badVars = [...used].filter((k) => k in en && (k.match(/\{\w+\}/g) || []).sort().join() !== (en[k].match(/\{\w+\}/g) || []).sort().join());
console.log(`tr 원문 ${used.size}, 번역표 ${Object.keys(en).length}`);
console.log("표에 없음:", missing); console.log("안 쓰는 열쇠:", unused); console.log("{자리} 안 맞음:", badVars);
if (dynamic.length) console.log("글자가 아닌 값으로 부른 tr (줄):", dynamic);
