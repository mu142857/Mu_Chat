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
  const btnCreate = el('button', 'btn-secondary', '＋ 新建档案');
  btnCreate.style.width = '100%';
  foot.appendChild(btnCreate);
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
      body.appendChild(el('div', 'list-empty', kw ? '没有匹配的档案' : '还没有档案，可以在下方快捷新建'));
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

  function renderQuickCreate() {
    body.innerHTML = '';
    foot.hidden = true;
    search.disabled = true;

    const wrap = el('div', 'quick-create');
    wrap.appendChild(el('div', 'field-label', '备注名'));
    const nameInput = el('input');
    nameInput.placeholder = '比如：Tony';
    wrap.appendChild(nameInput);

    wrap.appendChild(el('div', 'field-label', '关系层级'));
    const seg = el('div', 'segmented');
    let tier = 3;
    const segBtns = [1, 2, 3].map((t) => {
      const b = el('button', t === tier ? 'active' : '', TIER_LABELS[t]);
      b.addEventListener('click', () => {
        tier = t;
        segBtns.forEach((x, i) => x.classList.toggle('active', i + 1 === t));
      });
      seg.appendChild(b);
      return b;
    });
    wrap.appendChild(seg);

    const actions = el('div', 'form-actions');
    const btnBack = el('button', 'btn-secondary', '返回');
    const btnOk = el('button', 'btn-secondary', '创建并选中');
    btnOk.style.color = 'var(--green-dark)';
    actions.appendChild(btnBack);
    actions.appendChild(btnOk);
    wrap.appendChild(actions);
    body.appendChild(wrap);
    setTimeout(() => nameInput.focus(), 50);

    btnBack.addEventListener('click', () => {
      foot.hidden = false;
      search.disabled = false;
      renderList(search.value);
    });
    btnOk.addEventListener('click', () => {
      const name = nameInput.value.trim();
      if (!name) { showToast('请填写备注名'); return; }
      try {
        const profile = store.createProfile({ name, tier });
        pick({ type: 'profile', id: profile.id });
      } catch (e) {
        showToast(e.userMessage || '创建失败');
      }
    });
  }

  search.addEventListener('input', () => renderList(search.value));
  btnCreate.addEventListener('click', renderQuickCreate);
  renderList('');
}
