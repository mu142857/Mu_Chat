/**
 * api.js — 浏览器直连 Anthropic API。
 * 只依赖 prompts.js；输入纯数据，输出结构化结果或类型化错误，不碰 DOM 和 storage。
 */

import {
  buildReplySystemPrompt,
  buildReplyUserMessage,
  buildSummarySystemPrompt,
  buildSummaryUserMessage,
} from './prompts.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const TIMEOUT_MS = 60_000;

export class ApiError extends Error {
  constructor(kind, userMessage, { retryAfter } = {}) {
    super(userMessage);
    this.kind = kind;             // no_key|auth|forbidden|not_found|bad_request|too_large|rate_limit|server|network|timeout|truncated|refusal
    this.userMessage = userMessage;
    this.retryAfter = retryAfter;
  }
}

/* ---------- 底层调用 ---------- */

async function callClaude({ system, userMessage, settings, maxTokens }) {
  if (!settings.apiKey) {
    throw new ApiError('no_key', '请先设置 API Key');
  }

  let resp;
  try {
    resp = await fetch(API_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: settings.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new ApiError('timeout', '请求超时，请重试');
    }
    throw new ApiError('network', '网络连接失败，请检查网络后重试');
  }

  if (!resp.ok) {
    throw await classifyHttpError(resp);
  }

  let data;
  try {
    data = await resp.json();
  } catch {
    throw new ApiError('server', 'Claude 返回了无法解析的响应，请重试');
  }

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
    throw new ApiError('server', 'Claude 没有返回文本内容，请重试');
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
        return new ApiError('server', 'Claude 服务暂时不可用，请稍后重试');
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
  const text = await callClaude({
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
  const text = await callClaude({
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
