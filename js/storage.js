/**
 * storage.js — 纯数据层。
 * 全应用唯一接触 localStorage 的模块；不 import 任何其他模块，不做 DOM 操作。
 * 将来的"素材路由"功能直接复用本模块。
 */

const KEYS = {
  profiles: 'muchat.profiles',      // 旧版遗留：档案已迁到 data/profiles.js 文件，此 key 只用于一次性迁移
  presets: 'muchat.presets',        // 旧版遗留：预设已被文件里的人物类别取代，加载时清除
  // 导入的档案副本：给没有档案文件的环境用（手机上的线上版）。有文件时文件优先，这份不生效。
  profilesImport: 'muchat.profilesImport',
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

let fileMe = null;
let fileCategories = [];
let fileProfiles = [];
let fileMemes = [];
let dataSource = 'none';   // 'file' 档案文件 | 'imported' 本设备导入的副本 | 'none'
let fileLoadError = '';    // 档案文件加载失败的原因（文件不存在，或文件里有语法错误）

function cleanStr(v) {
  return typeof v === 'string' ? v : (v == null ? '' : String(v));
}

/** 把一份 {me, categories, profiles, memes} 规范化后装进模块状态 */
function applyLocalData(src) {
  const meRaw = src.me && typeof src.me === 'object' ? src.me : null;
  fileMe = meRaw && cleanStr(meRaw.background).trim()
    ? { name: cleanStr(meRaw.name).trim(), background: cleanStr(meRaw.background).trim() }
    : null;
  fileCategories = (Array.isArray(src.categories) ? src.categories : [])
    .filter((c) => c && cleanStr(c.name).trim())
    .map((c) => ({
      id: 'ct_' + cleanStr(c.name).trim(),
      name: cleanStr(c.name).trim(),
      description: cleanStr(c.description),
      reveal: cleanStr(c.reveal),
    }));
  fileProfiles = (Array.isArray(src.profiles) ? src.profiles : [])
    .filter((p) => p && cleanStr(p.name).trim())
    .map((p) => ({
      id: 'pf_' + cleanStr(p.name).trim(),
      name: cleanStr(p.name).trim(),
      tier: [1, 2, 3].includes(Number(p.tier)) ? Number(p.tier) : 3,
      category: cleanStr(p.category).trim(),
      interests: cleanStr(p.interests),
      memories: cleanStr(p.memories),
      style: cleanStr(p.style),
      goal: cleanStr(p.goal),
      notes: cleanStr(p.notes),
    }));
  fileMemes = (Array.isArray(src.memes) ? src.memes : [])
    .map((t) => cleanStr(t).trim())
    .filter(Boolean);
}

/**
 * 加载档案数据。优先本地档案文件 data/profiles.js（电脑上的唯一真相源）；
 * 文件不存在时（手机上的线上版：该文件被 gitignore，从不发布）退回本设备导入的副本。
 * 必须在 app 初始化视图前 await 一次。
 */
export async function loadLocalData() {
  // 旧版把预设身份存在 localStorage；已被文件里的人物类别取代，顺手清掉
  rawRemove(KEYS.presets);

  let mod = null;
  try {
    // 带时间戳绕开浏览器的模块缓存，保证"改完文件刷新就生效"
    mod = await import('../data/profiles.js?t=' + Date.now());
  } catch (e) {
    fileLoadError = (e && e.message) ? String(e.message) : '未知原因';
  }

  if (mod) {
    applyLocalData(mod);
    dataSource = 'file';
    return;
  }
  const imported = read(KEYS.profilesImport, null);
  if (imported && typeof imported === 'object') {
    applyLocalData(imported);
    dataSource = 'imported';
    return;
  }
  dataSource = 'none';
}

/**
 * 内置人物类别：写死在代码里，随应用一起发布，所以任何设备（手机上的线上版）
 * 不导入档案也能直接用。注意仓库是公开的——这里只能写通用打法，
 * 任何私人信息（真名、学校、成就、个人经历）都必须留在 data/profiles.js 里。
 * 档案文件里出现同名类别时以文件为准（覆盖内置）。
 */
const BUILTIN_CATEGORIES = [
  {
    name: 'Hinge女生',
    description:
      '约会软件（Hinge）上匹配到的女生，直接认识、没有共同朋友做背书。' +
      '双方都清楚这是奔着约会来的，所以不用假装偶遇，但也别一上来就热情过头。' +
      '基调：轻、短、有来有回，像两个还不熟但聊得来的人在互相试探。' +
      '开场从她主页里的具体一点切入（照片里的地方、她写的 prompt、她提到的爱好），' +
      '绝不用 hey / how are you / 在吗 这种零信息开场。' +
      '夸要夸具体的东西——她做的事、她的品味、她刚说的那句话；' +
      '夸长相（"你好漂亮"这类）廉价且掉价，除非她自己先把话题引过去。' +
      '不查户口、不连环追问、不长篇大论、不过早交心。消息比她的略短或持平，别把天聊成采访。' +
      '聊出共同点、气氛松弛之后，自然地把线下提出来（咖啡、散步这种低压力、短时长的），' +
      '别拖太久变成笔友——约会软件上拖着聊等于慢性死亡。' +
      '她回复变短、变慢、变敷衍时，绝不加倍热情去追，降频、给台阶，或者干脆收，' +
      '追得越紧越掉价。',
    reveal:
      '不主动倒自己的履历和成就，她问起再说，说完一句就把话头递回去。' +
      '私人信息（具体住处、学校细节、社交账号、工作单位）循序渐进，头几轮别全交出去。',
  },
];

/** 'file' | 'imported' | 'none' */
export function getDataSource() {
  return dataSource;
}

/** 档案文件加载失败的原因；成功加载时为空串 */
export function getFileLoadError() {
  return dataSource === 'file' ? '' : fileLoadError;
}

/* ---- 档案的导出 / 导入（电脑导出一份，手机导入后只读使用） ---- */

const PROFILES_BUNDLE_APP = 'muchat-profiles';

/** 打包当前生效的档案数据，用于拷到别的设备（含全部私人内容，别外传） */
export function exportProfilesBundle() {
  return {
    app: PROFILES_BUNDLE_APP,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: now(),
    me: fileMe ? { name: fileMe.name, background: fileMe.background } : {},
    categories: fileCategories.map(({ name, description, reveal }) => ({ name, description, reveal })),
    profiles: fileProfiles.map(({ id, ...rest }) => rest),
    memes: fileMemes.slice(),
  };
}

/** 校验一份档案包；ok 时附带条目数量供确认 */
export function buildProfilesImportPreview(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: '内容不是有效的 JSON 对象' };
  }
  if (parsed.app !== PROFILES_BUNDLE_APP) {
    return { ok: false, error: '这不是档案文件（应该是「导出档案」下载的那份 JSON）' };
  }
  if (typeof parsed.schemaVersion === 'number' && parsed.schemaVersion > SCHEMA_VERSION) {
    return { ok: false, error: '档案来自更新版本的应用，请先升级本页面' };
  }
  const count = (v) => (Array.isArray(v) ? v.length : 0);
  return {
    ok: true,
    incoming: {
      profiles: count(parsed.profiles),
      categories: count(parsed.categories),
      memes: count(parsed.memes),
      hasMe: !!(parsed.me && cleanStr(parsed.me.background).trim()),
    },
    current: { profiles: fileProfiles.length, categories: fileCategories.length },
  };
}

