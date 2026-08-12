/**
 * manage.js — 档案管理页：档案（只读，数据在 data/profiles.js 文件里）、预设身份、梗库、
 * 设置（key/模型/锁屏/导入导出/清空）。
 */

import * as store from './storage.js';
import { TIER_LABELS } from './prompts.js';
import { PROVIDER_PRESETS } from './api.js';
import { el, showToast, confirmDialog, promptApiKey, fmtRelative } from './ui.js';

let refs = {};
// 当前展开的项：{type:'profile'|'preset'|'new-preset', id?}
let expanded = null;

export function initManageView() {
  refs = {
    profiles: document.getElementById('profiles-section'),
    presets: document.getElementById('presets-section'),
    memes: document.getElementById('memes-section'),
    settings: document.getElementById('settings-section'),
  };

  document.addEventListener('muchat:data-changed', (e) => {
    if (e.detail && e.detail.source === 'manage') return;
    refreshManageView();
  });

  refreshManageView();
}

export function refreshManageView() {
  renderProfilesSection();
  renderPresetsSection();
  renderMemesSection();
  renderSettingsSection();
}

function dataChanged() {
  document.dispatchEvent(new CustomEvent('muchat:data-changed', { detail: { source: 'manage' } }));
}

/* ============ 档案（只读，数据在 data/profiles.js） ============ */

function renderProfilesSection() {
  const root = refs.profiles;
  root.innerHTML = '';
  const section = el('div', 'manage-section');

  const head = el('div', 'manage-section-head');
  head.appendChild(el('h2', '', '档案'));
  section.appendChild(head);

  section.appendChild(el('div', 'file-hint',
    '📁 档案存在本地文件 data/profiles.js 里：直接改文件，或叫 Claude 改，保存后刷新本页生效。'));

  const legacy = store.listLegacyProfiles();
  if (legacy.length) section.appendChild(buildMigrationCard(legacy));

  const profiles = store.listProfiles();
  if (!profiles.length) {
    section.appendChild(el('div', 'empty-hint',
      '还没有档案。打开 data/profiles.js，照着里面的示例加，或直接叫 Claude 帮你建。'));
  }

  for (const tier of [1, 2, 3]) {
    const group = profiles.filter((p) => p.tier === tier);
    if (!group.length) continue;
    section.appendChild(el('div', 'group-title', TIER_LABELS[tier]));
    for (const p of group) {
      section.appendChild(buildProfileCard(p));
    }
  }

  root.appendChild(section);
}

function buildProfileCard(p) {
  const card = el('div', 'entity-card');
  const row = el('button', 'entity-row');
  const left = el('span');
  left.appendChild(document.createTextNode(p.name));
  left.appendChild(el('span', `tier-badge tier-${p.tier}`, TIER_LABELS[p.tier] || ''));
  row.appendChild(left);
  row.appendChild(el('span', 'row-sub', fmtRelative(p.lastContactAt)));
  row.addEventListener('click', () => {
    expanded = expanded && expanded.type === 'profile' && expanded.id === p.id
      ? null
      : { type: 'profile', id: p.id };
    renderProfilesSection();
  });
  card.appendChild(row);

  if (expanded && expanded.type === 'profile' && expanded.id === p.id) {
    card.appendChild(buildProfileView(p));
  }
  return card;
}

/** 只读展示档案内容；编辑请去 data/profiles.js */
function buildProfileView(p) {
  const view = el('div', 'profile-view');
  const fields = [
    ['他关心什么', p.interests],
    ['共同经历和梗', p.memories],
    ['发消息风格', p.style],
    ['我对这个人的目的', p.goal],
    ['自由备注', p.notes],
  ];
  let hasAny = false;
  for (const [label, value] of fields) {
    if (!value || !value.trim()) continue;
    hasAny = true;
    view.appendChild(el('div', 'field-label', label));
    view.appendChild(el('div', 'field-text', value.trim()));
  }
  if (!hasAny) {
    view.appendChild(el('div', 'empty-hint', '这份档案还没写内容，去 data/profiles.js 里补充。'));
  }
  return view;
}

