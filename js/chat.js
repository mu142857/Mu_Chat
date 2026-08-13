/**
 * chat.js — 主界面（回复助手）视图。
 * 一条往下流的时间线：贴过的微信消息和参谋回复按轮次冻结在时间线里，
 * 底部永远是"贴新消息"的空粘贴框 + 输入条，不用往回翻。
 * 每轮发送 = 本轮新贴的消息（增量）+ 你的话；完整对话由历轮增量拼成，全在上下文里。
 */

import * as store from './storage.js';
import { streamChat, assistChat, summarizeConversation, ApiError } from './api.js';
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

/** 底部粘贴框里本轮新贴的消息 → [{role:'them'|'me', text}]（已过滤空框） */
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

  // 数据在管理页被改动后，刷新人物区
  document.addEventListener('muchat:data-changed', (e) => {
    if (e.detail && e.detail.source === 'chat') return;
    renderPersona();
  });

  renderAll();
  requestAnimationFrame(() => autogrow(refs.input, 132));
}

function renderAll() {
  renderPersona();
  renderChat();
  renderConversation();
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
    chip.appendChild(el('span', 'chip-name', persona.category.name));
    chip.appendChild(el('span', 'chip-badge', '类别'));
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

/* ---------- 底部"贴新消息"粘贴框 ---------- */

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
  let lastUserIdx = -1;
  session.chat.forEach((m, i) => { if (m.role === 'user') lastUserIdx = i; });
  session.chat.forEach((m, i) => {
    refs.chatArea.appendChild(buildMessageEl(m, i === lastUserIdx ? i : -1));
  });
  scrollToBottom();
}

function buildEmptyHint() {
  const card = el('div', 'chat-empty');
  card.appendChild(el('div', 'chat-empty-title', '👋 把微信聊天贴进下方的框里，我帮你分析局面、写回复'));
  const ul = el('ul');
  for (const tip of [
    '一个框贴一个人的话，对方我交替；同一人连发多条合并贴一个框。「对方/我」标签贴错了可点击切换',
    '最底下的输入框写你的想法、要求（也可以不写，直接点发送）',
    '生成后接着往下用：对方回了就贴进新出现的框里再发送，或者直接说「改轻松点」「接下来怎么办」',
    '选择对象后，回复会按 TA 的档案拿捏口吻和分寸',
  ]) {
    ul.appendChild(el('li', '', tip));
  }
  card.appendChild(ul);
  return card;
}

function buildMessageEl(msg, undoIndex = -1) {
  if (msg.role === 'user') {
    const row = el('div', 'chat-msg user');
    const wrap = el('div', 'user-wrap');
    if (msg.convo) {
      wrap.appendChild(buildConvoChunk(msg.convo));
    }
    if (msg.text && msg.text.trim()) {
      wrap.appendChild(el('div', 'user-bubble', msg.text));
    }
    if (undoIndex >= 0) {
      const undo = el('button', 'undo-btn', '↩ 撤回');
      undo.title = '撤回这条和它的回复，内容退回下方重新编辑';
      undo.addEventListener('click', () => onUndo(undoIndex));
      wrap.appendChild(undo);
    }
    row.appendChild(wrap);
    return row;
  }
  const row = el('div', 'chat-msg assistant');
  const card = el('div', 'assistant-card');
  renderAssistantMessage(card, msg, false);
  row.appendChild(card);
  return row;
}

/** 渲染完整的 assistant 消息：主参谋内容 +（双参谋时）来源标注和副参谋补充段 */
function renderAssistantMessage(card, msg, streaming) {
  renderAssistantInto(card, msg.content, streaming);
  if (!msg.model && !msg.assist) return;
  if (msg.model) {
    card.insertBefore(el('div', 'src-label', `⚡ ${msg.model}`), card.firstChild);
  }
  if (msg.assist) {
    const sec = el('div', 'assist-section');
    sec.appendChild(el('div', 'src-label', `✦ ${msg.assist.model} · 补充候选`));
    const sub = el('div');
    renderAssistantInto(sub, msg.assist.content, false);
    sec.appendChild(sub);
    card.appendChild(sec);
  }
}