/**
 * 存下并立即启用导入的档案（调用前先经 buildProfilesImportPreview 校验）。
 * 本机有档案文件时文件仍然优先，这份只是存着，供没有文件的设备使用。
 */
export function importProfilesBundle(parsed) {
  write(KEYS.profilesImport, {
    me: parsed.me || {},
    categories: Array.isArray(parsed.categories) ? parsed.categories : [],
    profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [],
    memes: Array.isArray(parsed.memes) ? parsed.memes : [],
    importedAt: now(),
  });
  if (dataSource !== 'file') {
    applyLocalData(parsed);
    dataSource = 'imported';
  }
}

/** 导入副本的导入时间（没有则 null） */
export function getImportedAt() {
  const doc = read(KEYS.profilesImport, null);
  return doc && doc.importedAt ? doc.importedAt : null;
}

/** 删除本设备上导入的档案副本 */
export function clearImportedProfiles() {
  rawRemove(KEYS.profilesImport);
  if (dataSource === 'imported') {
    applyLocalData({});
    dataSource = 'none';
  }
}

/** 我的档案：{name, background} | null */
export function getMe() {
  return fileMe;
}

/** 档案文件里的类别在前，内置类别补在后面；同名时文件覆盖内置 */
export function listCategories() {
  const fileNames = new Set(fileCategories.map((c) => c.name));
  const builtin = BUILTIN_CATEGORIES
    .filter((c) => !fileNames.has(c.name))
    .map((c) => ({
      id: 'ct_' + c.name,
      name: c.name,
      description: c.description,
      reveal: c.reveal,
      builtin: true,
    }));
  return [...fileCategories, ...builtin];
}

