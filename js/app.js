/**
 * app.js — 入口：初始化数据、两个视图与 tab 切换。
 */

import { ensureDefaultPresets, isPersistent } from './storage.js';
import { initChatView } from './chat.js';
import { initManageView } from './manage.js';
import { showToast } from './ui.js';

ensureDefaultPresets();
initChatView();
initManageView();

/* tab 切换 */
const views = {
  chat: document.getElementById('view-chat'),
  manage: document.getElementById('view-manage'),
};
const tabBtns = document.querySelectorAll('.tab-btn');
const composer = document.getElementById('composer');

tabBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.view;
    for (const [name, view] of Object.entries(views)) {
      view.hidden = name !== target;
    }
    composer.hidden = target !== 'chat';
    tabBtns.forEach((b) => b.classList.toggle('active', b === btn));
    window.scrollTo({ top: 0 });
  });
});

if (!isPersistent()) {
  showToast('当前浏览器禁用了本地存储，数据不会被保存', { duration: 4000 });
}
