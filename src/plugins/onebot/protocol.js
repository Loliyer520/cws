// protocol.js — OneBot v11 编解码：原始帧 ↔ 内部事件，消息段解析/构造。
// 纯函数无 IO；InternalEvent 形状与规则见文件头设计注释与 README.md。

const CQ_UNESCAPE = { '&amp;': '&', '&#91;': '[', '&#93;': ']', '&#44;': ',' };
const unescapeCq = (s) => String(s || '').replace(/&(amp|#[0-9]+|#x[0-9a-f]+);/gi, (m) => CQ_UNESCAPE[m.toLowerCase()] || m);
const escapeCq = (s) => String(s || '').replace(/&/g, '&amp;').replace(/\[/g, '&#91;').replace(/\]/g, '&#93;').replace(/,/g, '&#44;');

/** 段数组 → 纯文本视图（at→@昵称、image→[图片]…），未知段渲染 [未知:<type>]。 */
export function segmentsToText(segments) {
  if (typeof segments === 'string') return unescapeCq(segments);
  const out = [];
  for (const seg of segments || []) {
    const d = seg.data || {};
    switch (seg.type) {
      case 'text': out.push(unescapeCq(d.text)); break;
      case 'at': out.push('@' + (d.nickname || String(d.qq || ''))); break;
      case 'reply': out.push('[回复]'); break;
      case 'image': out.push('[图片]'); break;
      case 'face': out.push('[表情]'); break;
      case 'record': out.push('[语音]'); break;
      case 'video': out.push('[视频]'); break;
      case 'forward': out.push('[合并转发]'); break;
      case 'json': out.push('[JSON卡片]'); break;
      case 'xml': out.push('[XML卡片]'); break;
      case 'file': out.push('[文件]'); break;
      default: out.push(`[未知:${seg.type}]`);
    }
  }
  return out.join('').trim();
}

/** string 形态消息的最低限度段解析（只解 at/image/reply/face，其余当纯文本）。 */
function parseCqString(text) {
  const segs = [];
  let rest = String(text || '');
  const re = /\[CQ:([a-zA-Z]+)((?:,[^,\]]*)?)\]/g;
  let m; let last = 0;
  while ((m = re.exec(rest)) !== null) {
    if (m.index > last) segs.push({ type: 'text', data: { text: rest.slice(last, m.index) } });
    const data = {};
    for (const kv of (m[2] || '').split(',').filter(Boolean)) {
      const i = kv.indexOf('=');
      if (i > 0) data[kv.slice(0, i)] = unescapeCq(kv.slice(i + 1));
    }
    segs.push({ type: m[1], data });
    last = re.lastIndex;
  }
  if (last < rest.length) segs.push({ type: 'text', data: { text: rest.slice(last) } });
  return segs;
}

const normSegments = (message, isString) => (isString ? parseCqString(message) : (Array.isArray(message) ? message : []));

/**
 * OneBot 事件帧 → InternalEvent。
 * 返回 null = 不是事件（动作响应/反向动作/无法识别），调用方分流处理。
 * meta/notice 也归一化（scope 为空），gate 决定只落 archive。
 */
export function normalizeEvent(f, selfId) {
  if (!f || typeof f !== 'object' || !f.post_type) return null;
  const selfNum = Number(selfId) || 0;
  const base = { ts: Number(f.time) || Math.floor(Date.now() / 1000), msgId: null, userId: null, nickname: '', atMe: false, replyTo: null, fromSelfDevice: false };
  if (f.post_type === 'meta_event') {
    return { ...base, kind: 'meta', scope: '', text: '', segments: [], sub: f.meta_event_type || '', sub2: f.sub_type || '' };
  }
  if (f.post_type === 'notice') {
    return { ...base, kind: 'notice', scope: '', text: '', segments: [], sub: f.notice_type || '', sub2: f.sub_type || '' };
  }
  if (f.post_type !== 'message' && f.post_type !== 'message_sent') return null;
  const isString = typeof f.message === 'string';
  const segments = normSegments(f.message, isString);
  const sender = f.sender || {};
  const userId = Number(f.user_id) || Number(sender.user_id) || 0;
  const ev = {
    ...base,
    kind: f.post_type === 'message_sent' ? 'message_sent' : 'message',
    userId,
    nickname: String(sender.card || sender.nickname || (userId ? String(userId) : '')),
    msgId: Number(f.message_id) || 0,
    segments,
    text: segmentsToText(segments),
  };
  // scope：group→group_<群号>；private→private_<对方QQ>（message_sent 的对方在 target_id）
  if (f.message_type === 'group') {
    ev.scope = 'group_' + (Number(f.group_id) || 0);
  } else {
    const other = (selfNum && userId === selfNum) ? (Number(f.target_id) || 0) : userId;
    ev.scope = 'private_' + other;
  }
  if (!ev.scope || ev.scope.endsWith('_0')) return null;
  // atMe：at 段命中本号
  ev.atMe = segments.some((s) => s.type === 'at' && Number(s.data && s.data.qq) === selfNum && selfNum !== 0);
  // reply 段引用
  const rep = segments.find((s) => s.type === 'reply');
  if (rep) ev.replyTo = Number(rep.data && rep.data.id) || null;
  // message_sent：sender 恒为自己 → 本人其他设备
  if (ev.kind === 'message_sent') ev.fromSelfDevice = !selfNum || userId === selfNum;
  return ev;
}

/** 发送段构造：text（必）+ reply/at（头部插）。CQ 转义防注入。 */
export function buildSendSegments({ text, replyTo = null, atQq = null }) {
  const segs = [];
  if (replyTo) segs.push({ type: 'reply', data: { id: String(replyTo) } });
  if (atQq) segs.push({ type: 'at', data: { qq: String(atQq) } });
  segs.push({ type: 'text', data: { text: String(text || '') } });
  return segs;
}

export { escapeCq };

/** 动作响应统一形状（本插件作为 OneBot 服务端极少应答；未知反向动作 1404）。 */
export function makeErrorResponse(echo, retcode, msg) {
  return { status: 'failed', retcode, data: null, message: msg || '', echo: echo || null };
}
