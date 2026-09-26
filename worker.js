/**
 * lmds —— 让我帮你 DeepSeek 一下
 * Cloudflare Worker：转发 ?q= 到 DeepSeek API 并流式回传，前端同时托管静态页面。
 *
 * 路由：
 *   GET /           -> 返回 DeepSeek 风格前端页面（静态资源）
 *   GET /api/chat?q=xxx -> 把 xxx 作为用户消息调 DeepSeek，SSE 流式回传
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === '/api/chat') {
      return handleChat(request, env);
    }

    // 其余路径：交给静态资源（public/ 目录）
    return env.ASSETS.fetch(request);
  },
};

async function handleChat(request, env) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();

  if (!q) {
    return new Response('缺少 q 参数', {
      status: 400,
      headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return new Response('服务端未配置 DEEPSEEK_API_KEY（请用 wrangler secret put 注入）', {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const baseUrl = (env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
  // deepseek-flash 即 DeepSeek-V4.1-Flash（2026-09 官方推荐模型名）
  const model = env.DEEPSEEK_MODEL || 'deepseek-flash';
  const systemPrompt = env.SYSTEM_PROMPT || '你是由深度求索公司创造的 AI 助手。请热情、准确、清晰地帮助用户解答问题。';

  // 深度思考开关：?think=true 时启用；否则显式禁用（DeepSeek 默认开启思考）
  const think = url.searchParams.get('think') === 'true';

  const upstream = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: q },
      ],
      thinking: { type: think ? 'enabled' : 'disabled' },
    }),
  });

  if (!upstream.ok) {
    const errText = await upstream.text();
    return new Response(`DeepSeek 接口错误 (${upstream.status}): ${errText}`, {
      status: upstream.status,
      headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const headers = new Headers(CORS);
  headers.set('Content-Type', 'text/event-stream; charset=utf-8');
  headers.set('Cache-Control', 'no-cache');
  headers.set('Connection', 'keep-alive');

  // 直接把 DeepSeek 的 SSE 流透传给前端
  return new Response(upstream.body, { status: 200, headers });
}