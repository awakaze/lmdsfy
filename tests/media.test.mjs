import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { handleMedia } from '../media-worker.js';
import worker from '../worker.js';

test('file uploads preserve multipart order and bytes without buffering', async () => {
  const original = globalThis.fetch;
  let forwarded;
  globalThis.fetch = async (url, init) => {
    const data = await new Response(init.body).text();
    forwarded = { url, data, headers: init.headers };
    return Response.json({ id: 'file-api-test' });
  };
  try {
    const form = new FormData(); form.append('purpose', 'rich_layout_recognition'); form.append('file', new Blob(['test document']), 'test.pdf');
    const res = await worker.fetch(new Request('https://local/api/files', { method: 'POST', body: form }), { DEEPSEEK_API_KEY: 'secret' });
    assert.equal(res.status, 200);
    assert.equal(forwarded.url, 'https://api.deepseek.com/files');
    assert.ok(forwarded.data.indexOf('rich_layout_recognition') < forwarded.data.indexOf('test.pdf'));
    assert.match(forwarded.data, /test document/);
    assert.equal(forwarded.headers.get('Authorization'), 'Bearer secret');
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
  } finally { globalThis.fetch = original; }
});

test('file references survive multi-turn chat and injected block fields are removed', async () => {
  const original = globalThis.fetch;
  let body;
  globalThis.fetch = async (_url, init) => { body = JSON.parse(init.body); return new Response('data: [DONE]\n\n'); };
  try {
    const content = [{ type: 'file', file_id: 'file-api-test', untrusted: 'ignored' }, { type: 'text', text: 'summarize' }, { type: 'file', file_id: '../bad' }];
    await worker.fetch(new Request('https://local/api/chat', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content }] }) }), { DEEPSEEK_API_KEY: 'secret' });
    assert.deepEqual(body.messages[1].content, [{ type: 'file', file_id: 'file-api-test' }, { type: 'text', text: 'summarize' }]);
  } finally { globalThis.fetch = original; }
});

test('speech uses the official WAV tool and rejects oversized text', async () => {
  const original = globalThis.fetch;
  let called;
  globalThis.fetch = async (url, init) => { called = { url, body: JSON.parse(init.body) }; return new Response('RIFF', { headers: { 'Content-Type': 'audio/wav' } }); };
  const request = text => new Request('https://local/api/speech', { method: 'POST', body: JSON.stringify({ text }) });
  try {
    const res = await handleMedia(request('你好'), { DEEPSEEK_API_KEY: 'secret', DEEPSEEK_BASE_URL: 'https://api.deepseek.com/v1' }, '/api/speech');
    assert.equal(called.url, 'https://api.deepseek.com/v1/tools/tts');
    assert.equal(called.body.format, 'wav');
    assert.equal(res.headers.get('Content-Type'), 'audio/wav');
    assert.equal((await handleMedia(request('中'.repeat(5001)), { DEEPSEEK_API_KEY: 'secret' }, '/api/speech')).status, 400);
  } finally { globalThis.fetch = original; }
});

test('invalid uploads and missing credentials fail before contacting upstream', async () => {
  assert.equal((await handleMedia(new Request('https://local/api/files', { method: 'POST' }), {}, '/api/files')).status, 503);
  assert.equal((await handleMedia(new Request('https://local/api/files', { method: 'POST' }), { DEEPSEEK_API_KEY: 'test' }, '/api/files')).status, 400);
  const req = new Request('https://local/api/transcribe', { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=x', 'Content-Length': String(9 * 1024 * 1024) } });
  assert.equal((await handleMedia(req, { DEEPSEEK_API_KEY: 'test' }, '/api/transcribe')).status, 413);
});

test('microphone samples become valid mono PCM16 WAV accepted by ASR', async () => {
  const context = vm.createContext({ window: {}, Blob, DataView, ArrayBuffer });
  vm.runInContext(fs.readFileSync(new URL('../public/media.js', import.meta.url), 'utf8'), context);
  const wav = vm.runInContext('encodeWav([new Float32Array([-1, 0, 1])], 3, 16000)', context);
  const data = new DataView(await wav.arrayBuffer());
  assert.equal(wav.type, 'audio/wav'); assert.equal(wav.size, 50);
  assert.equal(data.getUint32(24, true), 16000); assert.equal(data.getUint16(22, true), 1);
  assert.equal(data.getInt16(44, true), -32768); assert.equal(data.getInt16(48, true), 32767);
});
