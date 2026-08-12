/**
 * storage.js — 纯数据层。
 * 全应用唯一接触 localStorage 的模块；不 import 任何其他模块，不做 DOM 操作。
 * 将来的"素材路由"功能直接复用本模块。
 */

const KEYS = {
  profiles: 'muchat.profiles',      // 旧版遗留：档案已迁到 data/profiles.js 文件，此 key 只用于一次性迁移
  presets: 'muchat.presets',
  settings: 'muchat.settings',
  session: 'muchat.session',
  memes: 'muchat.memes',
  lastContact: 'muchat.lastContact', // {profileId: iso} 使用痕迹，不算档案内容
  lock: 'muchat.lock',               // {salt, hash} 锁屏密码
};

const SCHEMA_VERSION = 1;

/** 默认服务商：DeepSeek（国内可直接支付、浏览器可直连、便宜） */
export const DEFAULT_SETTINGS = {
  provider: 'openai',                    // 协议：'openai' | 'anthropic'
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
};

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

/* ---------- 档案（存本地文件 data/profiles.js，页面只读） ---------- */

let fileProfiles = [];
let fileMemes = [];

function cleanStr(v) {
  return typeof v === 'string' ? v : (v == null ? '' : String(v));
}

/**
 * 加载本地档案文件。文件不存在（新环境 / 线上部署）时静默降级为空档案。
 * 必须在 app 初始化视图前 await 一次。
 */
export async function loadLocalData() {
  let mod = null;
  try {
    // 带时间戳绕开浏览器的模块缓存，保证"改完文件刷新就生效"
    mod = await import('../data/profiles.js?t=' + Date.now());
  } catch {
    return;
  }
  const items = Array.isArray(mod.profiles) ? mod.profiles : [];
  fileProfiles = items
    .filter((p) => p && cleanStr(p.name).trim())
    .map((p) => ({
      id: 'pf_' + cleanStr(p.name).trim(),
      name: cleanStr(p.name).trim(),
      tier: [1, 2, 3].includes(Number(p.tier)) ? Number(p.tier) : 3,
      interests: cleanStr(p.interests),
      memories: cleanStr(p.memories),
      style: cleanStr(p.style),
      goal: cleanStr(p.goal),
      notes: cleanStr(p.notes),
    }));
  fileMemes = (Array.isArray(mod.memes) ? mod.memes : [])
    .map((t) => cleanStr(t).trim())
    .filter(Boolean);
}

export function listProfiles() {
  const lc = read(KEYS.lastContact, {});
  return fileProfiles.map((p) => ({ ...p, lastContactAt: lc[p.id] || null }));
}

export function getProfile(id) {
  return listProfiles().find((p) => p.id === id) || null;
}

export function touchLastContact(id, when = new Date()) {
  const lc = read(KEYS.lastContact, {});
  lc[id] = when.toISOString();
  write(KEYS.lastContact, lc);
}

/* 旧版档案存在 localStorage 里，只留读取和清除两个口子给迁移用 */

export function listLegacyProfiles() {
  const doc = read(KEYS.profiles, { items: [] });
  return Array.isArray(doc.items) ? doc.items : [];
}

export function clearLegacyProfiles() {
  rawRemove(KEYS.profiles);
}

/* ---------- 梗库（文件里的 + 页面随手存的） ---------- */

function readMemes() {
  return read(KEYS.memes, { schemaVersion: SCHEMA_VERSION, items: [] });
}

/** 文件版排前面（不可在页面删除），localStorage 版排后面 */
export function listMemes() {
  const local = readMemes().items || [];
  return [
    ...fileMemes.map((text, i) => ({ id: 'mf_' + i, text, fromFile: true })),
    ...local,
  ];
}

export function addMeme(text) {
  const t = cleanStr(text).trim();
  if (!t) return null;
  const doc = readMemes();
  const meme = { id: 'm_' + uuid(), text: t, createdAt: now() };
  doc.items.push(meme);
  write(KEYS.memes, doc);
  return meme;
}

