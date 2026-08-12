/**
 * storage.js — 纯数据层。
 * 全应用唯一接触 localStorage 的模块；不 import 任何其他模块，不做 DOM 操作。
 * 将来的"素材路由"功能直接复用本模块。
 */

const KEYS = {
  profiles: 'muchat.profiles',
  presets: 'muchat.presets',
  settings: 'muchat.settings',
  session: 'muchat.session',
};

const SCHEMA_VERSION = 1;
export const DEFAULT_MODEL = 'claude-sonnet-4-6';

export class StorageFullError extends Error {
  constructor() {
    super('本地存储已满');
    this.userMessage = '本地存储已满，请先导出备份，再删除一些旧档案';
  }
}

/* ---------- localStorage 触点（含隐私模式降级） ---------- */

const memoryStore = new Map();
let persistent = true;
try {
  const probe = 'muchat.__probe__';
  localStorage.setItem(probe, '1');
  localStorage.removeItem(probe);
} catch {
  persistent = false;
}

/** 存储是否真正持久化（Safari 隐私模式等场景为 false，数据仅在内存中） */
export function isPersistent() {
  return persistent;
}

function rawGet(key) {
  if (!persistent) return memoryStore.has(key) ? memoryStore.get(key) : null;
  return localStorage.getItem(key);
}

function rawSet(key, str) {
  if (!persistent) { memoryStore.set(key, str); return; }
  try {
    localStorage.setItem(key, str);
  } catch (e) {
    throw new StorageFullError();
  }
}

function rawRemove(key) {
  if (!persistent) { memoryStore.delete(key); return; }
  localStorage.removeItem(key);
}

function read(key, fallback) {
  const raw = rawGet(key);
  if (raw === null) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  rawSet(key, JSON.stringify(value));
}

function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16)) +
    '-' + Date.now().toString(16);
}

function now() {
  return new Date().toISOString();
}

/* ---------- 档案 ---------- */

function readProfiles() {
  return read(KEYS.profiles, { schemaVersion: SCHEMA_VERSION, items: [] });
}

function writeProfiles(doc) {
  write(KEYS.profiles, doc);
}

export function listProfiles() {
  return readProfiles().items.slice();
}

export function getProfile(id) {
  return readProfiles().items.find((p) => p.id === id) || null;
}

export function createProfile({ name, tier, interests = '', memories = '', style = '', goal = '', notes = '' }) {
  const doc = readProfiles();
  const profile = {
    id: 'p_' + uuid(),
    name: String(name || '').trim(),
    tier: Number(tier) || 3,
    interests, memories, style, goal, notes,
    lastContactAt: null,
    createdAt: now(),
    updatedAt: now(),
  };
  doc.items.push(profile);
  writeProfiles(doc);
  return profile;
}

export function updateProfile(id, patch) {
  const doc = readProfiles();
  const p = doc.items.find((x) => x.id === id);
  if (!p) return null;
  Object.assign(p, patch, { id: p.id, updatedAt: now() });
  writeProfiles(doc);
  return p;
}

export function deleteProfile(id) {
  const doc = readProfiles();
  doc.items = doc.items.filter((x) => x.id !== id);
  writeProfiles(doc);
}

export function touchLastContact(id, when = new Date()) {
  return updateProfile(id, { lastContactAt: when.toISOString() });
}

/**
 * 把要点以日期前缀追加进自由备注。lines: string[]（不带 "- " 前缀）。
 * 总结功能与将来的素材路由沉淀素材共用这一个入口。
 */
export function appendToNotes(id, lines, { touch = true } = {}) {
  const p = getProfile(id);
  if (!p) return null;
  const clean = lines.map((l) => String(l).trim()).filter(Boolean);
  if (!clean.length) return p;
  const d = new Date();
  const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const block = `【${dateStr}】\n` + clean.map((l) => `- ${l}`).join('\n');
  const notes = p.notes && p.notes.trim() ? p.notes.replace(/\s+$/, '') + '\n\n' + block : block;
  const patch = { notes };
  if (touch) patch.lastContactAt = now();
  return updateProfile(id, patch);
}

/* ---------- 预设身份 ---------- */

const DEFAULT_PRESETS = [
  {
    name: 'b站男网友',
    description: '在B站认识的男性网友，因为我发的像素游戏内容认识的，默认他对像素游戏感兴趣。聊天氛围轻松随意，网络用语和梗随便用，可以互相调侃，不用客气也不用热情过头，就像同好之间瞎聊。',
  },
  {
    name: '女神',
    description: '新认识的好看女生，我想多了解她、增进关系。语气自然友好、可以带一点幽默，表现出对她这个人的兴趣而不只是客套。但务必注意分寸：不油腻、不查户口、不连环追问、不过度殷勤，消息别太长，给她留回复空间。',
  },
  {
    name: '老师/前辈',
    description: '德高望重的老师或前辈。语气谦虚、尊重、得体，称呼用"您"，措辞完整，不用网络梗、不发表情包轰炸。请教和感谢要诚恳，但不要卑微到谄媚，正常表达即可。',
  },
];

function readPresets() {
  return read(KEYS.presets, { schemaVersion: SCHEMA_VERSION, items: [] });
}

function writePresets(doc) {
  write(KEYS.presets, doc);
}

/** 首次运行播种默认预设；之后即使删光也不再补种 */
export function ensureDefaultPresets() {
  if (rawGet(KEYS.presets) !== null) return;
  const doc = { schemaVersion: SCHEMA_VERSION, items: [] };
  for (const d of DEFAULT_PRESETS) {
    doc.items.push({
      id: 's_' + uuid(),
      name: d.name,
      description: d.description,
      builtin: true,
      createdAt: now(),
      updatedAt: now(),
    });
  }
  writePresets(doc);
}

