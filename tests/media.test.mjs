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

function streamingWav() {
  const wav = Buffer.alloc(364);
  wav.write('RIFF'); wav.writeUInt32LE(0xffffffff, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(0xffffffff, 40);
  return wav;
}

test('speech fixes unknown WAV lengths before playback and preserves the button icon', async () => {
  const blobs = new Map(); const errors = []; let played = 0;
  class Audio {
    constructor(url) { this.url = url; }
    async play() {
      const bytes = await blobs.get(this.url).arrayBuffer(); const view = new DataView(bytes);
      assert.equal(view.getUint32(4, true), bytes.byteLength - 8);
      assert.equal(view.getUint32(40, true), bytes.byteLength - 44);
      played++; queueMicrotask(() => this.onended());
    }
    pause() {}
  }
  const button = { innerHTML: '<svg></svg>', textContent: '', setAttribute() {}, classList: { toggle() {} } };
  const context = vm.createContext({ window: { addEventListener() {} }, Blob, ArrayBuffer, DataView, AbortController, Audio, queueMicrotask,
    URL: { createObjectURL(blob) { blobs.set('blob:test', blob); return 'blob:test'; }, revokeObjectURL() {} },
    fetch: async () => new Response(streamingWav(), { headers: { 'Content-Type': 'audio/wav' } }),
  });
  vm.runInContext(fs.readFileSync(new URL('../public/media.js', import.meta.url), 'utf8'), context);
  const media = context.window.createChatMedia({ onChange() {}, onTranscript() {}, notify: e => errors.push(e) });
  await media.speak('hello', button);
  assert.equal(played, 1, errors.join(','));
  assert.equal(button.textContent, '');
  assert.equal(button.innerHTML, '<svg></svg>');
});

test('speech unlocks audio during the click before waiting for synthesis', async () => {
  let unlocked = false, started = 0, closed = 0;
  class AudioContext {
    resume() { unlocked = true; return Promise.resolve(); }
    decodeAudioData() { return Promise.resolve({}); }
    createBufferSource() { const source = { connect() {}, start() { started++; queueMicrotask(() => source.onended()); }, stop() {} }; return source; }
    close() { closed++; return Promise.resolve(); }
  }
  const context = vm.createContext({ window: { AudioContext, addEventListener() {} }, Blob, ArrayBuffer, DataView, AbortController,
    fetch: async () => { assert.equal(unlocked, true, 'audio was not unlocked before the request'); return new Response(streamingWav(), { headers: { 'Content-Type': 'audio/wav' } }); },
  });
  vm.runInContext(fs.readFileSync(new URL('../public/media.js', import.meta.url), 'utf8'), context);
  const errors = [];
  const media = context.window.createChatMedia({ onChange() {}, onTranscript() {}, notify: e => errors.push(e) });
  await media.speak('hello', { setAttribute() {}, classList: { toggle() {} } });
  assert.equal(started, 1, errors.join(',')); assert.equal(closed, 1);
});

test('cancelling synthesis releases audio and never starts late playback', async () => {
  let resolveRequest, played = 0, closed = 0;
  class AudioContext {
    resume() { return Promise.resolve(); }
    decodeAudioData() { played++; return Promise.resolve({}); }
    close() { closed++; return Promise.resolve(); }
  }
  const context = vm.createContext({ window: { AudioContext, addEventListener() {} }, Blob, ArrayBuffer, DataView, AbortController,
    fetch: () => new Promise(resolve => { resolveRequest = resolve; }),
  });
  vm.runInContext(fs.readFileSync(new URL('../public/media.js', import.meta.url), 'utf8'), context);
  const media = context.window.createChatMedia({ onChange() {}, onTranscript() {}, notify() {} });
  const request = media.speak('hello', { setAttribute() {}, classList: { toggle() {} } });
  media.stopSpeech();
  resolveRequest(new Response(streamingWav(), { headers: { 'Content-Type': 'audio/wav' } }));
  await request;
  assert.equal(played, 0); assert.equal(closed, 1);
});
