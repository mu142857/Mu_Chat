/**
 * chat.js — 主界面（回复助手）视图：与参谋的连续对话。
 * 读 storage → 渲染 → 事件 → 写回 storage / 调 api。
 */

import * as store from './storage.js';
import { streamChat, summarizeConversation, ApiError } from './api.js';
import { TIER_LABELS } from './prompts.js';
import { parseSegments, renderMarkdown } from './markdown.js';
import {
  el, showToast, confirmDialog, promptApiKey, copyText, openPersonaPicker,
} from './ui.js';

let session = null;
let refs = {};
let saveTimer = null;
let lastStorageWarnAt = 0;
let generating = false;
let abortCtrl = null;
let followStream = false; // 生成期间自动跟随滚动；用户主动滚动即停止跟随

/* ---------- 保存 ---------- */

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 300);
}

function persist() {
  try {
    store.saveSession(session);
  } catch (e) {
    if (Date.now() - lastStorageWarnAt > 5000) {
      lastStorageWarnAt = Date.now();
      showToast(e.userMessage || '保存失败');
    }
  }
}

/* ---------- 初始化 ---------- */

export function initChatView() {
  refs = {
    personaArea: document.getElementById('persona-area'),
    chatArea: document.getElementById('chat-area'),
    input: document.getElementById('chat-input'),
    btnSend: document.getElementById('btn-send'),
    btnSummary: document.getElementById('btn-summary'),
    btnNewChat: document.getElementById('btn-new-chat'),
    composer: document.getElementById('composer'),
  };

  session = store.getSession();

  refs.input.value = session.inputDraft || '';
  refs.input.addEventListener('input', () => {
    session.inputDraft = refs.input.value;
    autogrow(refs.input);
    scheduleSave();
  });
  refs.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSend();
    }
  });

  refs.btnSend.addEventListener('click', onSend);
  refs.btnSummary.addEventListener('click', onSummarize);
  refs.btnNewChat.addEventListener('click', onNewChat);

  // 输入框高度变化时同步页面底部留白
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      document.documentElement.style.setProperty(
        '--composer-h', refs.composer.offsetHeight + 'px');
    }).observe(refs.composer);
  }

  // 用户在生成期间主动滚动，就不再自动跟随到底部
  for (const evt of ['wheel', 'touchmove']) {
    window.addEventListener(evt, () => { followStream = false; }, { passive: true });
  }

  // 档案/预设在管理页被改动后，刷新人物区
  document.addEventListener('muchat:data-changed', (e) => {
    if (e.detail && e.detail.source === 'chat') return;
    renderPersona();
  });

  renderPersona();
  renderChat();
  requestAnimationFrame(() => autogrow(refs.input));
}

/* ---------- 人物选择区 ---------- */

function renderPersona() {
  const area = refs.personaArea;
  area.innerHTML = '';

  const persona = store.resolvePersona(session.selected);
  if (session.selected && !persona) {
    // 选中的人物已被删除，静默清除
    session.selected = null;
    scheduleSave();
  }

  if (!persona) {
    const btn = el('button', 'persona-select-btn', '👤 选择对象 ▾');
    btn.addEventListener('click', openPicker);
    area.appendChild(btn);
    return;
  }

  const chip = el('div', 'persona-chip');
  if (persona.kind === 'profile') {
    chip.appendChild(el('span', 'chip-name', persona.profile.name));
    chip.appendChild(el('span', 'chip-badge', TIER_LABELS[persona.profile.tier] || ''));
  } else {
    chip.appendChild(el('span', 'chip-name', persona.preset.name));
    chip.appendChild(el('span', 'chip-badge', '预设'));
  }
  const change = el('button', 'chip-remove', '⇄');
  change.title = '更换对象';
  change.addEventListener('click', openPicker);
  const remove = el('button', 'chip-remove', '×');
  remove.title = '取消选择';
  remove.addEventListener('click', () => {
    session.selected = null;
    scheduleSave();
    renderPersona();
  });
  chip.appendChild(change);
  chip.appendChild(remove);
  area.appendChild(chip);
}