export function listPresets() {
  return readPresets().items.slice();
}

export function getPreset(id) {
  return readPresets().items.find((s) => s.id === id) || null;
}

export function createPreset({ name, description = '' }) {
  const doc = readPresets();
  const preset = {
    id: 's_' + uuid(),
    name: String(name || '').trim(),
    description,
    builtin: false,
    createdAt: now(),
    updatedAt: now(),
  };
  doc.items.push(preset);
  writePresets(doc);
  return preset;
}

export function updatePreset(id, patch) {
  const doc = readPresets();
  const s = doc.items.find((x) => x.id === id);
  if (!s) return null;
  Object.assign(s, patch, { id: s.id, updatedAt: now() });
  writePresets(doc);
  return s;
}

export function deletePreset(id) {
  const doc = readPresets();
  doc.items = doc.items.filter((x) => x.id !== id);
  writePresets(doc);
}

/* ---------- 统一取"人物"（素材路由将同样按 {type,id} 引用） ---------- */

/**
 * ref: {type:'profile'|'preset', id} | null
 * -> null | {kind:'profile', profile} | {kind:'preset', preset}
 * 引用悬空（已被删）时返回 null，调用方据此清掉选择。
 */
export function resolvePersona(ref) {
  if (!ref || !ref.id) return null;
  if (ref.type === 'profile') {
    const profile = getProfile(ref.id);
    return profile ? { kind: 'profile', profile } : null;
  }
  if (ref.type === 'preset') {
    const preset = getPreset(ref.id);
    return preset ? { kind: 'preset', preset } : null;
  }
  return null;
}

/* ---------- 设置 ---------- */

export function getSettings() {
  const doc = read(KEYS.settings, {});
  return {
    apiKey: doc.apiKey || '',
    model: doc.model || DEFAULT_MODEL,
  };
}

export function updateSettings(patch) {
  const cur = getSettings();
  const next = { schemaVersion: SCHEMA_VERSION, ...cur, ...patch };
  if (!next.model || !String(next.model).trim()) next.model = DEFAULT_MODEL;
  write(KEYS.settings, next);
  return { apiKey: next.apiKey, model: next.model };
}

/* ---------- 会话草稿 ---------- */

function emptySession() {
  return {
    schemaVersion: SCHEMA_VERSION,
    selected: null,            // {type:'profile'|'preset', id} | null
    firstRole: 'them',         // 第 i 框角色 = i 偶数取 firstRole，否则相反
    messages: [{ text: '' }],
    opinion: '',
    lastResult: null,          // {situationRead, candidates:[{intent,messages}]} | {raw}
    lastSummary: null,         // 可编辑总结框当前文本
    updatedAt: null,
  };
}

export function getSession() {
  const doc = read(KEYS.session, null);
  if (!doc) return emptySession();
  const base = emptySession();
  const s = { ...base, ...doc };
  if (!Array.isArray(s.messages) || !s.messages.length) s.messages = [{ text: '' }];
  s.messages = s.messages.map((m) => ({ text: typeof m.text === 'string' ? m.text : '' }));
  if (s.firstRole !== 'them' && s.firstRole !== 'me') s.firstRole = 'them';
  return s;
}

export function saveSession(session) {
  write(KEYS.session, { ...session, schemaVersion: SCHEMA_VERSION, updatedAt: now() });
}

export function clearSessionDraft({ keepSelection = true } = {}) {
  const cur = getSession();
  const next = emptySession();
  if (keepSelection) next.selected = cur.selected;
  saveSession(next);
  return next;
}

/* ---------- 导入导出 / 清空 ---------- */

/** 导出全部数据（明确不含 apiKey） */
export function exportData() {
  return {
    app: 'muchat',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: now(),
    profiles: listProfiles(),
    presets: listPresets(),
    settings: { model: getSettings().model },
  };
}

/** 校验导入内容并给出数量对比；不写入任何数据 */
export function buildImportPreview(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: '文件内容不是有效的 JSON 对象' };
  }
  if (parsed.app !== 'muchat') {
    return { ok: false, error: '这不是本应用导出的备份文件' };
  }
  if (typeof parsed.schemaVersion === 'number' && parsed.schemaVersion > SCHEMA_VERSION) {
    return { ok: false, error: '备份来自更新版本的应用，请先升级本页面' };
  }
  if (!Array.isArray(parsed.profiles) || !Array.isArray(parsed.presets)) {
    return { ok: false, error: '备份文件缺少档案或预设数据' };
  }
  return {
    ok: true,
    current: { profiles: listProfiles().length, presets: listPresets().length },
    incoming: { profiles: parsed.profiles.length, presets: parsed.presets.length },
  };
}

/** 整体覆盖导入（调用前必须先经 buildImportPreview 校验并由用户确认） */
export function importData(parsed) {
  writeProfiles({ schemaVersion: SCHEMA_VERSION, items: parsed.profiles });
  writePresets({ schemaVersion: SCHEMA_VERSION, items: parsed.presets });
  if (parsed.settings && parsed.settings.model) {
    updateSettings({ model: parsed.settings.model });
  }
  // 会话草稿里选中的人物可能已不存在，交由 resolvePersona 兜底，无需清空草稿
}

/** 清空全部数据（含 key 与草稿） */
export function clearAll() {
  for (const key of Object.values(KEYS)) rawRemove(key);
}
