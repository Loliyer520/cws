// asr-volc — 火山引擎语音识别大模型（极速版 flash）插件：语音 → 文字。
//
// 这是桥「可拆卸插件」的首个实例：bridge.js 只认通用装载器，不认识本文件。
// - 停用：config.json 里删 plugins['asr-volc'] 条目或置 enabled:false
// - 替换：换/改本文件（保持导出 commands 形状即可），重启桥生效
// - 移除：删配置条目 + 删本文件，桥其余部分完全无感
//
// 配置（config.json 非密 + secrets.json 敏感，同键名合并后者优先）：
//   enabled      开关（缺省 true）
//   app_key      控制台 App ID（X-Api-App-Key）
//   access_key   控制台 Access Token（X-Api-Access-Key，务必放 secrets.json）
//   resource_id  默认 volc.bigasr.auc_turbo（大模型极速版；标准版 volc.bigasr.auc）
//   model_name   默认 bigmodel
//   max_bytes    单段音频上限，默认 8MB
//
// 协议：action=asr.transcribe，params={data: base64(音频字节), format: 'm4a'|'wav'|'mp3'|...}
//       成功 → {post_type:'asr_result', text}；失败 → error 帧（鉴权错不重试，原样透传）
// 实测（2026-10-04）：该端点 body 只收 JSON（音频 base64 内嵌），发 octet-stream 原始二进制
// 会被当 JSON 解析报 45000000；鉴权失败返回 45000010（应用未开通/凭证错误，HTTP 401）。
import crypto from 'node:crypto';
import { log } from '../util.js';

const ENDPOINT = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash';

export const commands = {
  'asr.transcribe': async (ctx, params, echo) => {
    const { reply, cfg } = ctx;
    const fail = (code, message) => reply({ post_type: 'error', code, message, echo });

    if (!cfg.app_key || !cfg.access_key) {
      return fail('asr_not_configured', '语音识别未配置完整（缺 app_key/access_key）');
    }
    const b64 = typeof params.data === 'string' ? params.data : '';
    const fmt = /^[a-z0-9]{2,8}$/i.test(params.format || '') ? String(params.format).toLowerCase() : 'm4a';
    if (!b64) return fail('asr_empty', '没有音频数据');
    const maxBytes = Number(cfg.max_bytes || 8 * 1024 * 1024);
    if (Buffer.byteLength(b64, 'base64') > maxBytes) {
      return fail('asr_too_big', `音频超过 ${Math.round(maxBytes / 1048576)}MB 上限`);
    }

    let resp;
    try {
      resp = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'X-Api-App-Key': String(cfg.app_key),
          'X-Api-Access-Key': String(cfg.access_key),
          'X-Api-Resource-Id': String(cfg.resource_id || 'volc.bigasr.auc_turbo'),
          'X-Api-Request-Id': crypto.randomUUID(),
          'X-Api-Sequence': '-1', // 短音频一帧发完
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          user: { uid: 'cws-bridge' },
          audio: { format: fmt, data: b64 },
          request: { model_name: cfg.model_name || 'bigmodel', enable_punc: true },
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      log('asr_upstream_err', { err: String(e) });
      return fail('asr_upstream', `语音识别服务不可达：${e.name === 'TimeoutError' ? '超时' : String(e)}`);
    }

    const status = resp.headers.get('X-Api-Status-Code') || '';
    let body = {};
    try { body = await resp.json(); } catch { /* 非 JSON 错误页 */ }
    if (status !== '20000000') {
      const msg = body.message || (body.header && body.header.message)
        || resp.headers.get('X-Api-Message') || `HTTP ${resp.status}`;
      log('asr_upstream_reject', { status, http: resp.status, msg });
      return fail('asr_upstream', `识别失败：${msg}`);
    }
    const text = String((body.result && body.result.text) || '').trim();
    reply({ post_type: 'asr_result', text, echo });
  },
};
