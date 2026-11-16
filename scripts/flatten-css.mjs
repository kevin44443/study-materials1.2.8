/**
 * 构建后处理：拆平 CSS 中的 @layer 包装块。
 *
 * 背景：Tailwind v4 产物使用 CSS Cascade Layers（@layer theme/base/utilities），
 * 旧版 Android WebView（Chromium < 99）不认识 @layer，会整块丢弃其中的规则，
 * 导致所有布局工具类失效（页面纵向堆叠、按钮裸样式）。
 *
 * 本脚本把 @layer X { ... } 解包为普通规则、删除 @layer a, b; 声明语句。
 * Tailwind 产物中各 layer 块按声明顺序连续出现，按文件顺序解包即可保持原有层叠优先级。
 * 解包后的规则变为「未分层」，优先级高于分层规则，与旧版 WebView 行为一致。
 *
 * 用法：node scripts/flatten-css.mjs [distDir]   （默认 dist）
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(root, process.argv[2] || "dist");

/** 递归拆平一段 CSS 文本中的所有 @layer 结构。 */
function flatten(css) {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf("@layer", i);
    if (at === -1) {
      out += css.slice(i);
      break;
    }
    out += css.slice(i, at);

    // @layer 后面：先取标识符/逗号列表
    let j = at + "@layer".length;
    // 跳过空白
    while (j < css.length && /\s/.test(css[j])) j++;
    let names = "";
    while (j < css.length && /[\w\-,]/.test(css[j])) {
      names += css[j];
      j++;
    }
    // 跳过空白
    while (j < css.length && /\s/.test(css[j])) j++;

    if (css[j] === ";") {
      // 纯声明语句（@layer a, b;）——直接删除
      i = j + 1;
      continue;
    }
    if (css[j] !== "{") {
      // 不是我们能理解的结构（如 @layer() 函数），原样保留并前跳，避免死循环
      out += "@layer";
      i = at + "@layer".length;
      continue;
    }
    // 找到配对的右花括号
    let depth = 0;
    let k = j;
    for (; k < css.length; k++) {
      if (css[k] === "{") depth++;
      else if (css[k] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) {
      // 括号不平衡，放弃处理剩余部分，原样输出
      out += css.slice(at);
      break;
    }
    // 解包块内容（递归，处理理论上的嵌套 @layer）
    out += flatten(css.slice(j + 1, k));
    i = k + 1;
  }
  return out;
}

function walk(dir) {
  let cssFiles = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) cssFiles = cssFiles.concat(walk(p));
    else if (name.endsWith(".css")) cssFiles.push(p);
  }
  return cssFiles;
}

let changed = 0;
for (const file of walk(distDir)) {
  const css = readFileSync(file, "utf8");
  if (!css.includes("@layer")) continue;
  const flat = flatten(css);
  writeFileSync(file, flat);
  changed++;
  console.log(`[flatten-css] ${file} 拆平完成（${css.length} → ${flat.length} 字符）`);
}
if (!changed) console.log("[flatten-css] 未发现含 @layer 的 CSS，跳过");
