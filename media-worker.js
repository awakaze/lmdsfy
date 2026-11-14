// Keep uploads streaming: buffering large documents can exceed Worker memory.
export function isTtsEnabled(env) {
  return env.TTS_ENABLED !== 'false' && env.TTS_ENABLED !== false;
}

export async function handleMedia(request, env, pathname) {
  if (request.method !== 'POST') return new Response('不支持的请求方法', { status: 405 });
  if (pathname === '/api/speech' && !isTtsEnabled(env)) {
    return new Response('当前部署已关闭朗读功能', { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }
  if (!env.DEEPSEEK_API_KEY) return new Response('服务端未配置 DeepSeek 密钥', { status: 503 });
  const base = (env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
  const root = base.replace(/\/v1$/, '');
  const headers = new Headers({ Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` });
  let body;
  let endpoint;
  if (pathname === '/api/speech') {
    let data;
    try { data = await request.json(); } catch { return new Response('请求格式错误', { status: 400 }); }
    if (!data || typeof data.text !== 'string' || !data.text.trim() || new TextEncoder().encode(data.text).length > 60000) {
      return new Response('朗读文本为空或过长', { status: 400 });
    }
    const billed = Array.from(data.text).reduce((n, c) => n + (/\p{Script=Han}/u.test(c) ? 2 : 1), 0);
    if (billed > 10000) return new Response('单次朗读最多支持约 5000 个汉字，请选取较短的内容', { status: 400 });
    body = JSON.stringify({ text: data.text, voice_id: data.voice === 'tide' ? 'tide' : 'stella', format: 'wav', filter_markdown: true });
    headers.set('Content-Type', 'application/json');
    endpoint = `${root}/v1/tools/tts`;
  } else {
    const contentType = request.headers.get('Content-Type') || '';
    if (!contentType.startsWith('multipart/form-data;')) return new Response('请使用文件上传格式', { status: 400 });
    const limit = (pathname === '/api/transcribe' ? 8 : 100) * 1024 * 1024 + 65536;
    if (Number(request.headers.get('Content-Length')) > limit) return new Response('文件过大', { status: 413 });
    if (!request.body) return new Response('文件内容为空', { status: 400 });
    let bytes = 0;
    body = request.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > limit) throw new Error('文件过大');
        controller.enqueue(chunk);
      },
    }));
    headers.set('Content-Type', contentType);
    endpoint = pathname === '/api/files' ? `${base}/files` : `${root}/v1/tools/asr`;
  }
  try {
    const upstream = await fetch(endpoint, { method: 'POST', headers, body, signal: request.signal, duplex: 'half' });
    const responseHeaders = new Headers({ 'Content-Type': upstream.headers.get('Content-Type') || 'application/json', 'Cache-Control': 'no-store' });
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch {
    return new Response('上传或语音服务连接失败，请重试', { status: 502 });
  }
}
