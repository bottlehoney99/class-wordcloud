(() => {
  const app = $('#app');
  const DISPLAY = "'Do Hyeon', 'Malgun Gothic', sans-serif";
  const BODY = "'Gowun Dodum', 'Malgun Gothic', sans-serif";
  const INK = ['#d2452b', '#1e7a52', '#1e3a5f', '#b8336a', '#2f64b5', '#9a5b00'];
  const MAX_OPTIONS = [1, 2, 3, 5, 10, 0];
  const MAX_WORDS = 120;

  // ---------- 저장된 수업 목록 ----------
  const listKey = 'wc_teacher_sessions';
  const saved = () => storeGet(listKey, []);
  function remember(s) {
    const arr = saved().filter((x) => x.id !== s.id);
    arr.unshift({ id: s.id, key: s.key, code: s.code, title: s.title || '', at: Date.now() });
    storeSet(listKey, arr.slice(0, 30));
  }
  function forget(id) { storeSet(listKey, saved().filter((x) => x.id !== id)); }

  // ---------- 상태 ----------
  let S = null;
  let KEY = null;
  let questions = [];
  let rows = [];
  let channel = null;
  let pollTimer = null;
  let editingId = null;
  let ui = {};
  let pills = new Map();   // norm → 요소
  let fitTimer = null;

  const cur = () => questions.find((q) => q.id === S.current_question_id) || null;

  async function rpc(name, args) {
    const { data, error } = await sb.rpc(name, args);
    if (error) {
      toast(/forbidden/.test(error.message) ? '이 수업을 관리할 권한이 없어요.' : '처리하지 못했어요. 다시 시도해 주세요.', 'error');
      throw error;
    }
    return data;
  }

  // ---------- 시작 화면 ----------
  function showStart() {
    history.replaceState(null, '', location.pathname);
    teardown();
    const title = el('input', { id: 'newtitle', placeholder: '수업 이름 (예: 3학년 2반 국어)', maxlength: '80' });
    const btn = el('button', { class: 'btn coral', type: 'submit' }, '수업 만들기');
    const form = el('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        btn.disabled = true;
        try {
          const r = await rpc('wc_create_session', { p_title: title.value.trim() });
          const s = { id: r.session_id, key: r.teacher_key, code: r.code, title: title.value.trim() };
          remember(s);
          openSession(s.id, s.key);
        } catch (err) { btn.disabled = false; }
      },
    }, el('label', { for: 'newtitle', class: 'sr-only' }, '수업 이름'), title, btn);

    const list = saved();
    app.replaceChildren(el('main', { class: 'start' },
      el('div', { class: 'hello' }, mascot(104),
        el('div', { class: 'msg bot q' },
          el('h1', {}, '오늘은 어떤 구름을 띄울까요?'),
          el('p', {}, '수업을 만들면 참여 코드와 QR이 생겨요. 학생은 휴대폰으로 들어와 키워드를 보내면 돼요.'))),
      form,
      list.length ? el('section', { class: 'past' },
        el('h2', {}, '이 컴퓨터에서 만든 수업'),
        el('ul', {}, list.map((s) => el('li', {},
          el('a', { href: `#s=${s.id}&k=${s.key}` }, s.title || '(이름 없음)'),
          el('span', {}, s.code),
          el('button', { class: 'btn flat small', onclick: () => { forget(s.id); showStart(); } }, '목록에서 빼기'),
        )))) : null,
      el('p', { class: 'to-student' }, el('a', { href: './' }, '학생 참여 화면으로 가기')),
    ));
    setTimeout(() => title.focus(), 30);
  }

  function teardown() {
    if (channel) { sb.removeChannel(channel); channel = null; }
    clearInterval(pollTimer);
    S = null; KEY = null; questions = []; rows = []; pills = new Map();
  }

  // ---------- 수업 열기 ----------
  async function openSession(id, key) {
    teardown();
    history.replaceState(null, '', `${location.pathname}#s=${id}&k=${key}`);
    const { data, error } = await sb.from('wc_sessions')
      .select('id, code, title, current_question_id, accepting').eq('id', id).maybeSingle();
    if (error || !data) {
      toast(error ? '연결에 실패했어요.' : '수업을 찾지 못했어요.', 'error');
      if (!error) forget(id);
      return showStart();
    }
    S = data; KEY = key;
    remember({ ...S, key });
    buildLayout();
    await loadQuestions();
    await loadResponses();
    subscribe();
  }

  async function loadQuestions() {
    const { data } = await sb.from('wc_questions')
      .select('id, prompt, max_per_student, position').eq('session_id', S.id).order('position');
    questions = data || [];
    renderQuestions();
    renderPrompt();
  }

  async function loadResponses() {
    const q = cur();
    if (!q) { rows = []; return refresh(); }
    const qid = q.id;
    const { data } = await sb.from('wc_responses')
      .select('id, norm, word, hidden, participant, question_id').eq('question_id', qid).order('id').limit(5000);
    if (!cur() || cur().id !== qid) return;
    rows = data || [];
    refresh();
  }

  function subscribe() {
    channel = sb.channel('tch-' + S.id)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'wc_responses', filter: 'session_id=eq.' + S.id }, (p) => {
        const r = p.new;
        if (!cur() || r.question_id !== cur().id) return;
        if (!rows.some((x) => x.id === r.id)) rows.push(r);
        refresh();
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'wc_responses', filter: 'session_id=eq.' + S.id }, (p) => {
        const r = p.new;
        const i = rows.findIndex((x) => x.id === r.id);
        if (i >= 0) { rows[i] = { ...rows[i], ...r }; refresh(); }
      })
      .subscribe((status) => {
        if (ui.live) ui.live.textContent = status === 'SUBSCRIBED' ? '실시간 연결됨' : '연결 중…';
      });
    pollTimer = setInterval(loadResponses, 8000);
  }

  // ---------- 화면 구성 ----------
  function buildLayout() {
    const titleInput = el('input', { class: 'title-input', value: S.title || '', placeholder: '수업 이름', maxlength: '80', 'aria-label': '수업 이름' });
    titleInput.addEventListener('change', async () => {
      await rpc('wc_set_title', { p_session: S.id, p_key: KEY, p_title: titleInput.value.trim() });
      S.title = titleInput.value.trim();
      remember({ ...S, key: KEY });
    });

    const promptBox = el('textarea', { id: 'qprompt', placeholder: '새 질문 (예: 봄 하면 떠오르는 단어는?)', maxlength: '200' });
    promptBox.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); qform.requestSubmit(); }
    });
    const maxSel = el('select', { id: 'qmax' }, MAX_OPTIONS.map((n) => el('option', { value: String(n) }, maxLabel(n))));
    const addBtn = el('button', { class: 'btn primary small', type: 'submit' }, '질문 추가');
    const cancelBtn = el('button', { class: 'btn flat small', type: 'button', style: 'display:none', onclick: () => endEdit() }, '취소');
    const qform = el('form', { class: 'qform', onsubmit: onQuestionSubmit },
      el('label', { for: 'qprompt', class: 'sr-only' }, '질문 내용'),
      promptBox,
      el('div', { class: 'line' }, el('label', { for: 'qmax' }, '1명당'), maxSel, cancelBtn, addBtn));

    const qlist = el('ul', { class: 'qlist' });
    const side = el('aside', { class: 'side' },
      el('header', {}, titleInput, el('small', {}, '질문을 누르면 학생 화면에 바로 떠요.')),
      qlist, qform,
      el('div', { class: 'sessions' },
        el('button', { onclick: copyManageLink }, '관리 링크 복사'),
        el('button', { onclick: () => showStart() }, '다른 수업')));

    const qrCanvas = el('canvas', { width: '62', height: '62', 'aria-hidden': 'true' });
    const live = el('span', { class: 'live' }, '연결 중…');
    const peopleNum = el('b', {}, '0');
    const peopleSub = el('small', {}, '명이 구름을 띄우는 중');
    const accBtn = el('button', { class: 'btn toggle', onclick: toggleAccepting }, el('span', { class: 'dot' }), el('span', { class: 't' }));
    const host = studentUrl(S.code).replace(/^https?:\/\//, '').replace(/\?c=.*/, '');
    const topbar = el('div', { class: 'topbar' },
      el('button', { class: 'join', title: '크게 보기', onclick: openQr, 'aria-label': `참여 코드 ${S.code}, 크게 보기` },
        qrCanvas,
        el('div', { class: 'where' }, el('b', {}, '참여 코드'), host),
        el('div', { class: 'code' }, S.code)),
      el('div', { class: 'spacer' }),
      el('div', { class: 'people' },
        el('div', { class: 'dots', 'aria-hidden': 'true' },
          ['#ffb59e', '#ffe08a', '#a6e3c4', '#f7b5cf'].map((c) => el('span', { style: `background:${c}` }))),
        peopleNum, peopleSub),
      accBtn);

    const promptH = el('h2');
    const limit = el('div', { class: 'limit' });
    const cloud = el('div', { class: 'cloud', 'aria-live': 'polite' });
    const empty = el('div', { class: 'empty' });
    const wrap = el('div', { class: 'cloud-wrap' }, cloud, empty);

    const prevBtn = el('button', { class: 'btn', onclick: () => step(-1) }, '← 이전');
    const nextBtn = el('button', { class: 'btn primary', onclick: () => step(1) }, '다음 질문 →');
    const bottombar = el('div', { class: 'bottombar' },
      prevBtn, nextBtn,
      el('div', { class: 'spacer' }),
      live,
      el('button', { class: 'btn', onclick: openDrawer }, '단어 관리'),
      el('button', { class: 'btn', onclick: savePng }, '사진 저장'),
      el('button', { class: 'btn hide-fs', onclick: toggleSide }, '목록 접기'),
      el('button', { class: 'btn', onclick: toggleFullscreen }, '크게 보기'));

    const puffs = [
      'left:-60px;bottom:-70px;width:360px;height:180px',
      'right:-80px;top:130px;width:300px;height:140px',
      'right:26%;bottom:-50px;width:220px;height:110px',
      'left:34%;top:-60px;width:260px;height:120px;opacity:.4',
    ].map((s) => el('div', { class: 'puff', style: s, 'aria-hidden': 'true' }));

    const stage = el('section', { class: 'stage' }, ...puffs, topbar,
      el('div', { class: 'prompt-area' }, mascot(104), el('div', { class: 'bubble' }, promptH), limit),
      wrap, bottombar);
    const root = el('div', { class: 'teacher' }, side, stage);

    const words = el('div', { class: 'words' });
    const drawer = el('aside', { class: 'drawer', 'aria-label': '단어 관리' },
      el('header', {}, el('h3', {}, '단어 관리'), el('button', { class: 'btn flat small', onclick: closeDrawer }, '닫기')),
      words,
      el('footer', {}, el('button', { class: 'btn small', onclick: clearAll }, '이 질문의 응답 모두 지우기')));

    const bigQr = el('canvas', { width: '400', height: '400' });
    const qrOverlay = el('div', { class: 'qr-overlay', onclick: (e) => { if (e.target === qrOverlay) closeQr(); } },
      el('button', { class: 'btn close', onclick: closeQr }, '닫기'),
      bigQr,
      el('div', {}, el('div', { class: 'u' }, studentUrl(S.code).replace(/\?c=.*/, '')), el('div', { class: 'big' }, S.code),
        el('div', { class: 'u', style: 'margin-top:18px' }, 'QR을 찍거나 주소에 들어가 코드를 입력하세요')));

    app.replaceChildren(root, drawer, qrOverlay);
    ui = { root, stage, qlist, promptBox, maxSel, addBtn, cancelBtn, peopleNum, peopleSub, accBtn, promptH, limit, cloud, empty, wrap, prevBtn, nextBtn, words, drawer, live, qrOverlay };

    drawQr(qrCanvas, studentUrl(S.code), 62);
    drawQr(bigQr, studentUrl(S.code), 400);
    renderAccepting();
    new ResizeObserver(() => scheduleFit()).observe(wrap);
  }

  function drawQr(canvas, text, size) {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const quiet = 2;
    const cell = Math.max(1, Math.floor(size / (n + quiet * 2)));
    const px = cell * (n + quiet * 2);
    canvas.width = px; canvas.height = px;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = '#1e3a5f';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
    }
  }

  // ---------- 질문 목록 ----------
  function renderQuestions() {
    ui.qlist.replaceChildren(...questions.map((q, i) => {
      const li = el('li', { class: 'qitem' + (q.id === S.current_question_id ? ' current' : '') + (q.id === editingId ? ' editing' : '') },
        el('span', { class: 'num' }, String(i + 1)),
        el('div', {},
          el('div', { class: 'p' }, q.prompt),
          el('div', { class: 'meta' },
            el('span', {}, '1명당 ' + maxLabel(q.max_per_student)),
            el('span', { class: 'tools' },
              el('button', { title: '위로', 'aria-label': '위로', onclick: (e) => { e.stopPropagation(); move(q, -1); } }, '↑'),
              el('button', { title: '아래로', 'aria-label': '아래로', onclick: (e) => { e.stopPropagation(); move(q, 1); } }, '↓'),
              el('button', { onclick: (e) => { e.stopPropagation(); startEdit(q); } }, '수정'),
              el('button', { onclick: (e) => { e.stopPropagation(); removeQuestion(q); } }, '삭제')))));
      li.addEventListener('click', () => setCurrent(q.id));
      return li;
    }));
    if (!questions.length) {
      ui.qlist.append(el('li', { style: 'padding:14px 8px;color:var(--navy-2);font-size:14px' }, '아래에 첫 질문을 입력하세요. 수업 전에 여러 개를 만들어 둘 수 있어요.'));
    }
    const i = questions.findIndex((q) => q.id === S.current_question_id);
    ui.prevBtn.disabled = i <= 0;
    ui.nextBtn.disabled = i < 0 || i >= questions.length - 1;
  }

  async function onQuestionSubmit(e) {
    e.preventDefault();
    const prompt = ui.promptBox.value.trim();
    if (!prompt) return ui.promptBox.focus();
    const max = Number(ui.maxSel.value);
    ui.addBtn.disabled = true;
    try {
      if (editingId) {
        await rpc('wc_update_question', { p_key: KEY, p_qid: editingId, p_prompt: prompt, p_max: max });
        endEdit();
      } else {
        await rpc('wc_add_question', { p_session: S.id, p_key: KEY, p_prompt: prompt, p_max: max });
        ui.promptBox.value = '';
        if (!S.current_question_id) {
          const { data } = await sb.from('wc_sessions').select('current_question_id').eq('id', S.id).single();
          S.current_question_id = data.current_question_id;
        }
      }
      await loadQuestions();
      await loadResponses();
    } catch (err) { /* toast 처리됨 */ }
    ui.addBtn.disabled = false;
    ui.promptBox.focus();
  }

  function startEdit(q) {
    editingId = q.id;
    ui.promptBox.value = q.prompt;
    ui.maxSel.value = String(q.max_per_student);
    ui.addBtn.textContent = '수정 저장';
    ui.cancelBtn.style.display = '';
    ui.promptBox.focus();
    renderQuestions();
  }
  function endEdit() {
    editingId = null;
    ui.promptBox.value = '';
    ui.addBtn.textContent = '질문 추가';
    ui.cancelBtn.style.display = 'none';
    renderQuestions();
  }

  async function removeQuestion(q) {
    if (!confirm(`"${q.prompt}" 질문과 응답을 삭제할까요?`)) return;
    await rpc('wc_delete_question', { p_key: KEY, p_qid: q.id });
    if (S.current_question_id === q.id) S.current_question_id = null;
    if (editingId === q.id) endEdit();
    await loadQuestions();
    await loadResponses();
  }

  async function move(q, dir) {
    await rpc('wc_move_question', { p_key: KEY, p_qid: q.id, p_dir: dir });
    await loadQuestions();
  }

  async function setCurrent(qid) {
    if (qid === S.current_question_id) return;
    await rpc('wc_set_current', { p_session: S.id, p_key: KEY, p_qid: qid });
    S.current_question_id = qid;
    rows = [];
    pills.forEach((p) => p.remove());
    pills = new Map();
    renderQuestions(); renderPrompt(); refresh();
    loadResponses();
  }

  function step(d) {
    const i = questions.findIndex((q) => q.id === S.current_question_id);
    const q = questions[i + d];
    if (q) setCurrent(q.id);
  }

  async function toggleAccepting() {
    const on = !S.accepting;
    await rpc('wc_set_accepting', { p_session: S.id, p_key: KEY, p_on: on });
    S.accepting = on;
    renderAccepting();
    refresh();
  }
  function renderAccepting() {
    ui.accBtn.classList.toggle('on', S.accepting);
    $('.t', ui.accBtn).textContent = S.accepting ? '입력 받는 중' : '입력 멈춤';
  }

  function renderPrompt() {
    const q = cur();
    const i = questions.findIndex((x) => x.id === S.current_question_id);
    ui.promptH.textContent = q ? q.prompt : '질문을 추가하거나 왼쪽에서 골라 주세요';
    ui.limit.textContent = q ? `한 사람당 ${maxLabel(q.max_per_student)} · 질문 ${i + 1}/${questions.length}` : '';
  }

  // ---------- 집계와 말풍선 구름 ----------
  function groups() {
    const map = new Map();
    for (const r of rows) {
      let g = map.get(r.norm);
      if (!g) { g = { norm: r.norm, word: r.word, count: 0, hidden: 0 }; map.set(r.norm, g); }
      g.count++;
      if (r.hidden) g.hidden++;
    }
    return [...map.values()].map((g) => ({ ...g, isHidden: g.hidden === g.count }))
      .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word, 'ko'));
  }

  function inkFor(norm) {
    let h = 0;
    for (let i = 0; i < norm.length; i++) h = (h * 31 + norm.charCodeAt(i)) >>> 0;
    return INK[h % INK.length];
  }

  function refresh() {
    const gs = groups();
    const visible = gs.filter((g) => !g.isHidden).slice(0, MAX_WORDS);
    const people = new Set(rows.map((r) => r.participant)).size;
    ui.peopleNum.textContent = String(people);
    ui.peopleSub.textContent = `명 참여 · 응답 ${rows.length}개`;
    if (ui.drawer.classList.contains('open')) renderDrawer(gs);
    renderCloud(visible);
  }

  function renderCloud(visible) {
    const { cloud, empty } = ui;
    if (!cur()) {
      empty.replaceChildren();
    } else if (!visible.length) {
      empty.replaceChildren(el('div', {}, S.accepting ? '학생들의 단어를 기다리고 있어요' : '아직 들어온 단어가 없어요'));
    } else empty.replaceChildren();

    // 큰 단어가 가운데 오도록 번갈아 배치
    const ordered = [];
    visible.forEach((g, i) => (i % 2 ? ordered.push(g) : ordered.unshift(g)));

    const keep = new Set(visible.map((g) => g.norm));
    for (const [norm, node] of pills) if (!keep.has(norm)) { node.remove(); pills.delete(norm); }

    const max = visible.length ? visible[0].count : 1;
    const n = visible.length;
    ordered.forEach((g) => {
      let node = pills.get(g.norm);
      if (!node) {
        node = el('button', { class: 'pill new', type: 'button' }, el('span', { class: 't' }), el('span', { class: 'badge' }));
        node.addEventListener('click', (ev) => showPop(node.dataset.word, node.dataset.norm, ev));
        node.addEventListener('animationend', () => node.classList.remove('new'), { once: true });
        pills.set(g.norm, node);
      }
      const ink = inkFor(g.norm);
      // 1~1.0 사이 상대 크기
      const rel = max === 1 ? Math.max(0.35, Math.min(0.75, 1.6 / Math.sqrt(n))) : 0.22 + 0.78 * Math.sqrt((g.count - 1) / (max - 1));
      node.dataset.rel = String(rel);
      node.dataset.word = g.word;
      node.dataset.norm = g.norm;
      node.dataset.count = String(g.count);
      node.style.color = ink;
      $('.t', node).textContent = g.word;
      const badge = $('.badge', node);
      badge.textContent = String(g.count);
      badge.style.background = ink;
      badge.style.display = g.count >= 2 ? '' : 'none';
      node.setAttribute('aria-label', `${g.word} ${g.count}번`);
      cloud.append(node); // 순서대로 다시 붙임
    });
    fit();
  }

  function applySizes(base) {
    for (const node of pills.values()) {
      const size = Math.max(16, Math.round(base * Number(node.dataset.rel)));
      const pad = Math.round(size * 0.32);
      node.style.fontSize = size + 'px';
      node.style.padding = `${Math.round(pad * 0.55)}px ${pad + 6}px ${Math.round(pad * 0.42)}px`;
      node.style.margin = `${Math.round(6 + size * 0.08)}px ${Math.round(5 + size * 0.1)}px`;
      node.style.boxShadow = `0 ${Math.max(3, Math.round(size / 14))}px 0 #b9dbf5`;
    }
  }

  // 화면에 다 들어갈 때까지 글자 크기를 줄임
  function fit() {
    const { cloud } = ui;
    if (!pills.size) return;
    const H = cloud.clientHeight, W = cloud.clientWidth;
    let base = Math.min(H * 0.3, W * 0.13, 110);
    for (let k = 0; k < 18; k++) {
      applySizes(base);
      if (cloud.scrollHeight <= H + 1 && cloud.scrollWidth <= W + 1) break;
      base *= 0.9;
    }
  }
  function scheduleFit() { clearTimeout(fitTimer); fitTimer = setTimeout(fit, 120); }

  // ---------- 단어 숨기기·삭제 ----------
  let popEl = null;
  function closePop() { if (popEl) { popEl.remove(); popEl = null; } }
  function showPop(word, norm, ev) {
    closePop();
    popEl = el('div', { class: 'pop', role: 'dialog', 'aria-label': `${word} 관리` },
      el('span', { class: 'lbl' }, word),
      el('button', { onclick: () => { closePop(); hideWord(norm, true); } }, '숨기기'),
      el('button', { onclick: () => { closePop(); deleteWord(norm); } }, '삭제'),
      el('button', { onclick: closePop }, '취소'));
    document.body.append(popEl);
    const x = Math.min(Math.max(10, ev.clientX - popEl.offsetWidth / 2), window.innerWidth - popEl.offsetWidth - 10);
    const y = Math.max(10, ev.clientY - popEl.offsetHeight - 16);
    popEl.style.left = x + 'px'; popEl.style.top = y + 'px';
    setTimeout(() => document.addEventListener('pointerdown', outside), 0);
  }
  function outside(e) {
    if (!popEl) return document.removeEventListener('pointerdown', outside);
    if (!popEl.contains(e.target)) { closePop(); document.removeEventListener('pointerdown', outside); }
  }

  async function hideWord(norm, hidden) {
    const q = cur(); if (!q) return;
    await rpc('wc_hide_word', { p_key: KEY, p_qid: q.id, p_norm: norm, p_hidden: hidden });
    rows.forEach((r) => { if (r.norm === norm) r.hidden = hidden; });
    refresh();
    if (hidden) toast('숨겼어요. "단어 관리"에서 다시 보이게 할 수 있어요.');
  }
  async function deleteWord(norm) {
    const q = cur(); if (!q) return;
    await rpc('wc_delete_word', { p_key: KEY, p_qid: q.id, p_norm: norm });
    rows = rows.filter((r) => r.norm !== norm);
    refresh();
    toast('삭제했어요.');
  }
  async function clearAll() {
    const q = cur(); if (!q || !rows.length) return;
    if (!confirm('이 질문에 들어온 응답을 모두 지울까요? 되돌릴 수 없어요.')) return;
    await rpc('wc_clear_question', { p_key: KEY, p_qid: q.id });
    rows = [];
    refresh();
  }

  function openDrawer() { ui.drawer.classList.add('open'); renderDrawer(groups()); }
  function closeDrawer() { ui.drawer.classList.remove('open'); }
  function renderDrawer(gs) {
    if (!gs.length) {
      ui.words.replaceChildren(el('p', { style: 'padding:16px;color:var(--navy-2)' }, '아직 들어온 단어가 없어요.'));
      return;
    }
    ui.words.replaceChildren(...gs.map((g) => el('div', { class: 'wrow' + (g.isHidden ? ' hidden' : '') },
      el('span', { class: 'w' }, g.word),
      el('span', { class: 'n' }, String(g.count)),
      el('button', { class: 'btn small', onclick: () => hideWord(g.norm, !g.isHidden) }, g.isHidden ? '보이기' : '숨기기'),
      el('button', { class: 'btn flat small', onclick: () => deleteWord(g.norm) }, '삭제'))));
  }

  // ---------- QR·전체 화면·목록 접기 ----------
  function openQr() { ui.qrOverlay.classList.add('open'); }
  function closeQr() { ui.qrOverlay.classList.remove('open'); }
  function toggleSide() {
    const c = ui.root.classList.toggle('collapsed');
    $('.hide-fs', ui.stage).textContent = c ? '목록 펴기' : '목록 접기';
  }
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else (ui.stage.requestFullscreen ? ui.stage.requestFullscreen() : Promise.reject()).catch(() => toast('이 브라우저는 전체 화면을 지원하지 않아요.'));
  }

  async function copyManageLink() {
    const link = `${location.origin}${location.pathname}#s=${S.id}&k=${KEY}`;
    try {
      await navigator.clipboard.writeText(link);
      toast('관리 링크를 복사했어요. 학생에게는 보내지 마세요.');
    } catch (e) {
      window.prompt('아래 링크를 복사하세요. 학생에게는 보내지 마세요.', link);
    }
  }

  // ---------- 사진(PNG) 저장 ----------
  function rr(ctx, x, y, w, h, r) {
    r = Math.min(r, h / 2, w / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function wrapLines(ctx, text, maxW) {
    const lines = [];
    let line = '';
    for (const ch of text) {
      const t = line + ch;
      if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = ch; } else line = t;
    }
    if (line) lines.push(line);
    return lines;
  }
  async function savePng() {
    const q = cur();
    if (!q || !pills.size) return toast('저장할 단어가 아직 없어요.');
    if (document.fonts) await document.fonts.load(`40px ${DISPLAY}`).catch(() => {});
    const scale = 2;
    const box = ui.cloud.getBoundingClientRect();
    const pad = 48;
    const W = Math.round(box.width) + pad * 2;
    const tmp = document.createElement('canvas').getContext('2d');
    const fs = 40;
    tmp.font = `${fs}px ${DISPLAY}`;
    const lines = wrapLines(tmp, q.prompt, W - pad * 2 - 56);
    const headH = 40 + lines.length * fs * 1.25 + 28 + 30;
    const footH = 60;
    const H = Math.round(headH + box.height + footH);

    const out = document.createElement('canvas');
    out.width = W * scale; out.height = H * scale;
    const ctx = out.getContext('2d');
    ctx.scale(scale, scale);
    ctx.fillStyle = '#dcefff'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    rr(ctx, -60, H - 110, 360, 180, 90); ctx.fill();
    rr(ctx, W - 220, 140, 300, 140, 70); ctx.fill();

    // 질문 말풍선
    const bw = Math.max(...lines.map((l) => tmp.measureText(l).width)) + 56;
    const bh = lines.length * fs * 1.25 + 28;
    ctx.fillStyle = '#b9dbf5'; rr(ctx, pad, 40 + 6, bw, bh, 28); ctx.fill();
    ctx.fillStyle = '#ffffff'; rr(ctx, pad, 40, bw, bh, 28); ctx.fill();
    ctx.fillStyle = '#1e3a5f'; ctx.font = `${fs}px ${DISPLAY}`; ctx.textBaseline = 'top';
    lines.forEach((l, i) => ctx.fillText(l, pad + 28, 40 + 16 + i * fs * 1.25));

    // 단어 말풍선
    const oy = headH, ox = pad;
    for (const node of pills.values()) {
      const r = node.getBoundingClientRect();
      const x = ox + r.left - box.left, y = oy + r.top - box.top;
      const size = parseFloat(node.style.fontSize);
      const sh = Math.max(3, Math.round(size / 14));
      ctx.fillStyle = '#b9dbf5'; rr(ctx, x, y + sh, r.width, r.height, r.height / 2); ctx.fill();
      ctx.fillStyle = '#ffffff'; rr(ctx, x, y, r.width, r.height, r.height / 2); ctx.fill();
      ctx.fillStyle = node.style.color;
      ctx.font = `${size}px ${DISPLAY}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(node.dataset.word, x + r.width / 2, y + r.height / 2 + size * 0.04);
      const count = Number(node.dataset.count);
      if (count >= 2) {
        ctx.font = `bold 13px ${BODY}`;
        const t = String(count);
        const bwid = ctx.measureText(t).width + 14;
        ctx.fillStyle = node.style.color; rr(ctx, x + r.width + 6 - bwid, y - 8, bwid, 21, 10.5); ctx.fill();
        ctx.fillStyle = '#ffffff'; ctx.fillText(t, x + r.width + 6 - bwid / 2, y - 8 + 11);
      }
      ctx.textAlign = 'left';
    }

    const people = new Set(rows.map((r) => r.participant)).size;
    const d = new Date();
    ctx.font = `16px ${BODY}`; ctx.fillStyle = '#3f5a78'; ctx.textBaseline = 'middle';
    ctx.fillText(`${S.title ? S.title + ' · ' : ''}${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}. · ${people}명 참여, 응답 ${rows.length}개`, pad, H - footH / 2);

    out.toBlob((blob) => {
      const a = document.createElement('a');
      const safe = q.prompt.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 30);
      a.download = `워드클라우드_${safe}.png`.normalize('NFC');
      a.href = URL.createObjectURL(blob);
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }, 'image/png');
  }

  // ---------- 키보드 ----------
  document.addEventListener('keydown', (e) => {
    if (!S || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') step(1);
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') step(-1);
    else if (e.key === 'Escape') { closePop(); closeQr(); closeDrawer(); }
  });

  // ---------- 시작 ----------
  function route() {
    const h = new URLSearchParams(location.hash.slice(1));
    const id = h.get('s'), key = h.get('k');
    if (id && key) { if (!S || S.id !== id) openSession(id, key); }
    else showStart();
  }
  window.addEventListener('hashchange', route);
  const fontsReady = document.fonts
    ? Promise.race([document.fonts.load(`40px ${DISPLAY}`), new Promise((r) => setTimeout(r, 1500))]).catch(() => {})
    : Promise.resolve();
  fontsReady.then(route);
})();
