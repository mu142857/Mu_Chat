/**
 * api.js — 浏览器直连大模型 API（Anthropic 协议 + OpenAI 兼容协议）。
 * 只依赖 prompts.js；输入纯数据，输出结构化结果或类型化错误，不碰 DOM 和 storage。
 */

import {
  buildReplySystemPrompt,
  buildReplyUserMessage,
  buildSummarySystemPrompt,
  buildSummaryUserMessage,
} from './prompts.js';

const TIMEOUT_MS = 60_000;

/**
 * 服务商预设。protocol 决定请求格式：
 * - 'openai'    → POST {baseUrl}/chat/completions，Authorization: Bearer
 * - 'anthropic' → POST {baseUrl}/v1/messages，x-api-key + 浏览器直连头
 * 注意：豆包（火山方舟）不允许浏览器跨域，纯前端应用无法直连，故不在列表中。
 */
export const PROVIDER_PRESETS = [
  { id: 'deepseek', name: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-chat' },
  { id: 'zhipu', name: '智谱 GLM', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-4.6' },
  { id: 'kimi', name: 'Kimi（月之暗面）', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1', defaultModel: 'kimi-latest' },
  { id: 'qwen', name: '通义千问', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-plus' },
  { id: 'openai', name: 'OpenAI（GPT）', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-5-mini' },
  { id: 'anthropic', name: 'Claude（Anthropic）', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', defaultModel: 'claude-sonnet-4-6' },
  { id: 'custom', name: '自定义（OpenAI 兼容）', protocol: 'openai', baseUrl: '', defaultModel: '' },
];

export class ApiError extends Error {
  constructor(kind, userMessage, { retryAfter } = {}) {
    super(userMessage);
    this.kind = kind;             // no_key|auth|forbidden|not_found|bad_request|too_large|rate_limit|server|network|timeout|truncated|refusal
    this.userMessage = userMessage;
    this.retryAfter = retryAfter;
  }
}

/* ---------- 底层调用 ---------- */

async function callModel({ system, userMessage, settings, maxTokens }) {
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
  // 输出本身很短，用服务商默认值即可
  const body = isAnthropic
    ? {
        model: settings.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: userMessage }],
      }
    : {
        model: settings.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userMessage },
        ],
      };

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
    const body = await resp.json();
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
      return new ApiError('bad_request', '请求无效：' + (serverMsg || '请检查设置'));
    case 413:
      return new ApiError('too_large', '对话内容太长了，删掉一些早期消息再试');
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

/* ---------- 对外接口 ---------- */

/**
 * 生成回复候选。
 * 成功: {parsed:true, situationRead, candidates:[{intent, messages:[...]}]}
 * 格式兜底: {parsed:false, raw}
 * 失败抛 ApiError
 */
export async function generateReply({ persona, messages, opinion, settings }) {
  const text = await callModel({
    system: buildReplySystemPrompt(),
    userMessage: buildReplyUserMessage({ persona, messages, opinion }),
    settings,
    maxTokens: 4096,
  });

  const obj = parseModelJson(text);
  if (!obj) return { parsed: false, raw: text };

  const situationRead = typeof obj.situation_read === 'string' ? obj.situation_read : '';
  const rawCandidates = Array.isArray(obj.candidates) ? obj.candidates : [];
  const candidates = rawCandidates
    .map((c) => ({
      intent: typeof c.intent === 'string' && c.intent.trim() ? c.intent.trim() : '候选',
      messages: Array.isArray(c.messages)
        ? c.messages.filter((m) => typeof m === 'string' && m.trim()).map((m) => m.trim())
        : [],
    }))
    .filter((c) => c.messages.length > 0);

  if (!candidates.length) return { parsed: false, raw: text };
  return { parsed: true, situationRead, candidates };
}

/**
 * 总结对话为要点。
 * 成功: {parsed:true, points:[...]}；格式兜底: {parsed:false, raw}；失败抛 ApiError
 */
export async function summarizeConversation({ persona, messages, settings }) {
  const text = await callModel({
    system: buildSummarySystemPrompt(),
    userMessage: buildSummaryUserMessage({ persona, messages }),
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
