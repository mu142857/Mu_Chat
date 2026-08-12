/**
 * lock.js — 打开页面时的锁屏。
 * 定位是「门帘」：挡住顺手翻看，不是加密（数据本身仍是明文，懂技术的可绕过）。
 * 同一个标签页会话内解锁一次即可（sessionStorage 标记），刷新不用重输。
 */

import { isLockEnabled, verifyLockPassword } from './storage.js';
import { el } from './ui.js';

const UNLOCK_FLAG = 'muchat.unlocked';

/** 在初始化视图前 await：没设密码或本会话已解锁则直接返回 */
export async function requireUnlock() {
  if (!isLockEnabled()) return;
  try {
    if (sessionStorage.getItem(UNLOCK_FLAG) === '1') return;
  } catch {
    return; // sessionStorage 不可用（极端隐私模式）就不拦了，锁屏只是门帘
  }
  await showLockScreen();
}

function showLockScreen() {
  return new Promise((resolve) => {
    const overlay = el('div', 'lock-screen');
    const form = document.createElement('form');
    form.className = 'lock-card';

    form.appendChild(el('div', 'lock-title', '🔒 回复助手'));
    form.appendChild(el('div', 'lock-sub', '输入锁屏密码'));

    // 隐藏的用户名字段：让浏览器愿意记住这个密码
    const user = el('input');
    user.type = 'text';
    user.name = 'username';
    user.autocomplete = 'username';
    user.value = 'muchat';
    user.hidden = true;
    user.tabIndex = -1;
    form.appendChild(user);

    const input = el('input');
    input.type = 'password';
    input.name = 'password';
    input.autocomplete = 'current-password';
    input.placeholder = '密码';
    form.appendChild(input);

    const err = el('div', 'lock-err', '');
    form.appendChild(err);

    const btn = el('button', 'btn-primary', '进入');
    btn.type = 'submit';
    form.appendChild(btn);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const ok = await verifyLockPassword(input.value);
      if (!ok) {
        err.textContent = '密码不对';
        input.select();
        return;
      }
      try { sessionStorage.setItem(UNLOCK_FLAG, '1'); } catch { /* 无妨 */ }
      overlay.remove();
      resolve();
    });

    overlay.appendChild(form);
    document.body.appendChild(overlay);
    setTimeout(() => input.focus(), 50);
  });
}