export function deleteMeme(id) {
  const doc = readMemes();
  doc.items = doc.items.filter((m) => m.id !== id);
  write(KEYS.memes, doc);
}

/* ---------- 锁屏（挡一下顺手翻看的门帘，不是加密） ---------- */

async function hashPassword(salt, password) {
  const data = salt + '::' + password;
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // 非安全上下文没有 subtle，退化为简单散列（锁屏本来就只防顺手翻看）
  let h = 0;
  for (let i = 0; i < data.length; i++) h = (h * 31 + data.charCodeAt(i)) | 0;
  return 'x' + (h >>> 0).toString(16);
}

export function isLockEnabled() {
  return read(KEYS.lock, null) !== null;
}

export async function setLockPassword(password) {
  const salt = uuid();
  const hash = await hashPassword(salt, password);
  write(KEYS.lock, { salt, hash });
}

export function clearLock() {
  rawRemove(KEYS.lock);
}

export async function verifyLockPassword(password) {
  const c = read(KEYS.lock, null);
  if (!c) return true;
  return (await hashPassword(c.salt, password)) === c.hash;
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
  // 旧版本只存了 model（Anthropic 时代）的兼容
  if (!doc.provider && doc.model && String(doc.model).startsWith('claude')) {
    return {
      apiKey: doc.apiKey || '',
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      model: doc.model,
    };
  }
  return {
    apiKey: doc.apiKey || '',
    provider: doc.provider || DEFAULT_SETTINGS.provider,
    baseUrl: doc.baseUrl !== undefined ? doc.baseUrl : DEFAULT_SETTINGS.baseUrl,
    model: doc.model !== undefined ? doc.model : DEFAULT_SETTINGS.model,
  };
}

export function updateSettings(patch) {
  const cur = getSettings();
  const next = { schemaVersion: SCHEMA_VERSION, ...cur, ...patch };
  write(KEYS.settings, next);
  return getSettings();
}

/* ---------- 会话草稿 ---------- */

function emptySession() {
  return {
    schemaVersion: SCHEMA_VERSION,
    selected: null,            // {type:'profile'|'preset', id} | null
    firstRole: 'them',         // 待发送粘贴框第 i 框角色 = i 偶数取 firstRole，否则相反
    convo: [{ text: '' }],     // 待发送的新消息粘贴框（时间线底部）
    convoMode: 'delta',        // 标记 chat 里 user 轮的 convo 是增量（旧数据是全量快照）
    // 与参谋的对话。user 轮: {role:'user', text, convo:[{role:'them'|'me',text}]|null}
    // convo 是该轮新贴的微信消息（增量）；assistant 轮: {role, content}
    chat: [],
    inputDraft: '',            // 输入框未发送的草稿
    updatedAt: null,
  };
}

export function getSession() {
  const doc = read(KEYS.session, null);
  if (!doc) return emptySession();
  const s = emptySession();
  if (doc.selected && doc.selected.id) s.selected = doc.selected;

  // 粘贴框工作区：当前版的 convo，或最初表单版的 messages
  const boxes = Array.isArray(doc.convo) ? doc.convo
    : (Array.isArray(doc.messages) ? doc.messages : null);
  if (boxes) {
    s.convo = boxes.map((m) => ({ text: m && typeof m.text === 'string' ? m.text : '' }));
  }
  if (!s.convo.length) s.convo = [{ text: '' }];
  s.firstRole = doc.firstRole === 'me' ? 'me' : 'them';

  if (Array.isArray(doc.chat)) {
    s.chat = doc.chat.map((m) => {
      if (!m) return null;
      if (m.role === 'assistant') {
        return typeof m.content === 'string' && m.content.trim()
          ? { role: 'assistant', content: m.content } : null;
      }
      if (m.role !== 'user') return null;
      // 纯聊天版的 user 轮存在 content 里，折算成 text
      const text = typeof m.text === 'string' ? m.text
        : (typeof m.content === 'string' ? m.content : '');
      const convo = Array.isArray(m.convo)
        ? m.convo
          .filter((x) => x && (x.role === 'them' || x.role === 'me')
            && typeof x.text === 'string' && x.text.trim())
          .map((x) => ({ role: x.role, text: x.text }))
        : null;
      if (!text.trim() && !(convo && convo.length)) return null;
      return { role: 'user', text, convo: convo && convo.length ? convo : null };
    }).filter(Boolean);
  }

  if (typeof doc.inputDraft === 'string') s.inputDraft = doc.inputDraft;
  else if (typeof doc.opinion === 'string') s.inputDraft = doc.opinion; // 表单版的「我的看法」

  if (doc.convoMode !== 'delta') migrateSnapshotsToDeltas(s);
  return s;
}

