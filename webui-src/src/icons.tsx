// icons.tsx —— 内联 SVG 图标集（stroke 风格，随 currentColor 着色）
// 基础集移植自 kawork，追加 cws 需要的桥 / 发送 / 删除等。
type P = { size?: number; className?: string };

function base(size: number, className: string | undefined, children: React.ReactNode) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      className={className} aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** 桥：cws 品牌标识（两个节点一线牵） */
export const IconBridge = ({ size = 16, className }: P) =>
  base(size, className, (
    <>
      <circle cx="5" cy="12" r="2.6" />
      <circle cx="19" cy="12" r="2.6" />
      <path d="M7.6 12h8.8" />
      <path d="M12 5.5v13" />
    </>
  ));

/** 终端：shell 工具 */
export const IconTerminal = ({ size = 16, className }: P) =>
  base(size, className, (
    <>
      <path d="m5 7 5 5-5 5" />
      <path d="M13 17h6" />
    </>
  ));

/** 右尖角：折叠分割线指示 */
export const IconChevron = ({ size = 16, className }: P) =>
  base(size, className, <path d="m9 6 6 6-6 6" />);

/** 文档：读文件 */
export const IconFile = ({ size = 16, className }: P) =>
  base(size, className, (
    <>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6" />
    </>
  ));

/** 铅笔：写文件 / 备注 */
export const IconPencil = ({ size = 16, className }: P) =>
  base(size, className, <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />);

/** 清单 */
export const IconList = ({ size = 16, className }: P) =>
  base(size, className, (
    <>
      <path d="M8.5 6h12M8.5 12h12M8.5 18h12" />
      <path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
    </>
  ));

/** 齿轮：设置 / 渠道 */
export const IconGear = ({ size = 16, className }: P) =>
  base(size, className, (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5 5l2.2 2.2M16.8 16.8 19 19M19 5l-2.2 2.2M7.2 16.8 5 19" />
    </>
  ));

/** 便签：会话备注 */
export const IconNote = ({ size = 16, className }: P) =>
  base(size, className, (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </>
  ));

/** 叉：删除 / 拒绝 / 关闭 */
export const IconX = ({ size = 16, className }: P) =>
  base(size, className, <path d="M6 6l12 12M18 6 6 18" />);

/** 对勾：允许 / 完成 */
export const IconCheck = ({ size = 16, className }: P) =>
  base(size, className, <path d="m4.5 12.5 5 5 10-11" />);

/** 方块：停止生成 */
export const IconStop = ({ size = 16, className }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    <rect x="6.5" y="6.5" width="11" height="11" rx="2.5" fill="currentColor" />
  </svg>
);

/** 图片 */
export const IconImage = ({ size = 16, className }: P) =>
  base(size, className, (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="1.8" />
      <path d="m21 16-4.5-4.5L9 19" />
    </>
  ));

/** 上箭头：发送 */
export const IconSend = ({ size = 16, className }: P) =>
  base(size, className, <path d="M12 20V5M5.5 11.5 12 5l6.5 6.5" />);

/** 加号：新建 */
export const IconPlus = ({ size = 16, className }: P) =>
  base(size, className, <path d="M12 5v14M5 12h14" />);

/** 垃圾桶：删除会话 */
export const IconTrash = ({ size = 16, className }: P) =>
  base(size, className, (
    <>
      <path d="M4 7h16M9.5 7V4.5h5V7" />
      <path d="M6.5 7l1 13h9l1-13" />
    </>
  ));

/** 汉堡：移动端侧栏 */
export const IconMenu = ({ size = 16, className }: P) =>
  base(size, className, <path d="M4 7h16M4 12h16M4 17h16" />);

/** 服务器堆叠：后端与网关 */
export const IconStack = ({ size = 16, className }: P) =>
  base(size, className, (
    <>
      <rect x="3" y="4" width="18" height="6" rx="1.5" />
      <rect x="3" y="14" width="18" height="6" rx="1.5" />
      <path d="M7 7h.01M7 17h.01" />
    </>
  ));

/** 环形箭头：检查更新 / 系统更新 */
export const IconSync = ({ size = 16, className }: P) =>
  base(size, className, (
    <>
      <path d="M21 12a9 9 0 1 1-2.6-6.3" />
      <path d="M21 3v6h-6" />
    </>
  ));

/** 手表：卡西（手表助手） */
export const IconWatch = ({ size = 16, className }: P) =>
  base(size, className, (
    <>
      <circle cx="12" cy="12" r="5.5" />
      <path d="M12 9.5V12l1.8 1.8" />
      <path d="M9.5 6.6 9 3h6l-.5 3.6M9.5 17.4 9 21h6l-.5-3.6" />
    </>
  ));
