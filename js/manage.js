/**
 * manage.js — 档案管理页：档案 CRUD、预设身份、设置（key/模型/导入导出/清空）。
 */

import * as store from './storage.js';
import { TIER_LABELS } from './prompts.js';
import { el, showToast, confirmDialog, promptApiKey, fmtRelative } from './ui.js';

let refs = {};
// 当前展开的编辑项：{type:'profile'|'preset'|'new-profile'|'new-preset', id?}
let expanded = null;

export function initManageView() {
  refs = {
    profiles: document.getElementById('profiles-section'),
    presets: document.getElementById('presets-section'),
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
  renderSettingsSection();
}

function dataChanged() {
  document.dispatchEvent(new CustomEvent('muchat:data-changed', { detail: { source: 'manage' } }));
}

/* ============ 档案 ============ */

function renderProfilesSection() {
  const root = refs.profiles;
  root.innerHTML = '';
  const section = el('div', 'manage-section');

  const head = el('div', 'manage-section-head');
  head.appendChild(el('h2', '', '档案'));
  const btnNew = el('button', 'btn-secondary', '＋ 新建档案');
  btnNew.addEventListener('click', () => {
    expanded = { type: 'new-profile' };
    renderProfilesSection();
  });
  head.appendChild(btnNew);
  section.appendChild(head);

  if (expanded && expanded.type === 'new-profile') {
    const card = el('div', 'entity-card');
    card.appendChild(buildProfileForm(null));
    section.appendChild(card);
  }

  const profiles = store.listProfiles();
  if (!profiles.length && !(expanded && expanded.type === 'new-profile')) {
    section.appendChild(el('div', 'empty-hint', '还没有档案。点右上角新建，或在回复页的人物选择器里快捷创建。'));
  }

  for (const tier of [1, 2, 3]) {
    const group = profiles.filter((p) => p.tier === tier);
    if (!group.length) continue;
    section.appendChild(el('div', 'group-title', TIER_LABELS[tier]));
    for (const p of group) {
      section.appendChild(buildProfileCard(p));
    }
  }
  // 层级异常的兜底显示
  const others = profiles.filter((p) => ![1, 2, 3].includes(p.tier));
  for (const p of others) section.appendChild(buildProfileCard(p));

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
    card.appendChild(buildProfileForm(p));
  }
  return card;
}

/** p 为 null 时表示新建 */
function buildProfileForm(p) {
  const form = el('div', 'edit-form');

  const fields = {};
  const addField = (label, key, { textarea = false, rows = 2, placeholder = '' } = {}) => {
    form.appendChild(el('div', 'field-label', label));
    const input = textarea ? el('textarea') : el('input');
    if (textarea) input.rows = rows;
    input.placeholder = placeholder;
    input.value = p ? (p[key] || '') : '';
    form.appendChild(input);
    fields[key] = input;
  };

  addField('备注名', 'name', { placeholder: '必填' });

  form.appendChild(el('div', 'field-label', '关系层级'));
  const seg = el('div', 'segmented');
  let tier = p ? p.tier : 3;
  const segBtns = [1, 2, 3].map((t) => {
    const b = el('button', t === tier ? 'active' : '', TIER_LABELS[t]);
    b.addEventListener('click', () => {
      tier = t;
      segBtns.forEach((x, i) => x.classList.toggle('active', i + 1 === t));
    });
    seg.appendChild(b);
    return b;
  });
  form.appendChild(seg);

  addField('他关心什么', 'interests', { textarea: true, placeholder: '兴趣、在意的事' });
  addField('共同经历和梗', 'memories', { textarea: true, placeholder: '一起做过的事、只有你们懂的梗' });
  addField('发消息风格', 'style', { textarea: true, placeholder: '称呼、语气、表情习惯、分寸禁忌' });
  addField('我对这个人的目的', 'goal', { textarea: true, placeholder: '想维持/加深关系？想合作？想请教？' });
  addField('自由备注', 'notes', { textarea: true, rows: 4, placeholder: '沉淀的判断素材，总结要点也会追加到这里' });

  const actions = el('div', 'form-actions');
  const btnSave = el('button', 'btn-secondary', '保存');
  btnSave.style.color = 'var(--green-dark)';
  btnSave.addEventListener('click', () => {
    const name = fields.name.value.trim();
    if (!name) { showToast('备注名不能为空'); return; }
    const data = {
      name, tier,
      interests: fields.interests.value,
      memories: fields.memories.value,
      style: fields.style.value,
      goal: fields.goal.value,
      notes: fields.notes.value,
    };
    try {
      if (p) store.updateProfile(p.id, data);
      else store.createProfile(data);
    } catch (e) {
      showToast(e.userMessage || '保存失败');
      return;
    }
    expanded = null;
    renderProfilesSection();
    dataChanged();
    showToast('已保存');
  });
  actions.appendChild(btnSave);

  if (p) {
    const btnDelete = el('button', 'btn-secondary btn-danger', '删除');
    btnDelete.addEventListener('click', async () => {
      const yes = await confirmDialog({
        title: `删除「${p.name}」？`,
        body: '档案和备注会被删除，无法恢复。',
        confirmText: '删除',
        danger: true,
      });
      if (!yes) return;
      store.deleteProfile(p.id);
      expanded = null;
      renderProfilesSection();
      dataChanged();
      showToast('已删除');
    });
    actions.appendChild(btnDelete);
  }

  const btnCollapse = el('button', 'btn-secondary', '收起');
  btnCollapse.addEventListener('click', () => {
    expanded = null;
    renderProfilesSection();
  });
  actions.appendChild(btnCollapse);

  form.appendChild(actions);
  return form;
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
  modelLeft.appendChild(el('div', 'row-value', `默认 ${store.DEFAULT_MODEL}`));
  modelRow.appendChild(modelLeft);
  const modelInput = el('input');
  modelInput.value = settings.model;
  modelInput.placeholder = store.DEFAULT_MODEL;
  modelInput.addEventListener('change', () => {
    store.updateSettings({ model: modelInput.value.trim() });
    modelInput.value = store.getSettings().model;
    showToast('已保存');
  });
  modelRow.appendChild(modelInput);
  section.appendChild(modelRow);

  // 导出
  const exportRow = el('div', 'settings-row');
  exportRow.appendChild(el('div', 'row-label', '导出全部数据（不含 Key）'));
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
      body: '档案、预设、设置、API Key、当前对话都会被删除，无法恢复。',
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
      body: `当前：${preview.current.profiles} 个档案、${preview.current.presets} 个预设\n` +
        `导入后：${preview.incoming.profiles} 个档案、${preview.incoming.presets} 个预设\n\n` +
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