/**
 * 全量快照版会话 → 增量版：
 * user 轮的 convo 从"截至当轮的完整记录"裁成"该轮新增"；
 * 粘贴框工作区裁掉已发送过的部分，只留未发送的尾巴。
 */
function migrateSnapshotsToDeltas(s) {
  let prev = [];
  for (const m of s.chat) {
    if (m.role !== 'user' || !m.convo) continue;
    const full = m.convo;
    const isPrefix = prev.length <= full.length
      && prev.every((x, i) => x.role === full[i].role && x.text === full[i].text);
    const delta = isPrefix ? full.slice(prev.length) : full;
    prev = full;
    m.convo = delta.length ? delta : null;
  }
  s.chat = s.chat.filter((m) => m.role !== 'user' || m.text.trim() || (m.convo && m.convo.length));

  const other = s.firstRole === 'them' ? 'me' : 'them';
  const collected = s.convo
    .map((m, i) => ({ role: i % 2 === 0 ? s.firstRole : other, text: (m.text || '').trim() }))
    .filter((x) => x.text);
  const tail = collected.slice(prev.length);
  if (tail.length) {
    s.convo = tail.map((x) => ({ text: x.text }));
    s.firstRole = tail[0].role;
  } else {
    s.convo = [{ text: '' }];
    if (prev.length) {
      s.firstRole = prev[prev.length - 1].role === 'them' ? 'me' : 'them';
    }
  }
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

/** 导出全部数据（明确不含 apiKey；档案在 data/profiles.js 文件里，不经这里） */
export function exportData() {
  const { provider, baseUrl, model } = getSettings();
  return {
    app: 'muchat',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: now(),
    presets: listPresets(),
    memes: readMemes().items,
    settings: { provider, baseUrl, model },
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
  if (!Array.isArray(parsed.presets)) {
    return { ok: false, error: '备份文件缺少预设数据' };
  }
  const incomingMemes = Array.isArray(parsed.memes) ? parsed.memes.length : 0;
  return {
    ok: true,
    // 旧版备份里的 profiles 不再导入（档案在 data/profiles.js 文件里）
    hasLegacyProfiles: Array.isArray(parsed.profiles) && parsed.profiles.length > 0,
    current: { presets: listPresets().length, memes: readMemes().items.length },
    incoming: { presets: parsed.presets.length, memes: incomingMemes },
  };
}

/** 整体覆盖导入（调用前必须先经 buildImportPreview 校验并由用户确认） */
export function importData(parsed) {
  writePresets({ schemaVersion: SCHEMA_VERSION, items: parsed.presets });
  if (Array.isArray(parsed.memes)) {
    write(KEYS.memes, { schemaVersion: SCHEMA_VERSION, items: parsed.memes });
  }
  if (parsed.settings && typeof parsed.settings === 'object') {
    const patch = {};
    for (const k of ['provider', 'baseUrl', 'model']) {
      if (typeof parsed.settings[k] === 'string') patch[k] = parsed.settings[k];
    }
    if (Object.keys(patch).length) updateSettings(patch);
  }
  // 会话草稿里选中的人物可能已不存在，交由 resolvePersona 兜底，无需清空草稿
}

/** 清空全部数据（含 key、草稿、锁屏；不动 data/profiles.js 文件） */
export function clearAll() {
  for (const key of Object.values(KEYS)) rawRemove(key);
}
