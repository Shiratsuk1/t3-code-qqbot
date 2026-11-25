import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';
import { handleMcpRequest, MEDIA_TOOL_DEFINITION } from '../src/publish.ts';

test('publish MCP handler supports initialize, ping, tools/list, tools/call, and JSON-RPC errors', async () => {
  const initRes = (await handleMcpRequest(
    { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    async () => ({}),
  )) as any;
  assert.equal(initRes.id, 1);
  assert.equal(initRes.result.protocolVersion, '2025-06-18');
  assert.equal(initRes.result.serverInfo.name, 't3-code-qqbot-media');

  const listRes = (await handleMcpRequest({ id: 2, method: 'tools/list' }, async () => ({}))) as any;
  assert.equal(listRes.result.tools[0].name, MEDIA_TOOL_DEFINITION.name);

  const okCall = (await handleMcpRequest(
    { id: 3, method: 'tools/call', params: { name: 'qqbot_send_media', arguments: { path: 'a.png' } } },
    async args => ({ content: [{ type: 'text', text: `sent ${args?.path}` }] }),
  )) as any;
  assert.equal(okCall.result.content[0].text, 'sent a.png');

  const unknownTool = (await handleMcpRequest(
    { id: 4, method: 'tools/call', params: { name: 'other_tool', arguments: {} } },
    async () => ({}),
  )) as any;
  assert.equal(unknownTool.error.code, -32602);

  const failCall = (await handleMcpRequest(
    { id: 5, method: 'tools/call', params: { name: 'qqbot_send_media', arguments: { path: '../x' } } },
    async () => {
      throw new Error('Artifact is outside this workspace directory');
    },
  )) as any;
  assert.equal(failCall.result.isError, true);
  assert.match(failCall.result.content[0].text, /outside this workspace/);

  const nonObject = (await handleMcpRequest(null, async () => ({}))) as any;
  assert.equal(nonObject.error.code, -32600);

  const unknown = (await handleMcpRequest({ id: 6, method: 'nope' }, async () => ({}))) as any;
  assert.equal(unknown.error.code, -32601);
});

test('publish stdio server handles pipelined initialize + tools/list + bad JSON + missing config gracefully', async () => {
  const script = resolve(import.meta.dirname, '..', 'src', 'publish.ts');
  const missingConfig = resolve(import.meta.dirname, '..', 'nonexistent-config-for-test.json');
  const stdout = await new Promise<string>((resolveOut, rejectOut) => {
    const child = execFile(process.execPath, [script, missingConfig], { timeout: 10_000 }, (err, out) => {
      if (err) rejectOut(err);
      else resolveOut(out);
    });
    child.stdin?.end(
      '\uFEFF{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n' +
        '{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n' +
        '{not valid json}\n' +
        'null\n' +
        '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"qqbot_send_media","arguments":{"path":"a.png"}}}\n',
      'utf8',
    );
  });
  const responses = stdout
    .trim()
    .split(/\r?\n/)
    .map(line => JSON.parse(line));
  assert.equal(responses.length, 5);
  assert.equal(responses[0].id, 1);
  assert.equal(responses[0].result.serverInfo.name, 't3-code-qqbot-media');
  assert.equal(responses[1].id, 2);
  assert.equal(responses[1].result.tools[0].name, 'qqbot_send_media');
  assert.equal(responses[2].error.code, -32700);
  assert.equal(responses[3].error.code, -32600);
  assert.equal(responses[4].id, 3);
  assert.equal(responses[4].result.isError, true);
});