/* ---- 旧档案迁移（浏览器 localStorage → data/profiles.js） ---- */

function buildMigrationCard(legacy) {
  const card = el('div', 'notice-card');
  card.appendChild(el('div', 'notice-title', `检测到浏览器里的 ${legacy.length} 份旧档案`));
  card.appendChild(el('div', 'notice-body',
    '旧版本把档案存在浏览器里（清缓存会丢）。迁移方法：\n' +
    '1. 点「下载档案文件」得到 profiles.js\n' +
    '2. 用它替换应用目录里的 data/profiles.js（原文件已有内容就手动合并，或叫 Claude 合并）\n' +
    '3. 刷新本页，确认档案都显示出来了，再点「清除浏览器旧档案」'));
  const actions = el('div', 'form-actions');
  const btnDownload = el('button', 'btn-secondary', '下载档案文件');
  btnDownload.addEventListener('click', () => {
    downloadFile('profiles.js', buildProfilesFileContent(legacy));
    showToast('已下载，替换 data/profiles.js 后刷新');
  });
  actions.appendChild(btnDownload);
  const btnClear = el('button', 'btn-secondary btn-danger', '清除浏览器旧档案');
  btnClear.addEventListener('click', async () => {
    const yes = await confirmDialog({
      title: '清除浏览器里的旧档案？',
      body: '请确认档案已经迁进 data/profiles.js 并能在上方列表看到。清除后不可恢复。',
      confirmText: '清除',
      danger: true,
    });
    if (!yes) return;
    store.clearLegacyProfiles();
    renderProfilesSection();
    showToast('已清除');
  });
  actions.appendChild(btnClear);
  card.appendChild(actions);
  return card;
}

function buildProfilesFileContent(items) {
  const js = (v) => JSON.stringify(String(v == null ? '' : v));
  const entries = items.map((p) => [
    '  {',
    `    name: ${js(p.name)},`,
    `    tier: ${[1, 2, 3].includes(Number(p.tier)) ? Number(p.tier) : 3},`,
    `    interests: ${js(p.interests)},`,
    `    memories: ${js(p.memories)},`,
    `    style: ${js(p.style)},`,
    `    goal: ${js(p.goal)},`,
    `    notes: ${js(p.notes)},`,
    '  },',
  ].join('\n')).join('\n');
  return [
    '/**',
    ' * data/profiles.js — 朋友档案（本地文件，只属于这台电脑）。',
    ' * 由「旧档案迁移」自动生成。直接编辑本文件或叫 Claude 改，保存后刷新页面生效。',
    ' * 字段说明见 data/profiles.example.js。',
    ' */',
    '',
    'export const profiles = [',
    entries,
    '];',
    '',
    '/** 可选：文件版梗库，每条一个字符串 */',
    'export const memes = [];',
    '',
  ].join('\n');
}

