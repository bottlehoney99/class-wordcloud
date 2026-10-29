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

// 구름 캐릭터 "몽글이" (고정된 SVG, 사용자 입력 없음)
function mascot(width = 104, fill = '#ffffff', face = true) {
  const h = Math.round(width * 78 / 104);
  const faceSvg = face
    ? '<circle cx="42" cy="44" r="3.6" fill="#1e3a5f"/><circle cx="64" cy="44" r="3.6" fill="#1e3a5f"/>' +
      '<ellipse cx="35" cy="53" rx="5" ry="3" fill="#ffb59e"/><ellipse cx="71" cy="53" rx="5" ry="3" fill="#ffb59e"/>' +
      '<path d="M48 52q5 4 10 0" fill="none" stroke="#1e3a5f" stroke-width="3" stroke-linecap="round"/>'
    : '<circle cx="42" cy="44" r="5" fill="#1e3a5f"/><circle cx="64" cy="44" r="5" fill="#1e3a5f"/>';
  const src = `<svg xmlns="http://www.w3.org/2000/svg" class="mascot" width="${width}" height="${h}" viewBox="0 0 104 78" aria-hidden="true">` +
    `<path d="M24 70c-12 0-20-8-20-18 0-9 7-16 16-17 1-15 13-27 28-27 11 0 21 6 25 16 2-1 5-1 7-1 12 0 21 9 21 21 0 1 0 3-1 4 3 3 4 7 4 11 0 6-5 11-12 11z" fill="${fill}" stroke="#1e3a5f" stroke-width="${face ? 3.2 : 5}"/>` +
    faceSvg + '</svg>';
  return document.importNode(new DOMParser().parseFromString(src, 'image/svg+xml').documentElement, true);
}

const SEND_ICON = () => document.importNode(new DOMParser().parseFromString(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M12 5l7 7-7 7" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  'image/svg+xml').documentElement, true);

function maxLabel(n) {
  return n === 0 ? '제한 없음' : `${n}개`;
}

function studentUrl(code) {
  const base = location.href.replace(/[#?].*$/, '').replace(/[^/]*$/, '');
  return `${base}?c=${code}`;
}
