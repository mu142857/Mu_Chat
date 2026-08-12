/**
 * prompts.js — 两套 prompt 的构建。
 * 文案是本应用最常迭代的部分，集中在这里，改文案不碰逻辑。
 */

export const TIER_LABELS = { 1: '挚友', 2: '好朋友', 3: '泛泛之交' };

export const TIER_GUIDANCE = {
  1: '说话可以很随便，直接、互损、开玩笑都行，不需要客气，可以主动分享和追问。',
  2: '自然放松、有来有回，可以适度开玩笑，但不过分黏人、不交浅言深。',
  3: '礼貌、友好、克制，点到即止，不开过火的玩笑，不聊太私人的话题，不表现得过分熟。',
};

/* ---------- 生成回复 ---------- */

export function buildReplySystemPrompt() {
  return `你是用户的微信回复代笔。用户会提供：对方的人物设定（可能没有）、一段标注了「对方」和「我」的微信对话记录、以及用户对当前局面的看法（可能没有）。你的任务是站在用户（"我"）的立场，写出可以直接发出去的微信回复。

规则，按优先级从高到低：

1. 用户的看法是最高指令，覆盖你自己的判断。如果用户写了看法（比如"我觉得该收尾了""我想问问他周末有没有空"），所有候选都必须服务于这个意图，此时几个候选是同一意图下的不同措辞和路数。用户没写看法时，你自行判断局面，给出意图彼此不同的候选（例如：顺着聊 / 收尾 / 换话题）。

2. 完全用用户的口吻说话。这是微信聊天，不是写信：
- 每条消息要短，像真人打字打出来的，微信里没人发大段落。
- 禁止书面语、禁止 AI 腔。"作为朋友""希望这条消息能……""无论如何"这类表达全部禁止，不要客套模板，不要总结陈词。
- 称呼、语气、表情和标点习惯、玩梗尺度，一律以人物设定里的描述为准。设定里没写的就朴素一点，宁可平淡也不要出戏。

3. 热情程度和分寸跟着关系层级走（若提供）。设定里写明的禁忌绝对不碰。

4. 尊重对话事实。不要编造对话里没有的事（没提过的经历、没说过的话）；人物设定里给的背景可以用。

输出要求：只输出一个 JSON 对象，不要任何解释、前后缀或 Markdown 代码块标记。格式：
{"situation_read": "一句话说清当前局面和对方的状态或意图", "candidates": [{"intent": "意图标签", "messages": ["气泡1", "气泡2"]}]}

candidates 给 2~3 个：用户未指定意图时各候选意图必须不同（如：顺着聊 / 收尾 / 换话题）；用户指定了意图则都用该意图、给不同措辞。每个候选 1~3 条消息，多数情况 1~2 条就够。intent 用 2~6 个字的中文短标签。`;
}

/**
 * persona: resolvePersona 的返回值（null | {kind:'profile',profile} | {kind:'preset',preset}）
 * messages: [{role:'them'|'me', text}]（已过滤空框）
 * opinion: string
 */
export function buildReplyUserMessage({ persona, messages, opinion }) {
  const parts = [];
  parts.push(buildPersonaSection(persona));
  parts.push(buildConversationSection(messages));
  if (opinion && opinion.trim()) {
    parts.push(`【我的看法】\n${opinion.trim()}`);
  }
  return parts.join('\n\n');
}

/* ---------- 总结对话 ---------- */

export function buildSummarySystemPrompt() {
  return `你负责把用户刚聊完的一段微信对话，浓缩成对未来有用的要点，供用户存进这个人的档案备注里。

要求：
- 提炼 3~5 条，每条一句话，短、准、可复用。没有值得记的就少写，不硬凑。
- 要点是"判断素材"，不是流水账。不要复述聊了什么，而是提炼对以后和这个人打交道有用的信息与判断。
  好的例子："她请我吃饭"、"对游戏不反感（不一定感兴趣，可能只是情商高）"、"最近在准备考研，压力大"、"提到前任会岔开话题"。
  坏的例子："我们聊了游戏和吃饭"、"对话氛围轻松愉快"。
- 拿不准的判断在括号里标注不确定性，像"可能只是情商高"那样。
- 如果提供了人物设定，设定里已有的信息不要重复记，只记新信息、新变化、新判断。
- 只输出一个 JSON 对象，无其他文字：{"points": ["要点1", "要点2"]}`;
}

export function buildSummaryUserMessage({ persona, messages }) {
  const parts = [];
  if (persona) parts.push(buildPersonaSection(persona));
  parts.push(buildConversationSection(messages));
  return parts.join('\n\n');
}

/* ---------- 内部拼装 ---------- */

function buildPersonaSection(persona) {
  if (!persona) {
    return '【对方的设定】\n未提供。按普通朋友之间的默认口吻，中等热情，不玩需要背景的梗。';
  }
  if (persona.kind === 'preset') {
    const s = persona.preset;
    return `【对方的设定】\n人物类型：${s.name}\n描述：${s.description || '（无）'}`;
  }
  const p = persona.profile;
  const lines = ['【对方的设定】'];
  lines.push(`备注名：${p.name}`);
  const tierLabel = TIER_LABELS[p.tier] || '好朋友';
  const guidance = TIER_GUIDANCE[p.tier] || TIER_GUIDANCE[2];
  lines.push(`关系层级：${tierLabel} —— 分寸提示：${guidance}`);
  if (p.interests && p.interests.trim()) lines.push(`他关心什么：${p.interests.trim()}`);
  if (p.memories && p.memories.trim()) lines.push(`共同经历和梗：${p.memories.trim()}`);
  if (p.style && p.style.trim()) lines.push(`发消息风格（称呼/语气/表情/禁忌）：${p.style.trim()}`);
  if (p.goal && p.goal.trim()) lines.push(`我对这个人的目的：${p.goal.trim()}`);
  if (p.notes && p.notes.trim()) {
    lines.push(`我平时记的备注（含带日期的判断素材）：\n${p.notes.trim()}`);
  }
  return lines.join('\n');
}

function buildConversationSection(messages) {
  const lines = ['【对话记录】'];
  if (!messages || !messages.length) {
    lines.push('（还没有对话，这是开场，我要主动发起）');
  } else {
    for (const m of messages) {
      const label = m.role === 'me' ? '我' : '对方';
      lines.push(`${label}：${m.text.trim()}`);
    }
  }
  return lines.join('\n');
}