function downloadFile(filename, content) {
  const blob = new Blob([content], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ============ 预设身份 ============ */

function renderPresetsSection() {
  const root = refs.presets;
  root.innerHTML = '';
  const section = el('div', 'manage-section');

  const head = el('div', 'manage-section-head');
  head.appendChild(el('h2', '', '预设身份'));
  const btnNew = el('button', 'btn-secondary', '＋ 新建预设');
  btnNew.addEventListener('click', () => {
    expanded = { type: 'new-preset' };
    renderPresetsSection();
  });
  head.appendChild(btnNew);
  section.appendChild(head);

  if (expanded && expanded.type === 'new-preset') {
    const card = el('div', 'entity-card');
    card.appendChild(buildPresetForm(null));
    section.appendChild(card);
  }

  const presets = store.listPresets();
  if (!presets.length && !(expanded && expanded.type === 'new-preset')) {
    section.appendChild(el('div', 'empty-hint', '还没有预设身份。预设用于还没建档案的新朋友。'));
  }

  for (const s of presets) {
    const card = el('div', 'entity-card');
    const row = el('button', 'entity-row');
    const left = el('span');
    left.appendChild(document.createTextNode(s.name));
    left.appendChild(el('span', 'tier-badge preset-badge', '预设'));
    row.appendChild(left);
    row.addEventListener('click', () => {
      expanded = expanded && expanded.type === 'preset' && expanded.id === s.id
        ? null
        : { type: 'preset', id: s.id };
      renderPresetsSection();
    });
    card.appendChild(row);
    if (expanded && expanded.type === 'preset' && expanded.id === s.id) {
      card.appendChild(buildPresetForm(s));
    }
    section.appendChild(card);
  }

  root.appendChild(section);
}

function buildPresetForm(s) {
  const form = el('div', 'edit-form');

  form.appendChild(el('div', 'field-label', '名称'));
  const nameInput = el('input');
  nameInput.placeholder = '比如：b站男网友';
  nameInput.value = s ? s.name : '';
  form.appendChild(nameInput);

  form.appendChild(el('div', 'field-label', '风格与分寸描述'));
  const descInput = el('textarea');
  descInput.rows = 5;
  descInput.placeholder = '这类人是谁、怎么跟他说话、注意什么分寸';
  descInput.value = s ? s.description : '';
  form.appendChild(descInput);

  const actions = el('div', 'form-actions');
  const btnSave = el('button', 'btn-secondary', '保存');
  btnSave.style.color = 'var(--green-dark)';
  btnSave.addEventListener('click', () => {
    const name = nameInput.value.trim();
    if (!name) { showToast('名称不能为空'); return; }
    try {
      if (s) store.updatePreset(s.id, { name, description: descInput.value });
      else store.createPreset({ name, description: descInput.value });
    } catch (e) {
      showToast(e.userMessage || '保存失败');
      return;
    }
    expanded = null;
    renderPresetsSection();
    dataChanged();
    showToast('已保存');
  });
  actions.appendChild(btnSave);

  if (s) {
    const btnDelete = el('button', 'btn-secondary btn-danger', '删除');
    btnDelete.addEventListener('click', async () => {
      const yes = await confirmDialog({
        title: `删除预设「${s.name}」？`,
        body: '删除后不会自动恢复。',
        confirmText: '删除',
        danger: true,
      });
      if (!yes) return;
      store.deletePreset(s.id);
      expanded = null;
      renderPresetsSection();
      dataChanged();
      showToast('已删除');
    });
    actions.appendChild(btnDelete);
  }

  const btnCollapse = el('button', 'btn-secondary', '收起');
  btnCollapse.addEventListener('click', () => {
    expanded = null;
    renderPresetsSection();
  });
  actions.appendChild(btnCollapse);

  form.appendChild(actions);
  return form;
}

/* ============ 梗库 ============ */

function renderMemesSection() {
  const root = refs.memes;
  root.innerHTML = '';
  const section = el('div', 'manage-section');

  const head = el('div', 'manage-section-head');
  head.appendChild(el('h2', '', '梗库'));
  section.appendChild(head);

  section.appendChild(el('div', 'empty-hint',
    '看到好玩的梗、觉得妙的说法就存进来，生成回复时会随机带几条给 AI 当风格参考。'));

  const addWrap = el('div', 'meme-add');
  const ta = el('textarea');
  ta.rows = 2;
  ta.placeholder = '贴一条梗、一句你觉得妙的话…';
  addWrap.appendChild(ta);
  const btnAdd = el('button', 'btn-secondary', '收藏');
  btnAdd.addEventListener('click', () => {
    if (!ta.value.trim()) { showToast('先写点内容'); return; }
    try {
      store.addMeme(ta.value);
    } catch (e) {
      showToast(e.userMessage || '保存失败');
      return;
    }
    ta.value = '';
    renderMemesSection();
    showToast('已收藏');
  });
  addWrap.appendChild(btnAdd);
  section.appendChild(addWrap);

  const memes = store.listMemes();
  for (const m of memes.slice().reverse()) {
    const row = el('div', 'meme-row');
    row.appendChild(el('div', 'meme-text', m.text));
    if (m.fromFile) {
      row.appendChild(el('span', 'tier-badge preset-badge', '文件'));
    } else {
      const btnDel = el('button', 'btn-small btn-danger', '删除');
      btnDel.addEventListener('click', () => {
        store.deleteMeme(m.id);
        renderMemesSection();
      });
      row.appendChild(btnDel);
    }
    section.appendChild(row);
  }

  root.appendChild(section);
}

/* ============ 设置 ============ */

function maskKey(key) {
  if (!key) return '未设置';
  if (key.length <= 10) return '已设置';
  return key.slice(0, 7) + '****' + key.slice(-4);
}

function renderSettingsSection() {
  const root = refs.settings;
  root.innerHTML = '';
  const section = el('div', 'manage-section');
  const head = el('div', 'manage-section-head');
  head.appendChild(el('h2', '', '设置'));
  section.appendChild(head);

  const settings = store.getSettings();

  // 服务商
  const providerRow = el('div', 'settings-row');
  const providerLeft = el('div');
  providerLeft.appendChild(el('div', 'row-label', '服务商'));
  providerLeft.appendChild(el('div', 'row-value', '切换后需设置对应的 API Key'));
  providerRow.appendChild(providerLeft);
  const providerSelect = el('select');
  const matched = PROVIDER_PRESETS.find(
    (p) => p.id !== 'custom' && p.protocol === settings.provider && p.baseUrl === settings.baseUrl,
  );
  const currentId = matched ? matched.id : 'custom';
  for (const p of PROVIDER_PRESETS) {
    const opt = el('option', '', p.name);
    opt.value = p.id;
    if (p.id === currentId) opt.selected = true;
    providerSelect.appendChild(opt);
  }
  providerSelect.addEventListener('change', () => {
    const preset = PROVIDER_PRESETS.find((p) => p.id === providerSelect.value);
    if (!preset) return;
    if (preset.id === 'custom') {
      store.updateSettings({ provider: 'openai' });
    } else {
      store.updateSettings({
        provider: preset.protocol,
        baseUrl: preset.baseUrl,
        model: preset.defaultModel,
        apiKey: '',
      });
      showToast(`已切换到 ${preset.name}，请设置它的 API Key`, { duration: 3000 });
    }
    renderSettingsSection();
  });
  providerRow.appendChild(providerSelect);
  section.appendChild(providerRow);

  // API Key
  const keyRow = el('div', 'settings-row');
  const keyLeft = el('div');
  keyLeft.appendChild(el('div', 'row-label', 'API Key'));
  keyLeft.appendChild(el('div', 'row-value', maskKey(settings.apiKey)));
  keyRow.appendChild(keyLeft);
  const keyBtns = el('div', 'row-btns');
  const btnChangeKey = el('button', 'btn-small', settings.apiKey ? '更换' : '设置');
  btnChangeKey.addEventListener('click', async () => {
    const key = await promptApiKey();
    if (!key) return;
    store.updateSettings({ apiKey: key });
    renderSettingsSection();
    showToast('已保存');
  });
  keyBtns.appendChild(btnChangeKey);
  if (settings.apiKey) {
    const btnClearKey = el('button', 'btn-small', '清除');
    btnClearKey.addEventListener('click', async () => {
      const yes = await confirmDialog({ title: '清除 API Key？', confirmText: '清除', danger: true });
      if (!yes) return;
      store.updateSettings({ apiKey: '' });
      renderSettingsSection();
      showToast('已清除');
    });
    keyBtns.appendChild(btnClearKey);
  }
  keyRow.appendChild(keyBtns);
  section.appendChild(keyRow);

  // 模型
  const modelRow = el('div', 'settings-row');
  const modelLeft = el('div');
  modelLeft.appendChild(el('div', 'row-label', '模型'));
  modelLeft.appendChild(el('div', 'row-value', '从服务商文档复制模型 ID'));
  modelRow.appendChild(modelLeft);
  const modelInput = el('input');
  modelInput.value = settings.model;
  modelInput.placeholder = '模型 ID';
  modelInput.addEventListener('change', () => {
    store.updateSettings({ model: modelInput.value.trim() });
    showToast('已保存');
  });
  modelRow.appendChild(modelInput);
  section.appendChild(modelRow);

  // 接口地址
  const urlRow = el('div', 'settings-row');
  const urlLeft = el('div');
  urlLeft.appendChild(el('div', 'row-label', '接口地址'));
  urlLeft.appendChild(el('div', 'row-value', '一般不用改，选服务商时自动填好'));
  urlRow.appendChild(urlLeft);
  const urlInput = el('input');
  urlInput.value = settings.baseUrl;
  urlInput.placeholder = 'https://…';
  urlInput.addEventListener('change', () => {
    store.updateSettings({ baseUrl: urlInput.value.trim() });
    showToast('已保存');
    renderSettingsSection();
  });
  urlRow.appendChild(urlInput);
  section.appendChild(urlRow);

  // 锁屏
  const lockRow = el('div', 'settings-row');
  const lockLeft = el('div');
  lockLeft.appendChild(el('div', 'row-label', '锁屏密码'));
  const lockEnabled = store.isLockEnabled();
  lockLeft.appendChild(el('div', 'row-value',
    lockEnabled ? '已开启，打开页面需输入' : '只挡顺手翻看，不是加密'));
  lockRow.appendChild(lockLeft);
  const lockBtns = el('div', 'row-btns');
  const btnLockSet = el('button', 'btn-small', lockEnabled ? '修改' : '设置');
  btnLockSet.addEventListener('click', () => openLockDialog());
  lockBtns.appendChild(btnLockSet);
  if (lockEnabled) {
    const btnLockOff = el('button', 'btn-small', '关闭');
    btnLockOff.addEventListener('click', async () => {
      const yes = await confirmDialog({ title: '关闭锁屏？', confirmText: '关闭' });
      if (!yes) return;
      store.clearLock();
      renderSettingsSection();
      showToast('已关闭锁屏');
    });
    lockBtns.appendChild(btnLockOff);
  }
  lockRow.appendChild(lockBtns);
  section.appendChild(lockRow);

  // 导出
  const exportRow = el('div', 'settings-row');
  exportRow.appendChild(el('div', 'row-label', '导出数据（预设/梗库/设置，不含 Key）'));
  const btnExport = el('button', 'btn-small', '导出 JSON');
  btnExport.addEventListener('click', onExport);
  exportRow.appendChild(btnExport);
  section.appendChild(exportRow);

  // 导入
  const importRow = el('div', 'settings-row');
  importRow.appendChild(el('div', 'row-label', '导入数据（整体覆盖）'));
  const fileInput = el('input');
  fileInput.type = 'file';
  fileInput.accept = '.json,application/json';
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (file) onImport(file);
  });
  const btnImport = el('button', 'btn-small', '选择文件');
  btnImport.addEventListener('click', () => fileInput.click());
  importRow.appendChild(btnImport);
  importRow.appendChild(fileInput);
  section.appendChild(importRow);

  // 清空
  const clearRow = el('div', 'settings-row');
  clearRow.appendChild(el('div', 'row-label', '清空全部数据'));
  const btnClear = el('button', 'btn-small btn-danger', '清空');
  btnClear.addEventListener('click', async () => {
    const yes = await confirmDialog({
      title: '清空全部数据？',
      body: '预设、梗库、设置、API Key、锁屏、当前对话都会被删除，无法恢复。\n（档案文件 data/profiles.js 不受影响）',
      confirmText: '确认清空',
      danger: true,
      requireText: '清空',
    });
    if (!yes) return;
    store.clearAll();
    location.reload();
  });
  clearRow.appendChild(btnClear);
  section.appendChild(clearRow);

  if (!store.isPersistent()) {
    section.appendChild(el('div', 'empty-hint',
      '⚠️ 当前浏览器禁用了本地存储（可能是隐私模式），数据只保存在内存里，关闭页面即丢失。'));
  }

  root.appendChild(section);
}

