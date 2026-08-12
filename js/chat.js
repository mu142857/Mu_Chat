/**
 * chat.js — 主界面（回复助手）视图。
 * 读 storage → 渲染 → 事件 → 写回 storage / 调 api。
 */

import * as store from './storage.js';
import { generateReply, summarizeConversation, ApiError } from './api.js';
import { TIER_LABELS } from './prompts.js';
import {
  el, showToast, confirmDialog, promptApiKey, copyText, openPersonaPicker,
} from './ui.js';

let session = null;
let refs = {};
let saveTimer = null;
let lastStorageWarnAt = 0;

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

function collectMessages() {
  return session.messages
    .map((m, i) => ({ role: roleAt(i), text: m.text }))
    .filter((m) => m.text.trim());
}

/* ---------- 初始化 ---------- */

export function initChatView() {
  refs = {
    personaArea: document.getElementById('persona-area'),
    conversationArea: document.getElementById('conversation-area'),
    opinionInput: document.getElementById('opinion-input'),
    btnGenerate: document.getElementById('btn-generate'),
    resultArea: document.getElementById('result-area'),
    summaryArea: document.getElementById('summary-area'),
    btnNewChat: document.getElementById('btn-new-chat'),
  };

  session = store.getSession();

  refs.opinionInput.addEventListener('input', () => {
    session.opinion = refs.opinionInput.value;
    autogrow(refs.opinionInput);
    scheduleSave();
  });
  refs.opinionInput.addEventListener('focus', () => {
    setTimeout(() => refs.opinionInput.scrollIntoView({ block: 'center', behavior: 'smooth' }), 250);
  });

  refs.btnGenerate.addEventListener('click', onGenerate);
  refs.btnNewChat.addEventListener('click', onNewChat);

  // 档案/预设在管理页被改动后，刷新人物区与总结区（追加按钮的可用性）
  document.addEventListener('muchat:data-changed', (e) => {
    if (e.detail && e.detail.source === 'chat') return;
    renderPersona();
    renderSummary();
  });

  renderAll();
}

function renderAll() {
  renderPersona();
  renderConversation();
  refs.opinionInput.value = session.opinion || '';
  requestAnimationFrame(() => autogrow(refs.opinionInput));
  renderResult();
  renderSummary();
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
    renderSummary();
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
      renderSummary();
      document.dispatchEvent(new CustomEvent('muchat:data-changed', { detail: { source: 'chat' } }));
    },
  });
}

/* ---------- 对话区（交替粘贴框） ---------- */

function autogrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
}

function renderConversation() {
  refs.conversationArea.innerHTML = '';
  session.messages.forEach((_, i) => {
    refs.conversationArea.appendChild(createMsgBox(i));
  });
  updateRoleTags();
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
  ta.value = session.messages[index].text;
  ta.addEventListener('input', () => {
    session.messages[index].text = ta.value;
    autogrow(ta);
    maybeAppendBox();
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
    if (i === 0 && !session.messages.slice(1).length) {
      // 仅一个框时占位提示更明确
      box.querySelector('textarea').placeholder = '粘贴消息内容（同一人连发多条可合并粘在一起）';
    }
  });
}

function maybeAppendBox() {
  const n = session.messages.length;
  const lastTwoFilled =
    n >= 2
      ? session.messages[n - 1].text.trim() && session.messages[n - 2].text.trim()
      : session.messages[n - 1].text.trim();
  if (lastTwoFilled) {
    session.messages.push({ text: '' });
    refs.conversationArea.appendChild(createMsgBox(session.messages.length - 1));
    updateRoleTags();
  }
}

/* ---------- 生成回复 ---------- */

/** 确保有 key；没有就弹输入框。返回可用 settings 或 null（用户取消） */
async function ensureSettings(promptMessage) {
  let settings = store.getSettings();
  if (settings.apiKey) return settings;
  const key = await promptApiKey({ message: promptMessage || '' });
  if (!key) return null;
  store.updateSettings({ apiKey: key });
  return store.getSettings();
}

