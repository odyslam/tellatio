// No credentials or network are required: exercise only the real stdio tool registry.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const child = spawn(process.execPath, ['dist/cli-readonly.js', '--mcp'], {
  env: { ...process.env, TELLATIO_WRITE_GUARD: 'off', TELLATIO_ALLOW_WRITES: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const pending = new Map();
const lines = readline.createInterface({ input: child.stdout });
let diagnostics = '';
child.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
lines.on('line', line => {
  const data = JSON.parse(line);
  const resolve = pending.get(data.id);
  if (resolve) { pending.delete(data.id); resolve(data); }
});
const timeout = setTimeout(() => { console.error('Read-only MCP test timed out'); child.kill(); process.exitCode = 1; }, 15000);
function request(id, method, params) {
  return new Promise(resolve => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
(async () => {
  const init = await request(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'security-smoke', version: '1' } });
  assert.ok(init.result);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const result = await request(2, 'tools/list', {});
  assert.deepEqual(result.result.tools.map(tool => tool.name).sort(), ['chats', 'info', 'me', 'read', 'search']);
  const blocked = await request(3, 'tools/call', { name: 'media_send', arguments: {} });
  assert.ok(blocked.error || blocked.result?.isError);
  const tooLong = await request(4, 'tools/call', { name: 'read', arguments: { chat: 'x'.repeat(513) } });
  assert.ok(tooLong.error || tooLong.result?.isError);
  assert.match(JSON.stringify(tooLong), /512|too_big|maximum/i);
  console.log('readonly-mcp-smoke: PASS (exact read-only tool list despite write-enabling environment; write call rejected)');
})().catch(err => { console.error(err); process.exitCode = 1; }).finally(() => {
  clearTimeout(timeout); child.stdin.end(); child.kill(); lines.close();
});
child.on('exit', code => {
  if (pending.size > 0) { console.error('MCP exited before response', code, diagnostics); process.exitCode = 1; clearTimeout(timeout); }
});
