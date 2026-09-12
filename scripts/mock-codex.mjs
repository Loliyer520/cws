#!/usr/bin/env node
// mock codex CLI: speaks the codex exec --json JSONL event protocol.
// argv: codex exec --json [flags] [resume <tid>] "<prompt>"
import process from 'node:process';

const args = process.argv.slice(2);
const prompt = args[args.length - 1] || '';
const resumeIdx = args.indexOf('resume');
const threadId = resumeIdx >= 0 && args[resumeIdx + 1] ? args[resumeIdx + 1]
  : 'mock-' + Math.random().toString(16).slice(2, 14);

function out(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function usage() {
  return { input_tokens: 30, cached_input_tokens: 10, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 5 };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  out({ type: 'thread.started', thread_id: threadId });
  out({ type: 'turn.started' });
  out({ type: 'item.started', item: { id: 'item_r0', type: 'reasoning', text: '' } });
  out({ type: 'item.completed', item: { id: 'item_r0', type: 'reasoning', text: '**思考**：算一下' } });

  if (prompt.includes('数到') || prompt.includes('数数')) {
    out({ type: 'item.started', item: { id: 'item_a1', type: 'agent_message', text: '' } });
    let acc = '';
    for (let i = 1; i <= 300; i++) {
      acc += String(i) + '\n';
      out({ type: 'item.updated', item: { id: 'item_a1', type: 'agent_message', text: acc } });
      await sleep(40);
    }
    out({ type: 'item.completed', item: { id: 'item_a1', type: 'agent_message', text: acc } });
    out({ type: 'turn.completed', usage: usage() });
    return;
  }

  if (prompt.includes('bash')) {
    out({ type: 'item.started', item: { id: 'item_c1', type: 'command_execution', command: 'bash -lc ls', aggregated_output: '', status: 'in_progress' } });
    await sleep(50);
    out({ type: 'item.completed', item: { id: 'item_c1', type: 'command_execution', command: 'bash -lc ls', aggregated_output: 'file.txt', exit_code: 0, status: 'completed' } });
  }

  const m = prompt.match(/(\d+)\s*\+\s*(\d+)/);
  const answer = m ? String(Number(m[1]) + Number(m[2])) : 'mock-codex 收到：' + prompt.slice(0, 40);
  out({ type: 'item.started', item: { id: 'item_a2', type: 'agent_message', text: '' } });
  out({ type: 'item.updated', item: { id: 'item_a2', type: 'agent_message', text: answer.slice(0, 1) } });
  out({ type: 'item.updated', item: { id: 'item_a2', type: 'agent_message', text: answer } });
  out({ type: 'item.completed', item: { id: 'item_a2', type: 'agent_message', text: answer } });
  out({ type: 'turn.completed', usage: usage() });
})().catch((e) => {
  process.stderr.write(String(e) + '\n');
  process.exit(1);
});
