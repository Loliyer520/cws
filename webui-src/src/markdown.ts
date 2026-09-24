// markdown.ts —— assistant 消息的 markdown 渲染（gfm + breaks），
// DOMPurify 消毒；/oc-media/ 相对 URL 与 http(s) 图片放行，data: 默认不放行。

import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: true });

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
  if (node.tagName === "IMG") {
    node.setAttribute("loading", "lazy");
  }
});

export function md(src: string): string {
  if (!src) return "";
  const html = marked.parse(src, { async: false });
  return DOMPurify.sanitize(html as string);
}