function openPicker() {
  openPersonaPicker({
    onSelect(ref) {
      session.selected = ref;
      scheduleSave();
      renderPersona();
      document.dispatchEvent(new CustomEvent('muchat:data-changed', { detail: { source: 'chat' } }));
    },
  });
}

/* ---------- 聊天区渲染 ---------- */

function autogrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 132) + 'px';
}

function scrollToBottom() {
  window.scrollTo({ top: document.body.scrollHeight });
}

function renderChat() {
  refs.chatArea.innerHTML = '';
  if (!session.chat.length) {
    refs.chatArea.appendChild(buildEmptyHint());
    return;
  }
  for (const msg of session.chat) {
    refs.chatArea.appendChild(buildMessageEl(msg));
  }
  scrollToBottom();
}

function buildEmptyHint() {
  const card = el('div', 'chat-empty');
  card.appendChild(el('div', 'chat-empty-title', '👋 把微信聊天贴进来，我帮你分析局面、写回复'));
  const ul = el('ul');
  for (const tip of [
    '贴对话时标一下谁说的，比如「对方：…」「我：…」，转述情况也行',
    '想怎么回、有什么顾虑，直接说，你的意图优先',
    '生成之后可以一直聊下去：贴对方的新回复、让我改语气、追问策略',
    '上方选择对象后，回复会按 TA 的档案拿捏口吻和分寸',
  ]) {
    ul.appendChild(el('li', '', tip));
  }
  card.appendChild(ul);
  return card;
}

function buildMessageEl(msg) {
  if (msg.role === 'user') {
    const row = el('div', 'chat-msg user');
    row.appendChild(el('div', 'user-bubble', msg.content));
    return row;
  }
  const row = el('div', 'chat-msg assistant');
  const card = el('div', 'assistant-card');
  renderAssistantInto(card, msg.content, false);
  row.appendChild(card);
  return row;
}

/** 把模型原始输出渲染进卡片：markdown 分析 + 可复制的消息气泡（连发成组） */
function renderAssistantInto(card, raw, streaming) {
  card.innerHTML = '';
  const segments = parseSegments(raw);
  let i = 0;
  while (i < segments.length) {
    const seg = segments[i];
    if (seg.type === 'md') {
      card.appendChild(renderMarkdown(seg.text));
      i++;
      continue;
    }
    // 连续的 msg 块成一组
    const run = [];
    while (i < segments.length && segments[i].type === 'msg') {
      run.push(segments[i]);
      i++;
    }
    card.appendChild(buildBubbleGroup(run));
  }
  if (streaming) {
    card.appendChild(el('span', 'typing-cursor'));
  } else if (!card.childNodes.length) {
    card.appendChild(el('div', 'md', raw));
  }
}

function buildBubbleGroup(run) {
  const group = el('div', 'bubble-group');
  const complete = run.filter((s) => !s.open && s.text);
  if (complete.length > 1) {
    const head = el('div', 'group-head');
    head.appendChild(el('span', '', `连发 ${complete.length} 条`));
    const copyAll = el('button', 'btn-small', '复制全部');
    copyAll.addEventListener('click', async () => {
      const ok = await copyText(complete.map((s) => s.text).join('\n'));
      showToast(ok ? '已复制' : '复制失败，请长按手动复制');
    });
    head.appendChild(copyAll);
    group.appendChild(head);
  }
  for (const seg of run) {
    if (!seg.text) continue;
    const row = el('div', 'bubble-row');
    row.appendChild(el('div', 'bubble', seg.text));
    if (!seg.open) {
      const btn = el('button', 'btn-small bubble-copy', '复制');
      btn.addEventListener('click', async () => {
        showToast((await copyText(seg.text)) ? '已复制' : '复制失败，请长按手动复制');
      });
      row.appendChild(btn);
    }
    group.appendChild(row);
  }
  return group;
}

