/**
 * markdown.js — 模型输出的解析与轻量渲染。
 * 把原始文本拆成「分析文字（markdown 子集）」和「msg 气泡块」两种片段；
 * 渲染全部用 DOM API + textContent，不用 innerHTML，天然防注入。
 * 解析对流式输出友好：未闭合的 msg 块会作为 open 片段返回。
 */

/**
 * 拆分片段。
 * 返回 [{type:'md', text} | {type:'msg', text, open?:true}]
 * open=true 表示流式输出中该气泡的围栏还没闭合。
 */
export function parseSegments(raw) {
  const segments = [];
  const lines = String(raw).split('\n');
  let mdBuf = [];
  let msgBuf = null; // null = 不在 msg 块内

  const flushMd = () => {
    const text = mdBuf.join('\n');
    if (text.trim()) segments.push({ type: 'md', text });
    mdBuf = [];
  };

  for (const line of lines) {
    const t = line.trim();
    if (msgBuf === null && /^```(msg|send|message)\s*$/i.test(t)) {
      flushMd();
      msgBuf = [];
    } else if (msgBuf !== null && /^```\s*$/.test(t)) {
      const text = msgBuf.join('\n').trim();
      if (text) segments.push({ type: 'msg', text });
      msgBuf = null;
    } else if (msgBuf !== null) {
      msgBuf.push(line);
    } else {
      mdBuf.push(line);
    }
  }
  if (msgBuf !== null) {
    segments.push({ type: 'msg', text: msgBuf.join('\n').trim(), open: true });
  } else {
    flushMd();
  }
  return segments;
}

/**
 * 渲染 markdown 子集（prompt 里约定的范围）：
 * 标题(#~####)、加粗、行内代码、无序/有序列表、分隔线、引用行、段落（保留换行）。
 */
export function renderMarkdown(text) {
  const root = document.createElement('div');
  root.className = 'md';

  let para = [];
  let list = null; // {tag:'ul'|'ol', el}

  const flushPara = () => {
    if (!para.length) return;
    const p = document.createElement('p');
    appendInline(p, para.join('\n'));
    root.appendChild(p);
    para = [];
  };
  const closeList = () => { list = null; };

  for (const line of String(text).split('\n')) {
    const t = line.trim();
    let m;
    if (!t) {
      flushPara();
      closeList();
    } else if ((m = t.match(/^(#{1,4})\s+(.+)/))) {
      flushPara(); closeList();
      const h = document.createElement('div');
      h.className = 'md-h md-h' + Math.min(m[1].length, 3);
      appendInline(h, m[2]);
      root.appendChild(h);
    } else if (/^([-*_])\1{2,}$/.test(t.replace(/\s/g, ''))) {
      flushPara(); closeList();
      root.appendChild(document.createElement('hr'));
    } else if ((m = t.match(/^[-•*]\s+(.+)/))) {
      flushPara();
      if (!list || list.tag !== 'ul') {
        list = { tag: 'ul', el: document.createElement('ul') };
        root.appendChild(list.el);
      }
      const li = document.createElement('li');
      appendInline(li, m[1]);
      list.el.appendChild(li);
    } else if ((m = t.match(/^\d+[.、)]\s*(.+)/))) {
      flushPara();
      if (!list || list.tag !== 'ol') {
        list = { tag: 'ol', el: document.createElement('ol') };
        root.appendChild(list.el);
      }
      const li = document.createElement('li');
      appendInline(li, m[1]);
      list.el.appendChild(li);
    } else if (t.startsWith('>')) {
      flushPara(); closeList();
      const q = document.createElement('p');
      q.className = 'md-quote';
      appendInline(q, t.replace(/^>\s?/, ''));
      root.appendChild(q);
    } else {
      closeList();
      para.push(t);
    }
  }
  flushPara();
  return root;
}

/** 行内解析：换行 → <br>，**加粗**、`行内代码`，其余原样文本 */
function appendInline(parent, text) {
  String(text).split('\n').forEach((ln, idx) => {
    if (idx) parent.appendChild(document.createElement('br'));
    appendInlineLine(parent, ln);
  });
}

function appendInlineLine(parent, text) {
  const re = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) {
      parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    }
    const tok = m[0];
    if (tok.startsWith('**')) {
      const b = document.createElement('strong');
      b.textContent = tok.slice(2, -2);
      parent.appendChild(b);
    } else {
      const c = document.createElement('code');
      c.textContent = tok.slice(1, -1);
      parent.appendChild(c);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) {
    parent.appendChild(document.createTextNode(text.slice(last)));
  }
}
