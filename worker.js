/**
 * lmds —— 让我帮你 DeepSeek 一下
 * Cloudflare Worker：转发对话消息到 DeepSeek API 并流式回传，前端同时托管静态页面。
 *
 * 路由：
 *   GET  /                    -> 返回 DeepSeek 风格前端页面（静态资源）
 *   POST /api/chat            -> body 传 { messages, think }，多轮对话，SSE 流式回传
 *   GET  /api/chat?q=xxx      -> 单轮问答（兼容直链）
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function text(body, status = 200) {
  return new Response(body, {
    status,
    headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

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

  // 入参：POST JSON body（多轮，带完整历史）或 GET ?q=（单轮）
  let payload;
  if (request.method === 'POST') {
    try {
      payload = await request.json();
    } catch (e) {
      return text('请求体不是合法 JSON', 400);
    }
  } else {
    payload = { q: url.searchParams.get('q') || '' };
  }

  // 深度思考开关：body 的 think 布尔值，或 query 的 ?think=true
  const think = payload.think === true || url.searchParams.get('think') === 'true';

  // 只取 user/assistant 的纯文本；思考链（reasoning）不回传给模型
  let history = [];
  if (Array.isArray(payload.messages)) {
    history = payload.messages
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content)
      .map((m) => ({ role: m.role, content: m.content }));
  } else {
    const q = String(payload.q || '').trim();
    if (q) history = [{ role: 'user', content: q }];
  }

  if (!history.length) {
    return text('缺少消息内容', 400);
  }

  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return text('服务端未配置 DEEPSEEK_API_KEY（请用 wrangler secret put 注入）', 500);
  }

  const baseUrl = (env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
  // deepseek-flash 即 DeepSeek-V4.1-Flash（2026-09 官方推荐模型名）
  const model = env.DEEPSEEK_MODEL || 'deepseek-flash';
  const systemPrompt = env.SYSTEM_PROMPT || '你是由深度求索公司创造的 AI 助手。请热情、准确、清晰地帮助用户解答问题。';

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
        ...history,
      ],
      // 深度思考开关：显式启用/禁用（DeepSeek 默认开启思考）
      thinking: { type: think ? 'enabled' : 'disabled' },
    }),
  });

  if (!upstream.ok) {
    const errText = await upstream.text();
    return text(`DeepSeek 接口错误 (${upstream.status}): ${errText}`, upstream.status);
  }

  const headers = new Headers(CORS);
  headers.set('Content-Type', 'text/event-stream; charset=utf-8');
  headers.set('Cache-Control', 'no-cache');
  headers.set('Connection', 'keep-alive');

  // 直接把 DeepSeek 的 SSE 流透传给前端
  return new Response(upstream.body, { status: 200, headers });
}