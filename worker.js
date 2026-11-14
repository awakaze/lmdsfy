/** Cloudflare Worker: DeepSeek 原生网页工具及流式聊天。 */
import { handleMedia } from './media-worker.js';

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
    if (['/api/files', '/api/transcribe', '/api/speech'].includes(url.pathname)) {
      return handleMedia(request, env, url.pathname);
    }

    // 其余路径：交给静态资源（public/ 目录）
    return env.ASSETS.fetch(request);
  },
};

async function handleChat(request, env) {
  const url = new URL(request.url);
  if (!['GET', 'POST'].includes(request.method)) return text('不支持的请求方法', 405);

  // 入参：POST JSON body（多轮，带完整历史）或 GET ?q=（单轮）
  let payload;
  if (request.method === 'POST') {
    try {
      payload = await request.json();
    } catch (e) {
      return text('请求体不是合法 JSON', 400);
    }
  } else if (request.method === 'GET') {
    payload = { q: url.searchParams.get('q') || '' };
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return text('请求体必须是对象', 400);

  // 深度思考 / 智能搜索开关：body 布尔值，或 query 的 ?think=true / ?search=true
  const think = payload.think === true || url.searchParams.get('think') === 'true';
  const search = payload.search === true || url.searchParams.get('search') === 'true';

  // 只取 user/assistant 的纯文本；思考链（reasoning）不回传给模型
  let history = [];
  if (Array.isArray(payload.messages)) {
    history = payload.messages
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
      .map((m) => {
        const content = m.role === 'user' && Array.isArray(m.content)
          ? m.content.filter(p => p && ((p.type === 'text' && typeof p.text === 'string') || (p.type === 'file' && typeof p.file_id === 'string' && /^file-api-[\w-]+$/.test(p.file_id)))).map(p => p.type === 'file' ? { type: 'file', file_id: p.file_id } : { type: 'text', text: p.text })
          : typeof m.content === 'string' ? m.content : '';
        return { role: m.role, content, ...(m.role === 'assistant' && Array.isArray(m.server_tool_calls) ? { server_tool_calls: m.server_tool_calls } : {}) };
      }).filter(m => m.content.length);
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

  let upstream;
  try { upstream = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      stream: true,
      tools: [...(search ? [{ type: "deepseek_web_search" }] : []), { type: "deepseek_read_url" }],
      title: { enabled: true },
      safety_check: { level: "high" },
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        ...history,
      ],
      // 深度思考开关：显式启用/禁用（DeepSeek 默认开启思考）
      thinking: { type: think ? 'enabled' : 'disabled' },
    }),
    signal: request.signal,
  }); } catch (error) {
    return text('连接 DeepSeek 失败，请稍后重试', 502);
  }

  if (!upstream.ok) {
    const errText = await upstream.text();
    return text(`DeepSeek 接口错误 (${upstream.status}): ${errText}`, upstream.status);
  }

  const headers = new Headers(CORS);
  headers.set('Content-Type', 'text/event-stream; charset=utf-8');
  headers.set('Cache-Control', 'no-cache');
  headers.set('Connection', 'keep-alive');

  return new Response(upstream.body, { status: 200, headers });
}