/* ---------- 发送与生成 ---------- */

/** 确保有 key；没有就弹输入框。返回可用 settings 或 null（用户取消） */
async function ensureSettings(promptMessage) {
  let settings = store.getSettings();
  if (settings.apiKey) return settings;
  const key = await promptApiKey({ message: promptMessage || '' });
  if (!key) return null;
  store.updateSettings({ apiKey: key });
  return store.getSettings();
}

function setSendBtn(mode) {
  if (mode === 'stop') {
    refs.btnSend.textContent = '停止';
    refs.btnSend.classList.add('stop');
  } else {
    refs.btnSend.textContent = '发送';
    refs.btnSend.classList.remove('stop');
  }
}

async function onSend() {
  if (generating) {
    if (abortCtrl) abortCtrl.abort();
    return;
  }
  const text = refs.input.value.trim();
  if (!text) {
    showToast('先输入内容');
    return;
  }
  const settings = await ensureSettings();
  if (!settings) return;

  session.chat.push({ role: 'user', content: text });
  session.inputDraft = '';
  refs.input.value = '';
  autogrow(refs.input);
  persist();
  renderChat();

  await generate();
}

async function generate() {
  let settings = store.getSettings();
  const persona = store.resolvePersona(session.selected);

  generating = true;
  followStream = true;
  setSendBtn('stop');

  const holder = el('div', 'chat-msg assistant');
  const card = el('div', 'assistant-card');
  card.appendChild(el('div', 'typing-note', '思考中…'));
  holder.appendChild(card);
  refs.chatArea.appendChild(holder);
  scrollToBottom();

  abortCtrl = new AbortController();
  let latest = '';
  let raf = 0;
  const onDelta = (full) => {
    latest = full;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      renderAssistantInto(card, latest, true);
      if (followStream) scrollToBottom();
    });
  };

  const doCall = () => streamChat({
    persona, chat: session.chat, settings, onDelta,
    abortSignal: abortCtrl.signal,
  });

  const finish = (text) => {
    session.chat.push({ role: 'assistant', content: text });
    if (persona && persona.kind === 'profile') {
      store.touchLastContact(persona.profile.id);
      document.dispatchEvent(new CustomEvent('muchat:data-changed', { detail: { source: 'chat' } }));
    }
    persist();
    renderAssistantInto(card, text, false);
    if (followStream) scrollToBottom();
  };

  try {
    let result;
    try {
      result = await doCall();
    } catch (e) {
      // 401：提示重输 key，拿到新 key 自动重试一次
      if (e instanceof ApiError && e.kind === 'auth') {
        const key = await promptApiKey({ message: 'API Key 无效或已被撤销，请重新输入。' });
        if (!key) { holder.remove(); return; }
        store.updateSettings({ apiKey: key });
        settings = store.getSettings();
        result = await doCall();
      } else {
        throw e;
      }
    }
    finish(result.text);
    if (result.truncated) showToast('输出被截断了，内容可能不完整', { duration: 3000 });
  } catch (e) {
    const aborted = e instanceof ApiError && e.kind === 'aborted';
    if (latest.trim()) {
      // 已有部分内容：保留，不让它白生成
      finish(latest);
    } else {
      holder.remove();
    }
    if (aborted) {
      showToast('已停止');
    } else {
      showToast(e instanceof ApiError ? e.userMessage : '出错了，请重试', { duration: 3000 });
    }
  } finally {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    generating = false;
    abortCtrl = null;
    setSendBtn('send');
  }
}

/* ---------- 总结链路 ---------- */