/** 设置/修改锁屏密码：输两遍，存散列 */
function openLockDialog() {
  const root = document.getElementById('modal-root');
  const overlay = el('div', 'overlay center');
  const dialog = el('div', 'dialog');
  dialog.appendChild(el('div', 'dialog-title', '设置锁屏密码'));
  dialog.appendChild(el('div', 'dialog-body',
    '打开页面时需要输入（浏览器可以帮你记住）。\n它只挡顺手翻看，数据本身不加密；忘了密码可以叫 Claude 帮你解锁。'));

  const pw1 = el('input');
  pw1.type = 'password';
  pw1.placeholder = '新密码';
  pw1.autocomplete = 'new-password';
  dialog.appendChild(pw1);
  const pw2 = el('input');
  pw2.type = 'password';
  pw2.placeholder = '再输一遍';
  pw2.autocomplete = 'new-password';
  dialog.appendChild(pw2);

  const actions = el('div', 'dialog-actions');
  const btnCancel = el('button', 'dialog-cancel', '取消');
  const btnOk = el('button', 'dialog-confirm', '保存');
  actions.appendChild(btnCancel);
  actions.appendChild(btnOk);
  dialog.appendChild(actions);
  overlay.appendChild(dialog);
  root.appendChild(overlay);
  setTimeout(() => pw1.focus(), 50);

  btnCancel.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  btnOk.addEventListener('click', async () => {
    const v = pw1.value;
    if (!v) { pw1.focus(); return; }
    if (v !== pw2.value) { showToast('两次输入不一致'); pw2.focus(); return; }
    try {
      await store.setLockPassword(v);
    } catch (e) {
      showToast(e.userMessage || '保存失败');
      return;
    }
    overlay.remove();
    renderSettingsSection();
    showToast('已开启锁屏，下次打开页面时需要输入');
  });
}

