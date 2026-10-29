// 공통 설정과 도우미
const WC_CONFIG = {
  url: 'https://bxydptizntolzhaonbgj.supabase.co',
  key: 'sb_publishable_hQkfigCuI2xF9rh6vqToBg_QY1QEpK7',
};

const sb = window.supabase.createClient(WC_CONFIG.url, WC_CONFIG.key, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { params: { eventsPerSecond: 20 } },
});

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function normWord(w) {
  return String(w || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function toast(msg, kind = '') {
  let box = $('#toast');
  if (!box) {
    box = el('div', { id: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(box);
  }
  box.textContent = msg;
  box.className = 'show ' + kind;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (box.className = ''), 2600);
}

function storeGet(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch (e) {
    return fallback;
  }
}
function storeSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 저장 불가 환경 */ }
}

function maxLabel(n) {
  return n === 0 ? '제한 없음' : `${n}개`;
}

function studentUrl(code) {
  const base = location.href.replace(/[#?].*$/, '').replace(/[^/]*$/, '');
  return `${base}?c=${code}`;
}
