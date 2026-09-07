// 从闭源 Vue 编译 JS 提取功能点: render 函数里的可交互元素(按钮/输入/选择)+绑定事件
import { readFileSync } from "node:fs";
const file = process.argv[2];
const s = readFileSync(file, "utf8");

// Vue3 编译 render 特征: 找所有 createElement 调用 r("div"/w("button")/t("span") 及 onClick/onChange
// 提取: 元素标签 + 紧邻的文本/onXxx + class 关键名
const features = [];
const re = /(?:r|w|t|i|j|k|m|n|v|a|z|y|x|u|p|q|o|l|g|h|f|e|d|c|b)\(\s*"([a-z-]+)"\s*,\s*\{([^}]{0,400})\}/g;
let m;
while ((m = re.exec(s))) {
  const tag = m[1];
  const attrs = m[2];
  // 只留带交互/语义的元素
  if (!/on[A-Z]|v-model|class|placeholder|title|type="(button|submit|range|file|checkbox|select)"/.test(attrs)) continue;
  // 抓 attrs 里的关键: onClick 目标名/placeholder/文本
  const onclick = attrs.match(/onClick:\s*([A-Za-z_$][\w$]*)/);
  const ph = attrs.match(/placeholder:\s*"([^"]{2,40})"/);
  const label = attrs.match(/"([一-鿿][^"]{1,30})"/);
  const cls = attrs.match(/class:\s*"([^"]{4,60})"/);
  features.push({
    tag,
    onClick: onclick ? onclick[1] : "",
    ph: ph ? ph[1] : "",
    label: label ? label[1] : "",
    cls: cls ? cls[1].slice(0, 50) : "",
  });
}
// 去重
const seen = new Set();
const out = [];
for (const f of features) {
  const k = `${f.tag}|${f.onClick}|${f.ph}|${f.label}`;
  if (f.onClick || f.ph || f.label) {
    if (!seen.has(k)) { seen.add(k); out.push(f); }
  }
}
console.log(`=== ${file.split(/[/\\]/).pop()} 功能点(交互元素) ${out.length} ===`);
for (const f of out.slice(0, 200)) {
  console.log([f.tag.padEnd(8), (f.onClick ? "on:" + f.onClick : "").padEnd(24), (f.ph ? "ph:" + f.ph : "").padEnd(30), (f.label || "").slice(0, 24)].join(" "));
}
