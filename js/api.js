/**
 * api.js — 浏览器直连大模型 API（Anthropic 协议 + OpenAI 兼容协议）。
 * 只依赖 prompts.js；输入纯数据，输出结构化结果或类型化错误，不碰 DOM 和 storage。
 */

import {
  buildChatSystemPrompt,
  buildSummarySystemPrompt,
  buildSummaryUserMessage,
} from './prompts.js';

const TIMEOUT_MS = 60_000;       // 非流式请求的整体超时
const IDLE_TIMEOUT_MS = 90_000;  // 流式请求两次数据之间的最长间隔

/**
 * 服务商预设。protocol 决定请求格式：
 * - 'openai'    → POST {baseUrl}/chat/completions，Authorization: Bearer
 * - 'anthropic' → POST {baseUrl}/v1/messages，x-api-key + 浏览器直连头
 * 注意：豆包（火山方舟）不允许浏览器跨域，纯前端应用无法直连，故不在列表中。
 */
export const PROVIDER_PRESETS = [
  {
    id: 'deepseek', name: 'DeepSeek', protocol: 'openai',
    baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-chat',
    models: [
      { id: 'deepseek-chat', note: '快、便宜，日常够用' },
      { id: 'deepseek-reasoner', note: '会先想再答，复杂局面更稳，慢' },
    ],
  },
  {
    id: 'zhipu', name: '智谱 GLM', protocol: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-4.6',
    models: [
      { id: 'glm-4.6', note: '主力，中文语感好' },
      { id: 'glm-4.5-air', note: '轻量版，更快更便宜' },
    ],
  },
  {
    id: 'kimi', name: 'Kimi（月之暗面）', protocol: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1', defaultModel: 'kimi-latest',
    models: [
      { id: 'kimi-latest', note: '官方最新，跟着升级' },
      { id: 'kimi-k2-0905-preview', note: 'K2，长文和推理更强' },
    ],
  },
  {
    id: 'qwen', name: '通义千问', protocol: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-plus',
    models: [
      { id: 'qwen-plus', note: '均衡主力' },
      { id: 'qwen-max', note: '最强一档，贵且慢' },
      { id: 'qwen-turbo', note: '最快最便宜，语气糙' },
    ],
  },
  {
    id: 'openai', name: 'OpenAI（GPT）', protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-5-mini',
    models: [
      { id: 'gpt-5-mini', note: '性价比主力' },
      { id: 'gpt-5', note: '最强，分寸感好，贵' },
      { id: 'gpt-5-nano', note: '最便宜，只适合简单场合' },
    ],
  },
  {
    id: 'gemini', name: 'Gemini（Google）', protocol: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultModel: 'gemini-2.5-pro',
    models: [
      { id: 'gemini-2.5-pro', note: '推荐：拿捏潜台词和分寸' },
      { id: 'gemini-3-pro-preview', note: '最强一档，preview 配额紧' },
      { id: 'gemini-2.5-flash', note: '快且免费额度友好，语气偏套路' },
      { id: 'gemini-2.5-flash-lite', note: '最快最省，只适合简单场合' },
    ],
  },
  {
    id: 'anthropic', name: 'Claude（Anthropic）', protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com', defaultModel: 'claude-sonnet-4-6',
    models: [
      { id: 'claude-sonnet-4-6', note: '均衡，中文分寸感稳' },
      { id: 'claude-sonnet-5', note: '新一代均衡款' },
      { id: 'claude-opus-5', note: '最强一档，复杂人际局面首选' },
      { id: 'claude-haiku-4-5-20251001', note: '最快最省' },
    ],
  },
  { id: 'custom', name: '自定义（OpenAI 兼容）', protocol: 'openai', baseUrl: '', defaultModel: '', models: [] },
];

export class ApiError extends Error {
  constructor(kind, userMessage, { retryAfter } = {}) {
    super(userMessage);
    this.kind = kind;             // no_key|auth|forbidden|not_found|bad_request|too_large|rate_limit|server|network|timeout|truncated|refusal|aborted
    this.userMessage = userMessage;
    this.retryAfter = retryAfter;
  }
}

/* ---------- 公共校验与请求参数 ---------- */

function validateSettings(settings) {
  if (!settings.apiKey) {
    throw new ApiError('no_key', '请先设置 API Key');
  }
  if (!settings.model || !settings.model.trim()) {
    throw new ApiError('bad_request', '请先到设置里填写模型名称');
  }
  const base = (settings.baseUrl || '').replace(/\/+$/, '');
  if (!base) {
    throw new ApiError('bad_request', '请先到设置里填写接口地址');
  }
  return base;
}

