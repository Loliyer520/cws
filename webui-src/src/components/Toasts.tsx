// Toasts.tsx —— 右下角通知
import { useStore } from "../store";

export default function Toasts() {
  const st = useStore();
  if (!st.toasts.length) return null;
  return (
    <div className="toasts">
      {st.toasts.map((t) => (
        <div key={t.id} className={"toast " + t.kind}>{t.text}</div>
      ))}
    </div>
  );
}
