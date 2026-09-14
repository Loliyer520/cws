#!/usr/bin/env node
// mock claude CLI: speaks the stream-json protocol well enough for acceptance tests.
import readline from 'node:readline';
import process from 'node:process';

const rl = readline.createInterface({ input: process.stdin });
let pendingTool = null;

function out(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function controlResponse(requestId, response) {
  out({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
}
function resultFrame(text, extra = {}) {
  out({
    type: 'result', subtype: extra.is_error ? 'error_during_execution' : 'success',
    result: text, session_id: 'mock',
    usage: { input_tokens: 10, output_tokens: text.length, cache_read_input_tokens: 0 },
    total_cost_usd: 0.0001, duration_ms: 120, num_turns: 1,
    is_error: !!extra.is_error, ...extra,
  });
}
function delta(text) {
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
}
// 真 CLI 顺序：stream_event 增量发完后，还会发一条完整 assistant 帧（text/tool_use 块）。
// mock 若只发 delta 不发完整帧，"delta 落 buf + 完整帧再落 buf"的双写回归就测不到。
function assistantFrame(blocks) {
  out({ type: 'assistant', message: { role: 'assistant', model: 'mock-claude', content: blocks } });
}

rl.on('line', async (line) => {
  line = line.trim();
  if (!line) return;
  let obj;
  try { obj = JSON.parse(line); } catch { return; }
  if (obj.type === 'control_request') {
    const req = obj.request || {};
    if (req.subtype === 'initialize') {
      controlResponse(obj.request_id, {});
      out({ type: 'system', subtype: 'init', session_id: 'mock', model: 'mock-claude' });
    } else if (req.subtype === 'set_permission_mode') {
      controlResponse(obj.request_id, {});
    }
    return;
  }
  if (obj.type === 'control_response') {
    if (pendingTool && obj.response && obj.response.request_id === pendingTool.request_id) {
      const tool = pendingTool;
      pendingTool = null;
      const resp = obj.response.response || {};
      if (tool.tool === 'AskUserQuestion') {
        const answers = (resp.updatedInput || {}).answers || {};
        const first = Object.values(answers)[0];
        resultFrame('你选了' + (Array.isArray(first) ? first.join(',') : first));
      } else {
        resultFrame(resp.behavior === 'allow' ? '工具已执行' : '工具调用被拒绝（denied by user）');
      }
    }
    return;
  }
  if (obj.type !== 'user') return;
  const text = (obj.message.content || []).map((b) => b.text || '').join('');

  if (text.includes('数到') || text.includes('数数')) {
    (async () => {
      for (let i = 1; i <= 300; i++) {
        delta(String(i) + '\n');
        await new Promise((r) => setTimeout(r, 30));
      }
      resultFrame('数完了');
    })();
    return;
  }
  if (text.includes('bash') && text.includes('创建')) {
    // 工具前置文本：delta + 完整帧（含 tool_use）——双写回归的触发路径
    delta('准备创建文件。');
    assistantFrame([{ type: 'text', text: '准备创建文件。' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'printf hi > p4test.txt' } }]);
    pendingTool = {
      request_id: 'req-' + Math.random().toString(16).slice(2, 10),
      tool: 'Bash',
      input: { command: 'printf hi > p4test.txt' },
    };
    out({ type: 'control_request', request_id: pendingTool.request_id, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: pendingTool.input } });
    return;
  }
  if (text.includes('颜色')) {
    pendingTool = {
      request_id: 'req-' + Math.random().toString(16).slice(2, 10),
      tool: 'AskUserQuestion',
      input: { questions: [{ question: '你最喜欢哪个颜色？', header: '颜色', options: [{ label: '红' }, { label: '蓝' }, { label: '绿' }], multiSelect: false }] },
    };
    out({ type: 'control_request', request_id: pendingTool.request_id, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: pendingTool.input } });
    return;
  }
  const m = text.match(/(\d+)\s*\+\s*(\d+)/);
  const n = m ? String(Number(m[1]) + Number(m[2])) : 'mock-claude 收到：' + text.slice(0, 30);
  delta(n);
  assistantFrame([{ type: 'text', text: n }]);
  resultFrame(n);
});
rl.on('close', () => process.exit(0));