function buildRequestParts({ base, settings, system, messages, maxTokens, stream }) {
  const isAnthropic = settings.provider === 'anthropic';
  const url = isAnthropic ? `${base}/v1/messages` : `${base}/chat/completions`;
  const headers = isAnthropic
    ? {
        'content-type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      }
    : {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + settings.apiKey,
      };
  // OpenAI 兼容协议不传输出上限：各家参数名不一致（max_tokens / max_completion_tokens），
  // 用服务商默认值即可
  const body = isAnthropic
    ? { model: settings.model, max_tokens: maxTokens, system, messages, stream }
    : { model: settings.model, messages: [{ role: 'system', content: system }, ...messages], stream };
  if (!stream) delete body.stream;
  return { isAnthropic, url, headers, body };
}

/** 相邻同角色消息合并（生成失败重发时会出现连续 user，Anthropic 协议要求交替） */
function normalizeChatMessages(chat) {
  const out = [];
  for (const m of chat) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const content = String(m.content || '').trim();
    if (!content) continue;
    const last = out[out.length - 1];
    if (last && last.role === role) {
      last.content += '\n\n' + content;
    } else {
      out.push({ role, content });
    }
  }
  return out;
}

/* ---------- 非流式调用（总结用） ---------- */

async function callOnce({ system, userMessage, settings, maxTokens }) {
  const base = validateSettings(settings);
  const { isAnthropic, url, headers, body } = buildRequestParts({
    base, settings, system, maxTokens,
    messages: [{ role: 'user', content: userMessage }],
    stream: false,
  });

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers,
      body: JSON.stringify(body),
    });
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new ApiError('timeout', '请求超时，请重试');
    }
    throw new ApiError('network', '网络连接失败（或该服务商不允许浏览器直连），请检查后重试');
  }

  if (!resp.ok) {
    throw await classifyHttpError(resp);
  }

  let data;
  try {
    data = await resp.json();
  } catch {
    throw new ApiError('server', '模型返回了无法解析的响应，请重试');
  }

  return isAnthropic ? extractAnthropicText(data) : extractOpenAIText(data);
}

function extractAnthropicText(data) {
  if (data.stop_reason === 'refusal') {
    throw new ApiError('refusal', '模型拒绝了这次请求，请调整内容后重试');
  }
  // 不盲取 content[0]：换新模型后第一块可能是 thinking block
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  if (data.stop_reason === 'max_tokens') {
    throw new ApiError('truncated', '输出被截断了，请重试');
  }
  if (!text.trim()) {
    throw new ApiError('server', '模型没有返回文本内容，请重试');
  }
  return text;
}

function extractOpenAIText(data) {
  const choice = data.choices && data.choices[0];
  const text = choice && choice.message && typeof choice.message.content === 'string'
    ? choice.message.content
    : '';
  if (choice && choice.finish_reason === 'length' && !text.trim()) {
    throw new ApiError('truncated', '输出被截断了，请重试');
  }
  if (!text.trim()) {
    throw new ApiError('server', '模型没有返回文本内容，请重试');
  }
  return text;
}

async function classifyHttpError(resp) {
  let serverMsg = '';
  try {
    let body = await resp.json();
    // Gemini 的错误体是数组包着 error，其余家是对象
    if (Array.isArray(body)) body = body[0];
    serverMsg = body && body.error && body.error.message ? body.error.message : '';
  } catch { /* 忽略 */ }

  switch (resp.status) {
    case 401:
      return new ApiError('auth', 'API Key 无效或已被撤销');
    case 403:
      return new ApiError('forbidden', '这个 API Key 没有权限使用该模型');
    case 404:
      return new ApiError('not_found', '模型名不存在，请到设置里检查模型名称');
    case 400:
      // Gemini 把「key 不对」也报成 400，归到 auth 才不会误导
      if (/api.?key/i.test(serverMsg)) {
        return new ApiError('auth', 'API Key 无效或已被撤销');
      }
      return new ApiError('bad_request', '请求无效：' + (serverMsg || '请检查设置'));
    case 413:
      return new ApiError('too_large', '对话内容太长了，点「新对话」开一段吧');
    case 429: {
      const retryAfter = parseInt(resp.headers.get('retry-after'), 10) || 30;
      return new ApiError('rate_limit', `请求太频繁，请 ${retryAfter} 秒后再试`, { retryAfter });
    }
    default:
      if (resp.status >= 500) {
        return new ApiError('server', '模型服务暂时不可用，请稍后重试');
      }
      return new ApiError('server', `请求失败（${resp.status}）${serverMsg ? '：' + serverMsg : '，请重试'}`);
  }
}

/* ---------- SSE 读取 ---------- */

async function readSSE(resp, onData, onActivity) {
  let buf = '';
  let finished = false;

  const handleLine = (rawLine) => {
    if (finished) return;
    const line = rawLine.replace(/\r$/, '');
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    if (payload === '[DONE]') { finished = true; return; }
    let obj;
    try { obj = JSON.parse(payload); } catch { return; }
    onData(obj);
  };

  const feed = (chunk, flush) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      handleLine(buf.slice(0, idx));
      buf = buf.slice(idx + 1);
    }
    if (flush && buf) { handleLine(buf); buf = ''; }
  };

  if (!resp.body || !resp.body.getReader) {
    feed(await resp.text(), true);
    return;
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (onActivity) onActivity();
    feed(decoder.decode(value, { stream: true }));
    if (finished) {
      try { await reader.cancel(); } catch { /* 忽略 */ }
      break;
    }
  }
  feed(decoder.decode(), true);
}

