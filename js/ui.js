/**
 * ui.js — 共享 UI 组件：toast、确认弹窗、key 输入弹层、复制、人物选择器。
 */

import * as store from './storage.js';
import { TIER_LABELS } from './prompts.js';

/* ---------- 小工具 ---------- */

/** 创建元素的简写 */
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 相对时间："刚刚 / n 分钟前 / n 小时前 / n 天前 / 具体日期"，null → "从未联系" */
export function fmtRelative(iso) {
  if (!iso) return '从未联系';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '从未联系';
  const diff = Date.now() - t;
  const min = 60_000, hour = 3_600_000, day = 86_400_000;
  if (diff < min) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ---------- toast ---------- */

export function showToast(text, { duration = 2000 } = {}) {
  const root = document.getElementById('toast-root');
  const t = el('div', 'toast', text);
  root.appendChild(t);
  setTimeout(() => t.remove(), duration);
}

/* ---------- 弹窗基础 ---------- */

function openOverlay({ center = false } = {}) {
  const root = document.getElementById('modal-root');
  const overlay = el('div', 'overlay' + (center ? ' center' : ''));
  root.appendChild(overlay);
  return overlay;
}

/* ---------- 确认弹窗 ---------- */

/**
 * confirmDialog({title, body, confirmText, cancelText, danger, requireText})
 * requireText: 要求输入指定文字才能确认（如"清空"）
 */
export function confirmDialog({
  title,
  body = '',
  confirmText = '确定',
  cancelText = '取消',
  danger = false,
  requireText = '',
} = {}) {
  return new Promise((resolve) => {
    const overlay = openOverlay({ center: true });
    const dialog = el('div', 'dialog');
    if (title) dialog.appendChild(el('div', 'dialog-title', title));
    if (body) dialog.appendChild(el('div', 'dialog-body', body));

    let input = null;
    if (requireText) {
      input = el('input');
      input.placeholder = `输入「${requireText}」以确认`;
      dialog.appendChild(input);
    }

    const actions = el('div', 'dialog-actions');
    const btnCancel = el('button', 'dialog-cancel', cancelText);
    const btnOk = el('button', 'dialog-confirm' + (danger ? ' danger' : ''), confirmText);
    if (requireText) {
      btnOk.disabled = true;
      input.addEventListener('input', () => {
        btnOk.disabled = input.value.trim() !== requireText;
      });
    }
    actions.appendChild(btnCancel);
    actions.appendChild(btnOk);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);

    const done = (result) => { overlay.remove(); resolve(result); };
    btnCancel.addEventListener('click', () => done(false));
    btnOk.addEventListener('click', () => done(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
  });
}

/* ---------- API Key 输入弹层 ---------- */

/** 返回输入的 key（已 trim），取消返回 null */
export function promptApiKey({ message = '' } = {}) {
  return new Promise((resolve) => {
    const overlay = openOverlay({ center: true });
    const dialog = el('div', 'dialog');
    dialog.appendChild(el('div', 'dialog-title', '输入 API Key'));
    dialog.appendChild(el('div', 'dialog-body',
      (message ? message + '\n' : '') + 'Key 只保存在本机浏览器里，不会上传到任何服务器。'));

    const input = el('input');
    input.type = 'password';
    input.placeholder = '粘贴 API Key';
    input.autocomplete = 'off';
    dialog.appendChild(input);

    const actions = el('div', 'dialog-actions');
    const btnCancel = el('button', 'dialog-cancel', '取消');
    const btnOk = el('button', 'dialog-confirm', '保存');
    actions.appendChild(btnCancel);
    actions.appendChild(btnOk);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    setTimeout(() => input.focus(), 50);

    const done = (result) => { overlay.remove(); resolve(result); };
    btnCancel.addEventListener('click', () => done(null));
    btnOk.addEventListener('click', () => {
      const v = input.value.trim();
      if (!v) { input.focus(); return; }
      done(v);
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') btnOk.click(); });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
  });
}

/* ---------- 复制 ---------- */

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/* ---------- 人物选择器（Add to Project 风格底部弹层） ---------- */

/**
 * openPersonaPicker({onSelect})
 * onSelect({type:'profile'|'preset', id}) 在用户选中（或快捷新建后）调用。
 */
export function openPersonaPicker({ onSelect }) {
  const overlay = openOverlay();
  const sheet = el('div', 'sheet');
  overlay.appendChild(sheet);

  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const head = el('div', 'sheet-head');
  head.appendChild(el('div', 'sheet-title', '选择对象'));
  const search = el('input');
  search.placeholder = '搜索档案或预设';
  head.appendChild(search);
  sheet.appendChild(head);

  const body = el('div', 'sheet-body');
  sheet.appendChild(body);

  const foot = el('div', 'sheet-foot');
  foot.appendChild(el('div', 'sheet-foot-hint',
    '建新档案：编辑 data/profiles.js 文件（或叫 Claude 建）；临时对象可先用预设身份'));
  sheet.appendChild(foot);

  function pick(ref) {
    close();
    onSelect(ref);
  }

  function renderList(keyword) {
    body.innerHTML = '';
    const kw = (keyword || '').trim().toLowerCase();
    const match = (name) => !kw || name.toLowerCase().includes(kw);

    const profiles = store.listProfiles().filter((p) => match(p.name));
    const presets = store.listPresets().filter((s) => match(s.name));

    body.appendChild(el('div', 'list-group-title', '档案'));
    if (!profiles.length) {
      body.appendChild(el('div', 'list-empty', kw ? '没有匹配的档案' : '还没有档案，见下方提示'));
    }
    for (const p of profiles) {
      const item = el('button', 'list-item');
      const left = el('span');
      left.appendChild(document.createTextNode(p.name));
      left.appendChild(el('span', `tier-badge tier-${p.tier}`, TIER_LABELS[p.tier] || ''));
      item.appendChild(left);
      item.appendChild(el('span', 'item-sub', fmtRelative(p.lastContactAt)));
      item.addEventListener('click', () => pick({ type: 'profile', id: p.id }));
      body.appendChild(item);
    }

    body.appendChild(el('div', 'list-group-title', '预设身份'));
    if (!presets.length) {
      body.appendChild(el('div', 'list-empty', kw ? '没有匹配的预设' : '还没有预设身份'));
    }
    for (const s of presets) {
      const item = el('button', 'list-item');
      const left = el('span');
      left.appendChild(document.createTextNode(s.name));
      left.appendChild(el('span', 'tier-badge preset-badge', '预设'));
      item.appendChild(left);
      item.addEventListener('click', () => pick({ type: 'preset', id: s.id }));
      body.appendChild(item);
    }
  }

  search.addEventListener('input', () => renderList(search.value));
  renderList('');
}
