/**
 * chat.js — 主界面（回复助手）视图。
 * 上方：对话记录工作区（对方/我 交替粘贴框，可随时补贴新消息）；
 * 下方：与参谋的连续对话流。每轮发送 = 最新对话记录快照 + 你的话 + 全部历史上下文。
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

/* ---------- 角色计算 ---------- */

function roleAt(index) {
  const other = session.firstRole === 'them' ? 'me' : 'them';
  return index % 2 === 0 ? session.firstRole : other;
}

/** 当前粘贴框内容 → [{role:'them'|'me', text}]（已过滤空框） */
function collectConvo() {
  return session.convo
    .map((m, i) => ({ role: roleAt(i), text: m.text.trim() }))
    .filter((m) => m.text);
}

/* ---------- 初始化 ---------- */

export function initChatView() {
  refs = {
    personaArea: document.getElementById('persona-area'),
    conversationArea: document.getElementById('conversation-area'),
    convoCount: document.getElementById('convo-count'),
    btnConvoToggle: document.getElementById('btn-convo-toggle'),
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
    autogrow(refs.input, 132);
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
  refs.btnConvoToggle.addEventListener('click', () => {
    session.convoCollapsed = !session.convoCollapsed;
    scheduleSave();
    renderConvoState();
  });

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

  renderAll();
  requestAnimationFrame(() => autogrow(refs.input, 132));
}

function renderAll() {
  renderPersona();
  renderConversation();
  renderChat();
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

/* ---------- 对话记录工作区（交替粘贴框） ---------- */

function autogrow(ta, cap) {
  ta.style.height = 'auto';
  const h = cap ? Math.min(ta.scrollHeight, cap) : ta.scrollHeight;
  ta.style.height = h + 'px';
}

function renderConversation() {
  refs.conversationArea.innerHTML = '';
  session.convo.forEach((_, i) => {
    refs.conversationArea.appendChild(createMsgBox(i));
  });
  updateRoleTags();
  renderConvoState();
}

function createMsgBox(index) {
  const box = el('div', 'msg-box');
  box.dataset.index = String(index);

  const tag = el('span', 'role-tag');
  if (index === 0) {
    tag.classList.add('tappable');
    tag.title = '点击切换 对方/我';
    tag.addEventListener('click', () => {
      session.firstRole = session.firstRole === 'them' ? 'me' : 'them';
      updateRoleTags();
      scheduleSave();
    });
  }
  box.appendChild(tag);

  const ta = el('textarea');
  ta.rows = 2;
  ta.value = session.convo[index].text;
  ta.addEventListener('input', () => {
    session.convo[index].text = ta.value;
    autogrow(ta);
    maybeAppendBox();
    renderConvoState();
    scheduleSave();
  });
  ta.addEventListener('focus', () => {
    setTimeout(() => ta.scrollIntoView({ block: 'center', behavior: 'smooth' }), 250);
  });
  box.appendChild(ta);

  requestAnimationFrame(() => autogrow(ta));
  return box;
}

function updateRoleTags() {
  const boxes = refs.conversationArea.querySelectorAll('.msg-box');
  boxes.forEach((box, i) => {
    const role = roleAt(i);
    box.dataset.role = role;
    const tag = box.querySelector('.role-tag');
    tag.textContent = role === 'them' ? '对方' : '我';
    if (i === 0 && !session.convo.slice(1).length) {
      // 仅一个框时占位提示更明确
      box.querySelector('textarea').placeholder = '粘贴消息内容（同一人连发多条可合并粘在一起）';
    }
  });
}

function maybeAppendBox() {
  const n = session.convo.length;
  const lastTwoFilled =
    n >= 2
      ? session.convo[n - 1].text.trim() && session.convo[n - 2].text.trim()
      : session.convo[n - 1].text.trim();
  if (lastTwoFilled) {
    session.convo.push({ text: '' });
    refs.conversationArea.appendChild(createMsgBox(session.convo.length - 1));
    updateRoleTags();
  }
}

/** 收起/展开状态与条数标签 */
function renderConvoState() {
  const count = collectConvo().length;
  refs.convoCount.textContent = count ? `· ${count} 条` : '';
  refs.conversationArea.hidden = session.convoCollapsed;
  refs.btnConvoToggle.textContent = session.convoCollapsed ? '展开' : '收起';
}

/* ---------- 聊天流渲染 ---------- */

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
  card.appendChild(el('div', 'chat-empty-title', '👋 把微信聊天贴进上方的框里，我帮你分析局面、写回复'));
  const ul = el('ul');
  for (const tip of [
    '一个框贴一个人的话，对方我交替；同一人连发多条合并贴一个框。第一框的「对方/我」标签可点击切换',
    '下面这个输入框写你的想法、要求（也可以不写，直接点发送）',
    '生成后可以一直聊：对方回了就把新消息补贴到上方框里再发送，或者直接说「改轻松点」「接下来怎么办」',
    '选择对象后，回复会按 TA 的档案拿捏口吻和分寸',
  ]) {
    ul.appendChild(el('li', '', tip));
  }
  card.appendChild(ul);
  return card;
}

function buildMessageEl(msg) {
  if (msg.role === 'user') {
    const row = el('div', 'chat-msg user');
    const wrap = el('div', 'user-wrap');
    if (msg.convo) {
      wrap.appendChild(el('div', 'user-attach', `📎 对话记录 ${msg.convo.length} 条`));
    }
    if (msg.text && msg.text.trim()) {
      wrap.appendChild(el('div', 'user-bubble', msg.text));
    } else {
      wrap.appendChild(el('div', 'user-bubble muted', '（更新了对话记录，接着出主意）'));
    }
    row.appendChild(wrap);
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

/* ---------- 组装发给模型的消息 ---------- */

/** 最近一次随消息发出的对话记录快照 */
function lastSentSnapshot() {
  for (let i = session.chat.length - 1; i >= 0; i--) {
    const m = session.chat[i];
    if (m.role === 'user' && m.convo) return m.convo;
  }
  return null;
}

function apiUserContent(m) {
  const parts = [];
  if (m.convo && m.convo.length) {
    parts.push('【当前对话记录·完整版】\n'
      + m.convo.map((x) => `${x.role === 'me' ? '我' : '对方'}：${x.text}`).join('\n'));
  }
  if (m.text && m.text.trim()) {
    parts.push(m.convo && m.convo.length ? `【我说】\n${m.text.trim()}` : m.text.trim());
  }
  if (!parts.length) parts.push('（请根据对话记录继续）');
  return parts.join('\n\n');
}

function buildApiChat() {
  return session.chat.map((m) => (m.role === 'assistant'
    ? { role: 'assistant', content: m.content }
    : { role: 'user', content: apiUserContent(m) }));
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
  const convoNow = collectConvo();
  if (!text && !convoNow.length) {
    showToast('先在上方贴对话，或在这里写点内容');
    return;
  }

  // 对话记录跟上次发出的一样就不重复附带
  const prev = lastSentSnapshot() || [];
  const changed = JSON.stringify(convoNow) !== JSON.stringify(prev);
  if (!text && !changed) {
    showToast('对话记录没有新内容，补贴新消息或写点想法');
    return;
  }

  const settings = await ensureSettings();
  if (!settings) return;

  session.chat.push({ role: 'user', text, convo: changed && convoNow.length ? convoNow : null });
  session.inputDraft = '';
  refs.input.value = '';
  autogrow(refs.input, 132);
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
    persona, chat: buildApiChat(), settings, onDelta,
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
  if (!session.chat.length && !collectConvo().length) {
    showToast('还没有对话内容');
    return;
  }
  let settings = await ensureSettings();
  if (!settings) return;

  const persona = store.resolvePersona(session.selected);
  const btn = refs.btnSummary;
  btn.disabled = true;
  btn.textContent = '总结中…';

  // 粘贴框里有还没发送过的内容时，也一并纳入总结
  const chatForSummary = buildApiChat();
  const convoNow = collectConvo();
  const prev = lastSentSnapshot() || [];
  if (convoNow.length && JSON.stringify(convoNow) !== JSON.stringify(prev)) {
    chatForSummary.push({
      role: 'user',
      content: '【当前对话记录·完整版】\n'
        + convoNow.map((x) => `${x.role === 'me' ? '我' : '对方'}：${x.text}`).join('\n'),
    });
  }

  try {
    let result;
    try {
      result = await summarizeConversation({ persona, chat: chatForSummary, settings });
    } catch (e) {
      if (e instanceof ApiError && e.kind === 'auth') {
        const key = await promptApiKey({ message: 'API Key 无效或已被撤销，请重新输入。' });
        if (!key) return;
        store.updateSettings({ apiKey: key });
        settings = store.getSettings();
        result = await summarizeConversation({ persona, chat: chatForSummary, settings });
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
  autogrow(refs.input, 132);
  renderAll();
  window.scrollTo({ top: 0 });
}

async function onNewChat() {
  if (generating) {
    showToast('先点「停止」再开新对话');
    return;
  }
  const hasContent = session.chat.length || collectConvo().length || refs.input.value.trim();
  if (hasContent) {
    const yes = await confirmDialog({
      title: '开始新对话？',
      body: '上方对话记录和生成结果都会被清空（保留已选人物）。',
      confirmText: '清空',
      danger: true,
    });
    if (!yes) return;
  }
  resetSession();
}