/* ---------- 对外接口 ---------- */

/**
 * 流式生成参谋回复。
 * onDelta(fullText) 在每次有新内容时以"目前的完整文本"回调；
 * abortSignal 由调用方提供，用于"停止"按钮（中止后抛 kind='aborted' 的 ApiError，
 * 调用方可用自己在 onDelta 里攒下的部分文本兜底）。
 * 成功返回 {text, truncated}。
 */
export async function streamChat({ persona, memes, me, chat, settings, onDelta, abortSignal }) {
  const base = validateSettings(settings);
  const { isAnthropic, url, headers, body } = buildRequestParts({
    base, settings,
    system: buildChatSystemPrompt(persona, memes, me),
    messages: normalizeChatMessages(chat),
    maxTokens: 8192,
    stream: true,
  });

  const ctrl = new AbortController();
  let abortReason = '';
  const abortAs = (reason) => { abortReason = reason; ctrl.abort(); };
  const onUserAbort = () => abortAs('user');
  if (abortSignal) {
    if (abortSignal.aborted) throw new ApiError('aborted', '已停止');
    abortSignal.addEventListener('abort', onUserAbort, { once: true });
  }
  let idleTimer = setTimeout(() => abortAs('timeout'), IDLE_TIMEOUT_MS);
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => abortAs('timeout'), IDLE_TIMEOUT_MS);
  };

  const abortError = () =>
    abortReason === 'user'
      ? new ApiError('aborted', '已停止')
      : new ApiError('timeout', '模型响应超时，请重试');

  try {
    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        signal: ctrl.signal,
        headers,
        body: JSON.stringify(body),
      });
    } catch (e) {
      if (ctrl.signal.aborted) throw abortError();
      throw new ApiError('network', '网络连接失败（或该服务商不允许浏览器直连），请检查后重试');
    }

    if (!resp.ok) {
      throw await classifyHttpError(resp);
    }

    let text = '';
    let stopReason = '';
    let streamError = null;

    const handleData = (obj) => {
      if (streamError) return;
      if (isAnthropic) {
        if (obj.type === 'content_block_delta' && obj.delta && obj.delta.type === 'text_delta') {
          text += obj.delta.text;
          if (onDelta) onDelta(text);
        } else if (obj.type === 'message_delta' && obj.delta && obj.delta.stop_reason) {
          stopReason = obj.delta.stop_reason;
        } else if (obj.type === 'error') {
          streamError = new ApiError('server',
            '模型服务出错：' + ((obj.error && obj.error.message) || '请重试'));
        }
      } else {
        if (obj.error) {
          streamError = new ApiError('server',
            '模型服务出错：' + (obj.error.message || '请重试'));
          return;
        }
        const choice = obj.choices && obj.choices[0];
        if (!choice) return;
        const delta = choice.delta && choice.delta.content;
        if (typeof delta === 'string' && delta) {
          text += delta;
          if (onDelta) onDelta(text);
        }
        if (choice.finish_reason) stopReason = choice.finish_reason;
      }
    };

    try {
      await readSSE(resp, handleData, resetIdle);
    } catch (e) {
      if (ctrl.signal.aborted) throw abortError();
      throw new ApiError('network', '连接中断，请重试');
    }

    if (streamError) throw streamError;
    if (stopReason === 'refusal') {
      throw new ApiError('refusal', '模型拒绝了这次请求，请调整内容后重试');
    }
    if (!text.trim()) {
      throw new ApiError('server', '模型没有返回文本内容，请重试');
    }
    return { text, truncated: stopReason === 'max_tokens' || stopReason === 'length' };
  } finally {
    clearTimeout(idleTimer);
    if (abortSignal) abortSignal.removeEventListener('abort', onUserAbort);
  }
}

/**
 * 总结咨询对话为要点。
 * 成功: {parsed:true, points:[...]}；格式兜底: {parsed:false, raw}；失败抛 ApiError
 */
export async function summarizeConversation({ persona, chat, settings }) {
  const text = await callOnce({
    system: buildSummarySystemPrompt(),
    userMessage: buildSummaryUserMessage({ persona, chat }),
    settings,
    maxTokens: 2048,
  });

  const obj = parseModelJson(text);
  if (obj && Array.isArray(obj.points)) {
    const points = obj.points.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim());
    if (points.length) return { parsed: true, points };
  }
  return { parsed: false, raw: text };
}

/* ---------- JSON 解析兜底链 ---------- */

function parseModelJson(text) {
  const t = text.trim();
  // 1) 直接 parse
  try { return JSON.parse(t); } catch { /* 继续 */ }
  // 2) 剥 Markdown 围栏
  const fenced = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch { /* 继续 */ }
  }
  // 3) 截取首 { 到末 }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch { /* 继续 */ }
  }
  return null;
}