/** 撤回最后一轮：删掉该条与其后的回复，文字退回输入框、消息退回粘贴框 */
function onUndo(index) {
  if (generating) {
    showToast('先点「停止」再撤回');
    return;
  }
  const turn = session.chat[index];
  if (!turn || turn.role !== 'user') return;
  session.chat.splice(index);

  // 指令文字退回输入框（输入框里已有草稿就接在它前面）
  if (turn.text && turn.text.trim()) {
    const cur = refs.input.value.trim();
    refs.input.value = cur ? `${turn.text}\n${cur}` : turn.text;
    session.inputDraft = refs.input.value;
    autogrow(refs.input, 132);
  }

  // 贴过的消息退回底部粘贴框，排在现有未发送内容前面（角色衔接正好不变）
  if (turn.convo && turn.convo.length) {
    const existing = session.convo.filter((b) => b.text.trim());
    session.convo = [
      ...turn.convo.map((x) => ({ text: x.text })),
      ...existing,
      { text: '' },
    ];
    session.firstRole = turn.convo[0].role;
  }

  persist();
  renderChat();
  renderConversation();
  showToast('已撤回，内容退回下方');
}

/** 时间线里已发送的微信消息块（只读） */
function buildConvoChunk(convo) {
  const chunk = el('div', 'turn-convo');
  chunk.appendChild(el('div', 'turn-convo-head', `微信消息 +${convo.length}`));
  for (const m of convo) {
    const row = el('div', 'turn-convo-row');
    row.appendChild(el('span', `mini-tag ${m.role}`, m.role === 'me' ? '我' : '对方'));
    row.appendChild(el('div', 'turn-convo-text', m.text));
    chunk.appendChild(row);
  }
  return chunk;
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

function convoSection(convo) {
  return '【对话记录·新增】\n'
    + convo.map((x) => `${x.role === 'me' ? '我' : '对方'}：${x.text}`).join('\n');
}

function apiUserContent(m) {
  const parts = [];
  if (m.convo && m.convo.length) {
    parts.push(convoSection(m.convo));
  }
  if (m.text && m.text.trim()) {
    parts.push(m.convo && m.convo.length ? `【我说】\n${m.text.trim()}` : m.text.trim());
  }
  if (!parts.length) parts.push('（请根据对话记录继续）');
  return parts.join('\n\n');
}

function buildApiChat() {
  // 副参谋的候选也拼进上下文，后续「用第二条改一下」这类指代才接得住
  return session.chat.map((m) => (m.role === 'assistant'
    ? {
      role: 'assistant',
      content: m.assist
        ? `${m.content}\n\n【另一位参谋（${m.assist.model}）的补充候选】\n${m.assist.content}`
        : m.content,
    }
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
    showToast('先在上方框里贴新消息，或写点想法');
    return;
  }

  const settings = await ensureSettings();
  if (!settings) return;

  session.chat.push({ role: 'user', text, convo: convoNow.length ? convoNow : null });
  session.inputDraft = '';
  refs.input.value = '';
  autogrow(refs.input, 132);

  // 重置底部粘贴框：下一框的默认角色接着最后一条消息交替
  if (convoNow.length) {
    session.firstRole = convoNow[convoNow.length - 1].role === 'them' ? 'me' : 'them';
  }
  session.convo = [{ text: '' }];
  persist();
  renderChat();
  renderConversation();

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

  const memes = store.listMemes().map((m) => m.text);
  const me = store.getMe();
  const apiChat = buildApiChat();

  // 双参谋：填了副 key 就并行让 Claude 出 2 条补充候选
  const assistSettings = settings.assistApiKey
    ? {
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: settings.assistApiKey,
      model: settings.assistModel || 'claude-sonnet-4-6',
    }
    : null;
  const callAssist = (s) => assistChat({
    persona, memes, me, chat: apiChat, settings: s, abortSignal: abortCtrl.signal,
  });
  const assistPromise = assistSettings
    ? callAssist(assistSettings).then(
      (text) => ({ ok: true, text, model: assistSettings.model }),
      (e) => ({ ok: false, e }),
    )
    : null;

  const doCall = () => streamChat({
    persona, memes, me, chat: apiChat, settings, onDelta,
    abortSignal: abortCtrl.signal, dual: !!assistSettings,
  });

  const finish = (text) => {
    const msg = { role: 'assistant', content: text, model: assistSettings ? settings.model : null };
    session.chat.push(msg);
    if (persona && persona.kind === 'profile') {
      store.touchLastContact(persona.profile.id);
      document.dispatchEvent(new CustomEvent('muchat:data-changed', { detail: { source: 'chat' } }));
    }
    persist();
    renderAssistantMessage(card, msg, false);
    if (followStream) scrollToBottom();
    return msg;
  };

  /** 主参谋完成后等副参谋；Claude 挂了就让 Gemini 按副参谋提示词补位 */
  const attachAssist = async (msg) => {
    const note = el('div', 'typing-note', `✦ ${assistSettings.model} 候选生成中…`);
    card.appendChild(note);
    if (followStream) scrollToBottom();
    let r = await assistPromise;
    if (!r.ok && !(r.e instanceof ApiError && r.e.kind === 'aborted')) {
      note.textContent = `✦ ${assistSettings.model} 失败，${settings.model} 补位中…`;
      r = await callAssist(settings).then(
        (text) => ({ ok: true, text, model: `${settings.model}（补位）` }),
        (e) => ({ ok: false, e }),
      );
    }
    note.remove();
    if (r.ok) {
      msg.assist = { model: r.model, content: r.text };
      persist();
      renderAssistantMessage(card, msg, false);
      if (followStream) scrollToBottom();
    } else if (!(r.e instanceof ApiError && r.e.kind === 'aborted')) {
      showToast('补充候选生成失败：' + (r.e instanceof ApiError ? r.e.userMessage : '请重试'), { duration: 3000 });
    }
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
    const msg = finish(result.text);
    if (result.truncated) showToast('输出被截断了，内容可能不完整', { duration: 3000 });
    if (assistPromise) await attachAssist(msg);
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
  if (convoNow.length) {
    chatForSummary.push({ role: 'user', content: convoSection(convoNow) });
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

  // 档案在电脑的本地文件里，页面写不进去：复制要点后贴进文件，或直接丢给 Claude
  const who = persona && persona.kind === 'profile' ? `「${persona.profile.name}」` : '对应人';
  dialog.appendChild(el('div', 'dialog-note',
    `档案在电脑的 data/profiles.js 文件里。复制要点后贴进${who}的 notes，或把要点发给 Claude 让它归档。`
    + (store.getDataSource() === 'imported' ? '\n（这台设备只读，归档后重新导出导入一次才会同步过来）' : '')));

  const actions = el('div', 'dialog-actions');
  const btnClose = el('button', 'dialog-cancel', '关闭');
  const btnCopy = el('button', 'dialog-confirm', '复制要点');
  actions.appendChild(btnClose);
  actions.appendChild(btnCopy);
  dialog.appendChild(actions);
  overlay.appendChild(dialog);
  root.appendChild(overlay);

  btnClose.addEventListener('click', () => overlay.remove());
  btnCopy.addEventListener('click', async () => {
    const ok = await copyText(ta.value);
    if (!ok) {
      showToast('复制失败，请长按手动复制');
      return;
    }
    overlay.remove();
    const yes = await confirmDialog({
      title: '要点已复制',
      body: '是否清空当前对话，开始下一段？（保留已选人物）',
      confirmText: '清空',
      cancelText: '保留',
    });
    if (yes) resetSession();
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
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
      body: '整条时间线都会被清空（保留已选人物）。',
      confirmText: '清空',
      danger: true,
    });
    if (!yes) return;
  }
  resetSession();
}