function onExport() {
  const data = store.exportData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date();
  const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  a.href = url;
  a.download = `muchat-backup-${dateStr}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  showToast('已导出');
}

function onImport(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    let parsed;
    try {
      parsed = JSON.parse(reader.result);
    } catch {
      showToast('文件不是有效的 JSON');
      return;
    }
    const preview = store.buildImportPreview(parsed);
    if (!preview.ok) {
      showToast(preview.error, { duration: 3000 });
      return;
    }
    const yes = await confirmDialog({
      title: '确认导入？',
      body: `当前：${preview.current.presets} 个预设、${preview.current.memes} 条梗\n` +
        `导入后：${preview.incoming.presets} 个预设、${preview.incoming.memes} 条梗\n\n` +
        (preview.hasLegacyProfiles
          ? '备份里的档案不会导入（档案现在存在 data/profiles.js 文件里）。\n' : '') +
        '本机数据将被整体覆盖。',
      confirmText: '覆盖导入',
      danger: true,
    });
    if (!yes) return;
    try {
      store.importData(parsed);
    } catch (e) {
      showToast(e.userMessage || '导入失败');
      return;
    }
    expanded = null;
    refreshManageView();
    dataChanged();
    showToast('导入完成');
  };
  reader.onerror = () => showToast('读取文件失败');
  reader.readAsText(file);
}