async function onGenerate() {
  const msgs = collectMessages();
  const opinion = (session.opinion || '').trim();
  if (!msgs.length && !opinion) {
    showToast('先粘贴对话内容，或写下你的看法');
    return;
  }

  let settings = await ensureSettings();
  if (!settings) return;

  const persona = store.resolvePersona(session.selected);
  const btn = refs.btnGenerate;
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = '生成中…';

  try {
    let result;
    try {
      result = await generateReply({ persona, messages: msgs, opinion, settings });
    } catch (e) {
      // 401：提示重输 key，拿到新 key 自动重试一次
      if (e instanceof ApiError && e.kind === 'auth') {
        const key = await promptApiKey({ message: 'API Key 无效或已被撤销，请重新输入。' });
        if (!key) return;
        store.updateSettings({ apiKey: key });
        settings = store.getSettings();
        result = await generateReply({ persona, messages: msgs, opinion, settings });
      } else {
        throw e;
      }
    }

    session.lastResult = result;
    if (persona && persona.kind === 'profile') {
      store.touchLastContact(persona.profile.id);
      document.dispatchEvent(new CustomEvent('muchat:data-changed', { detail: { source: 'chat' } }));
    }
    persist();
    renderResult();
    refs.resultArea.scrollIntoView({ block: 'start', behavior: 'smooth' });
  } catch (e) {
    showToast(e instanceof ApiError ? e.userMessage : '出错了，请重试', { duration: 3000 });
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

/* ---------- 结果渲染 ---------- */

function renderResult() {
  const area = refs.resultArea;
  area.innerHTML = '';
  const result = session.lastResult;
  if (!result) return;

  if (result.parsed === false || result.raw) {
    const wrap = el('div', 'raw-fallback');
    wrap.appendChild(el('div', 'raw-note', '本次输出未按格式返回，以下为原文：'));
    const pre = el('pre', '', result.raw);
    wrap.appendChild(pre);
    const btn = el('button', 'btn-small', '复制原文');
    btn.addEventListener('click', async () => {
      showToast((await copyText(result.raw)) ? '已复制' : '复制失败，请长按手动复制');
    });
    wrap.appendChild(btn);
    area.appendChild(wrap);
    return;
  }

  if (result.situationRead) {
    area.appendChild(el('div', 'situation-read', '局面判断：' + result.situationRead));
  }

  for (const cand of result.candidates) {
    const card = el('div', 'candidate-card');
    const head = el('div', 'candidate-head');
    head.appendChild(el('span', 'intent-pill', cand.intent));
    const copyAll = el('button', 'btn-small', '复制全部');
    copyAll.addEventListener('click', async () => {
      showToast((await copyText(cand.messages.join('\n'))) ? '已复制' : '复制失败，请长按手动复制');
    });
    head.appendChild(copyAll);
    card.appendChild(head);

    for (const msg of cand.messages) {
      const row = el('div', 'bubble-row');
      row.appendChild(el('div', 'bubble', msg));
      const btn = el('button', 'btn-small bubble-copy', '复制');
      btn.addEventListener('click', async () => {
        showToast((await copyText(msg)) ? '已复制' : '复制失败，请长按手动复制');
      });
      row.appendChild(btn);
      card.appendChild(row);
    }
    area.appendChild(card);
  }
}

/* ---------- 总结链路 ---------- */

function renderSummary() {
  const area = refs.summaryArea;
  area.innerHTML = '';

  const btnSum = el('button', 'btn-secondary', '总结本次对话');
  btnSum.style.width = '100%';
  btnSum.addEventListener('click', () => onSummarize(btnSum));
  area.appendChild(btnSum);

  if (session.lastSummary === null || session.lastSummary === undefined) return;

  const box = el('div', 'summary-box');
  box.appendChild(el('div', 'summary-title', '本次对话要点（可编辑）'));
  const ta = el('textarea');
  ta.value = session.lastSummary;
  ta.addEventListener('input', () => {
    session.lastSummary = ta.value;
    autogrow(ta);
    scheduleSave();
  });
  box.appendChild(ta);

  const actions = el('div', 'summary-actions');
  const btnCopy = el('button', 'btn-secondary', '复制');
  btnCopy.addEventListener('click', async () => {
    showToast((await copyText(ta.value)) ? '已复制' : '复制失败，请长按手动复制');
  });
  actions.appendChild(btnCopy);

  const persona = store.resolvePersona(session.selected);
  if (persona && persona.kind === 'profile') {
    const btnAppend = el('button', 'btn-secondary', `追加到「${persona.profile.name}」的备注`);
    btnAppend.style.color = 'var(--green-dark)';
    btnAppend.addEventListener('click', () => onAppendToProfile(persona.profile.id));
    actions.appendChild(btnAppend);
  }
  box.appendChild(actions);
  area.appendChild(box);
  requestAnimationFrame(() => autogrow(ta));
}

async function onSummarize(btn) {
  const msgs = collectMessages();
  if (!msgs.length) {
    showToast('还没有对话内容');
    return;
  }
  let settings = await ensureSettings();
  if (!settings) return;

  const persona = store.resolvePersona(session.selected);
  btn.disabled = true;
  btn.textContent = '总结中…';

  try {
    let result;
    try {
      result = await summarizeConversation({ persona, messages: msgs, settings });
    } catch (e) {
      if (e instanceof ApiError && e.kind === 'auth') {
        const key = await promptApiKey({ message: 'API Key 无效或已被撤销，请重新输入。' });
        if (!key) return;
        store.updateSettings({ apiKey: key });
        settings = store.getSettings();
        result = await summarizeConversation({ persona, messages: msgs, settings });
      } else {
        throw e;
      }
    }

    if (result.parsed) {
      session.lastSummary = result.points.map((p) => `- ${p}`).join('\n');
    } else {
      session.lastSummary = result.raw;
      showToast('本次输出未按格式返回，已显示原文', { duration: 3000 });
    }
    persist();
    renderSummary();
    refs.summaryArea.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } catch (e) {
    showToast(e instanceof ApiError ? e.userMessage : '出错了，请重试', { duration: 3000 });
  } finally {
    btn.disabled = false;
    btn.textContent = '总结本次对话';
  }
}

function onAppendToProfile(profileId) {
  const profile = store.getProfile(profileId);
  if (!profile) {
    showToast('档案已不存在');
    renderSummary();
    return;
  }
  const lines = (session.lastSummary || '')
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
  document.dispatchEvent(new CustomEvent('muchat:data-changed', { detail: { source: 'chat' } }));

  confirmDialog({
    title: '总结已存入档案',
    body: '是否清空当前对话，开始下一段？（保留已选人物）',
    confirmText: '清空',
    cancelText: '保留',
  }).then((yes) => {
    if (yes) {
      session = store.clearSessionDraft({ keepSelection: true });
      renderAll();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  });
}

/* ---------- 新对话 ---------- */

async function onNewChat() {
  const hasContent =
    collectMessages().length || (session.opinion || '').trim() ||
    session.lastResult || session.lastSummary;
  if (hasContent) {
    const yes = await confirmDialog({
      title: '开始新对话？',
      body: '当前对话、看法和候选都会被清空（保留已选人物）。',
      confirmText: '清空',
      danger: true,
    });
    if (!yes) return;
  }
  session = store.clearSessionDraft({ keepSelection: true });
  renderAll();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
