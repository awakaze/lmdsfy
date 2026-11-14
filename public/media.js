/* Native DeepSeek file and speech tools. Keys stay in the Worker. */
window.createChatMedia = function ({ onChange, onTranscript, notify }) {
  let files = [];
  let recording = null;
  let starting = false;
  let speech = null;
  const MiB = 1024 * 1024;
  function changed() { onChange(files, Boolean(recording || starting)); }
  async function errorText(res) {
    const text = await res.text();
    try { const json = JSON.parse(text); return json.error?.message || json.message || text; } catch { return text; }
  }
  async function upload(list) {
    for (const file of list) {
      if (files.length >= 20) { notify('每次最多添加 20 个文件'); break; }
      const image = /\.(png|jpe?g|gif|webp)$/i.test(file.name);
      const document = /\.(pdf|docx?|pptx?|bmp|tiff?)$/i.test(file.name);
      const max = image ? 64 : document ? 95 : 32;
      if (file.size > max * MiB || !file.size) { notify(`${file.name}：文件需非空且不超过 ${max} MB`); continue; }
      const entry = { token: crypto.randomUUID(), name: file.name, size: file.size, image, status: '上传中', progress: 0 };
      files.push(entry); changed();
      const form = new FormData();
      form.append('purpose', document ? 'rich_layout_recognition' : 'user_data');
      form.append('expires_after[anchor]', 'created_at');
      form.append('expires_after[seconds]', '2592000');
      form.append('file', file);
      const xhr = new XMLHttpRequest();
      entry.cancel = () => xhr.abort();
      try {
        const result = await new Promise((resolve, reject) => {
          xhr.open('POST', '/api/files');
          xhr.timeout = 300000;
          xhr.upload.onprogress = e => { if (e.lengthComputable) entry.progress = Math.round(e.loaded / e.total * 100); entry.status = entry.progress === 100 ? '解析中' : '上传中'; changed(); };
          xhr.onload = () => {
            let data;
            try { data = JSON.parse(xhr.responseText); } catch { reject(new Error('上传服务返回异常')); return; }
            if (xhr.status < 200 || xhr.status >= 300 || !data.id) reject(new Error(data.error?.message || '上传失败'));
            else resolve(data);
          };
          xhr.onerror = () => reject(new Error('网络连接失败'));
          xhr.ontimeout = () => reject(new Error('解析超时，请重试'));
          xhr.onabort = () => reject(new DOMException('已取消', 'AbortError'));
          xhr.send(form);
        });
        entry.id = result.id; entry.status = '已就绪'; entry.expiresAt = result.expires_at;
      } catch (e) {
        if (e.name !== 'AbortError') { entry.status = '上传失败'; entry.error = e.message; notify(`${file.name}：${e.message}`); }
      } finally { delete entry.cancel; changed(); }
    }
  }
  function remove(token) { const f = files.find(f => f.token === token); files = files.filter(f => f.token !== token); f?.cancel?.(); changed(); }
  function take() {
    if (files.some(f => !f.id)) throw new Error('请等待文件解析完成，或移除失败的文件');
    const result = files.map(({ id, name, size, image, expiresAt }) => ({ id, name, size, image, expiresAt }));
    files = []; changed(); return result;
  }
  async function toggleRecording() {
    if (starting) return;
    if (recording) { await stopRecording(); return; }
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) { notify('当前浏览器不支持录音，请使用最新版 Chrome、Edge 或 Safari'); return; }
    starting = true; changed();
    let stream, context;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      context = new AudioContext({ sampleRate: 16000 });
      await context.resume();
      await context.audioWorklet.addModule('/recorder-worklet.js');
      const source = context.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(context, 'pcm-recorder');
      const gain = context.createGain(); gain.gain.value = 0;
      const state = { stream, context, node, source, gain, chunks: [], samples: 0, timer: null };
      node.port.onmessage = ({ data }) => { state.chunks.push(data); state.samples += data.length; };
      source.connect(node); node.connect(gain); gain.connect(context.destination);
      recording = state;
      state.timer = setTimeout(() => stopRecording(), 119000);
      notify('正在录音，再次点击麦克风结束（最长 2 分钟）');
    } catch (e) {
      stream?.getTracks().forEach(t => t.stop()); await context?.close();
      notify(e.name === 'NotAllowedError' ? '未获得麦克风权限，请在浏览器设置中允许后重试' : '无法开始录音：' + e.message);
    } finally { starting = false; changed(); }
  }
  async function stopRecording() {
    const state = recording;
    if (!state) return;
    recording = null; starting = true; changed(); clearTimeout(state.timer);
    state.source.disconnect(); state.node.disconnect(); state.gain.disconnect();
    state.stream.getTracks().forEach(t => t.stop());
    try {
      const wav = encodeWav(state.chunks, state.samples, state.context.sampleRate);
      await state.context.close();
      if (state.samples < 1600) throw new Error('录音太短，请再试一次');
      const form = new FormData(); form.append('file', wav, 'speech.wav');
      notify('正在识别语音…');
      const res = await fetch('/api/transcribe', { method: 'POST', body: form });
      if (!res.ok) throw new Error(await errorText(res));
      const data = await res.json();
      if (typeof data.text !== 'string' || !data.text.trim()) throw new Error('未识别到文字');
      onTranscript(data.text); notify('识别完成，可修改后发送');
    } catch (e) { notify('语音识别失败：' + e.message); }
    finally { starting = false; changed(); }
  }
  function stopSpeech() {
    if (!speech) return;
    speech.controller.abort(); speech.audio?.pause(); speech.finish?.();
    if (speech.url) URL.revokeObjectURL(speech.url);
    speech.button.textContent = '朗读'; speech = null;
  }
  async function speak(text, button) {
    if (speech?.button === button) { stopSpeech(); return; }
    stopSpeech();
    const state = { controller: new AbortController(), button, audio: null, url: null };
    speech = state; button.textContent = '停止朗读';
    // Split long replies below the API's 10,000 billed-character limit.
    const chars = Array.from(text);
    try {
      for (let i = 0; i < chars.length; i += 4000) {
        const res = await fetch('/api/speech', { method: 'POST', signal: state.controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: chars.slice(i, i + 4000).join('') }) });
        if (!res.ok) throw new Error(await errorText(res));
        const blob = await res.blob();
        if (state.controller.signal.aborted) break;
        state.url = URL.createObjectURL(blob); state.audio = new Audio(state.url);
        await new Promise((resolve, reject) => {
          state.finish = resolve;
          state.audio.onended = resolve;
          state.audio.onerror = () => reject(new Error('音频播放失败'));
          state.audio.play().catch(reject);
        });
        URL.revokeObjectURL(state.url); state.url = null;
        if (state.controller.signal.aborted) break;
      }
    } catch (e) { if (e.name !== 'AbortError') notify('朗读失败：' + e.message); }
    finally { if (speech === state) stopSpeech(); }
  }
  window.addEventListener('pagehide', () => { stopSpeech(); if (recording) { recording.stream.getTracks().forEach(t => t.stop()); recording.context.close(); } files.forEach(f => f.cancel?.()); });
  return { upload, remove, take, toggleRecording, speak, stopSpeech, get pending() { return files; }, get active() { return Boolean(recording || starting); } };
};

function encodeWav(chunks, samples, sampleRate) {
  const bytes = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(bytes);
  const str = (offset, text) => Array.from(text).forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  str(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, samples * 2, true);
  let offset = 44;
  for (const chunk of chunks) for (const value of chunk) { const n = Math.max(-1, Math.min(1, value)); view.setInt16(offset, n < 0 ? n * 32768 : n * 32767, true); offset += 2; }
  return new Blob([bytes], { type: 'audio/wav' });
}