async function onSummarize() {
  if (generating) {
    showToast('等本条生成完再总结');
    return;
  }
  if (!session.chat.length) {
    showToast('还没有对话内容');
    return;
  }
  let settings = await ensureSettings();
  if (!settings) return;

  const persona = store.resolvePersona(session.selected);
  const btn = refs.btnSummary;
  btn.disabled = true;
  btn.textContent = '总结中…';

  try {
    let result;
    try {
      result = await summarizeConversation({ persona, chat: session.chat, settings });
    } catch (e) {
      if (e instanceof ApiError && e.kind === 'auth') {
        const key = await promptApiKey({ message: 'API Key 无效或已被撤销，请重新输入。' });
        if (!key) return;
        store.updateSettings({ apiKey: key });
        settings = store.getSettings();
        result = await summarizeConversation({ persona, chat: session.chat, settings });
      } else {
        throw e;
      }
    }

    if (result.parsed) {
      openSummaryDialog(result.points.map((p) => `- ${p}`).join('\n'), persona);
    } else {
      showToast('本次输出未按格式返回，已显示原文', { duration: 3000 });
      openSummaryDialog(result.raw, persona);
    }
  } catch (e) {
    showToast(e instanceof ApiError ? e.userMessage : '出错了，请重试', { duration: 3000 });
  } finally {
    btn.disabled = false;
    btn.textContent = '总结';
  }
}

function openSummaryDialog(text, persona) {
  const root = document.getElementById('modal-root');
  const overlay = el('div', 'overlay center');
  const dialog = el('div', 'dialog summary-dialog');
  dialog.appendChild(el('div', 'dialog-title', '本次对话要点（可编辑）'));

  const ta = el('textarea');
  ta.value = text;
  dialog.appendChild(ta);

  const actions = el('div', 'dialog-actions');
  const btnClose = el('button', 'dialog-cancel', '关闭');
  const btnCopy = el('button', 'dialog-cancel', '复制');
  actions.appendChild(btnClose);
  actions.appendChild(btnCopy);
  if (persona && persona.kind === 'profile') {
    const btnAppend = el('button', 'dialog-confirm', '存入档案');
    btnAppend.addEventListener('click', () => {
      onAppendToProfile(persona.profile.id, ta.value, () => overlay.remove());
    });
    actions.appendChild(btnAppend);
  }
  dialog.appendChild(actions);
  overlay.appendChild(dialog);
  root.appendChild(overlay);

  btnClose.addEventListener('click', () => overlay.remove());
  btnCopy.addEventListener('click', async () => {
    showToast((await copyText(ta.value)) ? '已复制' : '复制失败，请长按手动复制');
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

function onAppendToProfile(profileId, text, closeDialog) {
  const profile = store.getProfile(profileId);
  if (!profile) {
    showToast('档案已不存在');
    return;
  }
  const lines = (text || '')
    .split('\n')
    .map((l) => l.replace(/^\s*[-•]\s*/, '').trim())
    .filter(Boolean);
  if (!lines.length) {
    showToast('要点内容为空');
    return;
  }
  try {
    store.appendToNotes(profileId, lines);
  } catch (e) {
    showToast(e.userMessage || '保存失败');
    return;
  }
  showToast('已存入档案');
  closeDialog();
  document.dispatchEvent(new CustomEvent('muchat:data-changed', { detail: { source: 'chat' } }));

  confirmDialog({
    title: '总结已存入档案',
    body: '是否清空当前对话，开始下一段？（保留已选人物）',
    confirmText: '清空',
    cancelText: '保留',
  }).then((yes) => {
    if (yes) {
      resetSession();
    }
  });
}

/* ---------- 新对话 ---------- */

function resetSession() {
  session = store.clearSessionDraft({ keepSelection: true });
  refs.input.value = '';
  autogrow(refs.input);
  renderPersona();
  renderChat();
  window.scrollTo({ top: 0 });
}

async function onNewChat() {
  if (generating) {
    showToast('先点「停止」再开新对话');
    return;
  }
  const hasContent = session.chat.length || refs.input.value.trim();
  if (hasContent) {
    const yes = await confirmDialog({
      title: '开始新对话？',
      body: '当前对话会被清空（保留已选人物）。',
      confirmText: '清空',
      danger: true,
    });
    if (!yes) return;
  }
  resetSession();
}
