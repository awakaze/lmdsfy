/**
 * lmds —— 让我帮你 DeepSeek 一下
 * Cloudflare Worker：转发对话消息到 DeepSeek API 并流式回传，前端同时托管静态页面。
 *
 * 路由：
 *   GET  /                    -> 返回 DeepSeek 风格前端页面（静态资源）
 *   POST /api/chat            -> body 传 { messages, think, search }，多轮对话，SSE 流式回传
 *   GET  /api/chat?q=xxx      -> 单轮问答（兼容直链）
 *
 * 智能搜索：search 开启时先调 DeepSeek Search API（/v1/tools/search，与聊天共用
 * 同一 Bearer Key）检索实时网页，把结果注入 system 上下文后再请求对话；来源列表
 * 会作为一条自定义 SSE 事件（lmds_search）先行下发，供前端渲染来源卡片。
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

  // 深度思考 / 智能搜索开关：body 布尔值，或 query 的 ?think=true / ?search=true
  const think = payload.think === true || url.searchParams.get('think') === 'true';
  const search = payload.search === true || url.searchParams.get('search') === 'true';

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

  // 智能搜索：取最后一条 user 消息作为搜索词，调 DeepSeek Search API（失败则降级为普通对话）
  let searchResults = [];
  let searchQuery = '';
  if (search) {
    const lastUser = history.slice().reverse().find((m) => m.role === 'user');
    searchQuery = lastUser ? lastUser.content.replace(/\s+/g, ' ').trim().slice(0, 128) : '';
    if (searchQuery) searchResults = await webSearch(baseUrl, apiKey, searchQuery);
  }

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
        {
          role: 'system',
          content: searchResults.length
            ? `${systemPrompt}\n\n${buildSearchContext(searchQuery, searchResults)}`
            : systemPrompt,
        },
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

  // 搜索开启时，先把来源列表作为一条自定义 SSE 事件下发，再透传 DeepSeek 的流。
  // 注意：write 必须放在返回 Response 之后的异步泵里 —— 无读者时 write 会因背压
  // 永久挂起，若在返回前 await 会造成死锁。
  if (search) {
    const sources = searchResults.map((r) => ({
      title: r.title || '',
      url: r.url || '',
      site_name: r.site_name || null,
      site_icon: r.site_icon || null,
      snippet: r.snippet || '',
      date: r.date || null,
    }));
    const { readable, writable } = new TransformStream();
    (async () => {
      const writer = writable.getWriter();
      try {
        await writer.write(new TextEncoder().encode(`data: ${JSON.stringify({ lmds_search: { query: searchQuery, results: sources } })}\n\n`));
        writer.releaseLock();
        await upstream.body.pipeTo(writable);
      } catch (e) {
        // 客户端提前断开等场景：中止写入端，避免管道悬挂
        try { await writer.abort(e); } catch (_) {}
      }
    })();
    return new Response(readable, { status: 200, headers });
  }

  // 直接把 DeepSeek 的 SSE 流透传给前端
  return new Response(upstream.body, { status: 200, headers });
}

// 调 DeepSeek Search API 检索网页（与聊天接口共用同一 Key / Base URL）
async function webSearch(baseUrl, apiKey, query) {
  try {
    const res = await fetch(`${baseUrl}/v1/tools/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ query, count: 8, ori_question: query, need_content: false }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.results) ? data.results : [];
  } catch (e) {
    return [];
  }
}

// 把搜索结果整理成注入 system 的上下文（summary 为官方提供的「给模型阅读」的长摘要）
function buildSearchContext(query, results) {
  const lines = results.map((r, i) => {
    const site = r.site_name ? `（来源：${r.site_name}）` : '';
    const date = r.date ? `，发布于 ${String(r.date).slice(0, 10)}` : '';
    const abstract = String(r.summary || r.snippet || '').replace(/\s+/g, ' ').trim();
    return `[${i + 1}] ${r.title || ''}${site}${date}\n链接：${r.url || ''}\n摘要：${abstract}`;
  });
  return [
    `你已具备联网搜索能力。以下是针对用户问题「${query}」的实时网页搜索结果（检索于 ${new Date().toISOString().slice(0, 10)}）：`,
    '',
    ...lines,
    '',
    '请优先依据以上搜索结果回答用户的问题，注意：',
    '- 引用某条结果的信息时，在句末用对应编号标注来源，如 [1]、[2]；',
    '- 若搜索结果与问题无关，可忽略它们并按你自己的知识回答。',
  ].join('\n');
}