export function getCategory(id) {
  return listCategories().find((c) => c.id === id) || null;
}

function getCategoryByName(name) {
  const n = cleanStr(name).trim();
  if (!n) return null;
  return listCategories().find((c) => c.name === n) || null;
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

/* ---------- 统一取"人物"（素材路由将同样按 {type,id} 引用） ---------- */

/**
 * ref: {type:'profile'|'category', id} | null
 * -> null | {kind:'profile', profile, category} | {kind:'category', category}
 * profile 的 category 是其 category 字段解析出的类别对象（没填或没匹配时为 null）。
 * 引用悬空（已被删；含旧版 'preset' 引用）时返回 null，调用方据此清掉选择。
 */
export function resolvePersona(ref) {
  if (!ref || !ref.id) return null;
  if (ref.type === 'profile') {
    const profile = getProfile(ref.id);
    if (!profile) return null;
    return { kind: 'profile', profile, category: getCategoryByName(profile.category) };
  }
  if (ref.type === 'category') {
    const category = getCategory(ref.id);
    return category ? { kind: 'category', category } : null;
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
      replyLang: doc.replyLang === 'en' ? 'en' : 'zh',
    };
  }
  return {
    apiKey: doc.apiKey || '',
    provider: doc.provider || DEFAULT_SETTINGS.provider,
    baseUrl: doc.baseUrl !== undefined ? doc.baseUrl : DEFAULT_SETTINGS.baseUrl,
    model: doc.model !== undefined ? doc.model : DEFAULT_SETTINGS.model,
    // 生成的微信消息用什么语言写（块外的分析永远是中文）：'zh' | 'en'
    replyLang: doc.replyLang === 'en' ? 'en' : 'zh',
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
    selected: null,            // {type:'profile'|'category', id} | null
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

/** 导出全部数据（明确不含 apiKey；档案/类别在 data/profiles.js 文件里，不经这里） */
export function exportData() {
  const { provider, baseUrl, model } = getSettings();
  return {
    app: 'muchat',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: now(),
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
  const incomingMemes = Array.isArray(parsed.memes) ? parsed.memes.length : 0;
  return {
    ok: true,
    // 旧版备份里的 profiles/presets 不再导入（档案和类别在 data/profiles.js 文件里）
    hasLegacyProfiles: Array.isArray(parsed.profiles) && parsed.profiles.length > 0,
    hasLegacyPresets: Array.isArray(parsed.presets) && parsed.presets.length > 0,
    current: { memes: readMemes().items.length },
    incoming: { memes: incomingMemes },
  };
}

/** 整体覆盖导入（调用前必须先经 buildImportPreview 校验并由用户确认） */
export function importData(parsed) {
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

/**
 * 清空全部数据（含 key、草稿、锁屏）。
 * 不动 data/profiles.js 文件，也不动导入的档案副本——档案有自己的「清除」入口，
 * 这样"清空全部数据不会弄丢档案"在电脑和手机上是同一个承诺。
 */
export function clearAll() {
  for (const key of Object.values(KEYS)) {
    if (key === KEYS.profilesImport) continue;
    rawRemove(key);
  }
}
