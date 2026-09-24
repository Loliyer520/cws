// Composer.tsx —— 输入区：自动增高 textarea、Enter 发送、
// 粘贴/拖入图片（claude 后端，≤3 张 × 6MB）、运行中变停止按钮。
import { useRef, useState } from "react";
import { store, useStore } from "../store";
import type { ImgAttachment } from "../types";
import { IconImage, IconSend, IconStop, IconX } from "../icons";

const MAX_IMAGES = 3;
const MAX_BYTES = 6 * 1024 * 1024;
const OK_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

interface PendingImg extends ImgAttachment {
  name: string;
  url: string; // data: 预览
}

export default function Composer() {
  const st = useStore();
  const s = st.current ? st.sessions.get(st.current) : undefined;
  const [text, setText] = useState("");
  const [images, setImages] = useState<PendingImg[]>([]);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [dragOver, setDragOver] = useState(false);

  if (!s) return null;
  const running = !!s.info.turn_active;

  const autoGrow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 180) + "px";
  };

  const addFiles = (files: File[]) => {
    const imgs = files.filter((f) => OK_TYPES.has(f.type));
    if (!imgs.length) { store.toast("仅支持 png / jpeg / gif / webp 图片", "err"); return; }
    const room = MAX_IMAGES - images.length;
    if (room <= 0) { store.toast(`最多 ${MAX_IMAGES} 张图片`, "err"); return; }
    const take = imgs.slice(0, room);
    if (imgs.length > room) store.toast(`最多 ${MAX_IMAGES} 张图片，已截取前 ${room} 张`, "err");
    let pending = take.length;
    take.forEach((f) => {
      if (f.size > MAX_BYTES) {
        store.toast(`图片 ${f.name} 超过 6MB，已跳过`, "err");
        if (--pending === 0) return;
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result || "");
        const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
        if (!m) return;
        setImages((prev) => [...prev, { name: f.name, media_type: m[1], data: m[2], url }]);
      };
      reader.readAsDataURL(f);
    });
  };

  const doSend = () => {
    if (running) { store.stop(); return; }
    if (!text.trim() && !images.length) return;
    const ok = store.sendText(text, images.length ? images.map(({ media_type, data }) => ({ media_type, data })) : undefined);
    if (ok) {
      setText("");
      setImages([]);
      requestAnimationFrame(autoGrow);
    }
  };

  return (
    <div className="composer-wrap">
      <div
        className={"composer" + (dragOver ? " drag" : "")}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(Array.from(e.dataTransfer.files)); }}
      >
        {images.length ? (
          <div className="img-chips">
            {images.map((im, i) => (
              <span className="img-chip" key={i} title={im.name}>
                <img src={im.url} alt={im.name} />
                <button onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}><IconX size={10} /></button>
              </span>
            ))}
          </div>
        ) : null}
        <textarea
          ref={taRef}
          rows={1}
          placeholder={running ? "生成中…（可停止）" : s.info.backend === "claude" ? "输入消息，Enter 发送 · 可粘贴图片" : "输入消息，Enter 发送"}
          value={text}
          disabled={running}
          onInput={autoGrow}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); doSend(); }
          }}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files || []);
            if (files.some((f) => f.type.startsWith("image/"))) {
              e.preventDefault();
              addFiles(files);
            }
          }}
        />
        <label className={"send-clip" + (s.info.backend === "claude" ? "" : " off")} title={s.info.backend === "claude" ? "添加图片" : "仅 claude 后端支持图片"}>
          <IconImage size={17} />
          <input
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            hidden
            onChange={(e) => { addFiles(Array.from(e.target.files || [])); e.currentTarget.value = ""; }}
          />
        </label>
        <button className={"send" + (running ? " stop" : "")} onClick={doSend} disabled={!running && !text.trim() && !images.length} title={running ? "停止" : "发送"}>
          {running ? <IconStop size={15} /> : <IconSend size={17} />}
        </button>
      </div>
      <div className="hint">
        {st.connected ? "Enter 发送 · Shift+Enter 换行" : "连接已断开，正在重连…"}
      </div>
    </div>
  );
}
