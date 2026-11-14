import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import worker from '../worker.js';
const env = { DEEPSEEK_API_KEY: 'test-key' };
const post = body => new Request('https://local/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('native search, thinking and signed history pass through without a separate search request', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, ...JSON.parse(init.body) }); return new Response('data: [DONE]\n\n'); };
  try {
    const signed = [{ index: 0, calls: [{ signature: 'opaque-signature', type: 'deepseek_read_url' }] }];
    const result = await worker.fetch(post({ think: true, search: true, messages: [{ role: 'user', content: 'read' }, { role: 'assistant', content: 'answer', server_tool_calls: signed }, { role: 'user', content: 'follow up' }] }), env);
    assert.equal(await result.text(), 'data: [DONE]\n\n');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
    assert.deepEqual(calls[0].tools, [{ type: 'deepseek_web_search' }, { type: 'deepseek_read_url' }]);
    assert.equal(calls[0].thinking.type, 'enabled');
    assert.deepEqual(calls[0].messages[2].server_tool_calls, signed);
    calls.length = 0;
    await worker.fetch(post({ q: 'hello' }), env);
    assert.deepEqual(calls[0].tools, [{ type: 'deepseek_read_url' }]);
    assert.equal(calls[0].thinking.type, 'disabled');
  } finally { globalThis.fetch = original; }
});

test('invalid bodies, empty messages and unsupported methods are rejected', async () => {
  for (const body of [null, [], {}, { messages: [] }]) assert.equal((await worker.fetch(post(body), env)).status, 400);
  assert.equal((await worker.fetch(new Request('https://local/api/chat', { method: 'DELETE' }), env)).status, 405);
});

test('network failures return a controlled error', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  try { assert.equal((await worker.fetch(post({ q: 'hello' }), env)).status, 502); }
  finally { globalThis.fetch = original; }
});

test('both page scripts compile and Unicode citation offsets preserve emoji', () => {
  const html = fs.readFileSync(new URL('../public/chat.html', import.meta.url), 'utf8');
  for (const file of ['chat.html', 'index.html']) {
    for (const match of fs.readFileSync(new URL('../public/' + file, import.meta.url), 'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
  }
  const helpers = html.slice(html.indexOf('  function safeUrl('), html.indexOf('  function openConv('));
  const context = vm.createContext({ URL, window: {}, renderMd: text => text, esc: text => text, linkCites: html => html });
  vm.runInContext(helpers, context);
  assert.equal(vm.runInContext(`renderAnswer('你好😀世界', [], [{url_citation:{url:'https://example.com',end_index:3}}])`, context), '你好😀<sup class="cite"><a href="https://example.com/" target="_blank" rel="noopener noreferrer">1</a></sup>世界');
  assert.equal(vm.runInContext(`safeUrl('javascript:alert(1)')`, context), '');
});
