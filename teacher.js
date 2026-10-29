(() => {
  const app = $('#app');
  const FONT = getComputedStyle(document.documentElement).getPropertyValue('--font').trim()
    || "'Noto Sans KR', 'Malgun Gothic', sans-serif";
  const PALETTE = ['#c2462e', '#1f5f5b', '#a8720f', '#23201b', '#6b3d5c', '#3f6a2c', '#8a4b20', '#2c4a6b'];
  const MAX_OPTIONS = [1, 2, 3, 5, 10, 0];

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
  let S = null;          // {id, code, title, current_question_id, accepting}
  let KEY = null;
  let questions = [];
  let rows = [];         // 현재 질문 응답 {id, norm, word, hidden, participant}
  let channel = null;
  let pollTimer = null;
  let editingId = null;
  let lastSig = '';
  let drawTimer = null;
  let ui = {};

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
    const title = el('input', { placeholder: '예: 3학년 2반 국어', maxlength: '80', 'aria-label': '수업 이름' });
    const btn = el('button', { class: 'btn primary', type: 'submit' }, '새 수업 만들기');
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
    }, title, btn);

    const list = saved();
    app.replaceChildren(el('main', { class: 'start' },
      el('h1', {}, '워드클라우드 수업'),
      el('p', {}, '수업을 만들면 참여 코드와 QR이 생겨요. 학생은 휴대폰으로 코드를 입력하고 키워드를 보내면 됩니다.'),
      form,
      list.length ? el('section', { class: 'past' },
        el('h2', {}, '이 컴퓨터에서 만든 수업'),
        el('ul', {}, list.map((s) => el('li', {},
          el('a', { href: `#s=${s.id}&k=${s.key}` }, s.title || '(이름 없음)'),
          el('span', {}, s.code),
          el('button', { class: 'btn ghost small', onclick: () => { forget(s.id); showStart(); } }, '목록에서 빼기'),
        )))) : null,
      el('p', { style: 'margin-top:40px;font-size:14px' }, el('a', { href: './' }, '학생 참여 화면으로 가기')),
    ));
    setTimeout(() => title.focus(), 30);
  }

  function teardown() {
    if (channel) { sb.removeChannel(channel); channel = null; }
    clearInterval(pollTimer);
    S = null; KEY = null; questions = []; rows = []; lastSig = '';
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
    // 실시간 연결이 끊겨도 놓치지 않도록 주기적으로 다시 불러옴
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

    const promptBox = el('textarea', { placeholder: '새 질문 (예: 봄 하면 떠오르는 단어는?)', maxlength: '200', 'aria-label': '질문 내용' });
    promptBox.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); qform.requestSubmit(); }
    });
    const maxSel = el('select', { 'aria-label': '학생 1명당 입력 개수' },
      MAX_OPTIONS.map((n) => el('option', { value: String(n) }, maxLabel(n))));
    const addBtn = el('button', { class: 'btn primary small', type: 'submit' }, '질문 추가');
    const cancelBtn = el('button', { class: 'btn ghost small', type: 'button', style: 'display:none', onclick: () => endEdit() }, '취소');
    const qform = el('form', { class: 'qform', onsubmit: onQuestionSubmit },
      promptBox,
      el('div', { class: 'line' }, el('label', {}, '1명당'), maxSel, cancelBtn, addBtn));

    const qlist = el('ul', { class: 'qlist' });

    const side = el('aside', { class: 'side' },
      el('header', {}, titleInput, el('small', {}, '질문을 누르면 학생 화면에 바로 떠요.')),
      qlist, qform,
      el('div', { class: 'sessions' },
        el('button', { onclick: copyManageLink }, '관리 링크 복사'),
        el('button', { onclick: () => showStart() }, '다른 수업'),
      ));

    // 상단 막대
    const qrCanvas = el('canvas', { width: '64', height: '64', 'aria-hidden': 'true' });
    const live = el('div', {}, '연결 중…');
    const stats = el('div', { class: 'stats' });
    const accBtn = el('button', { class: 'toggle', onclick: toggleAccepting }, el('span', { class: 'dot' }), el('span', { class: 't' }));
    const topbar = el('div', { class: 'topbar' },
      el('div', { class: 'join', title: '크게 보기', onclick: openQr },
        qrCanvas,
        el('div', { class: 'where' }, el('b', {}, studentUrl(S.code).replace(/^https?:\/\//, '').replace(/\?c=.*/, '')), el('br'), '접속 후 코드 입력'),
        el('div', { class: 'code' }, S.code)),
      el('div', { class: 'spacer' }),
      stats, accBtn);

    const promptH = el('h2');
    const limit = el('div', { class: 'limit' });
    const canvas = el('canvas', { id: 'cloud' });
    const empty = el('div', { class: 'empty' });
    const wrap = el('div', { class: 'cloud-wrap' }, canvas, empty);

    const prevBtn = el('button', { class: 'btn', onclick: () => step(-1) }, '← 이전 질문');
    const nextBtn = el('button', { class: 'btn', onclick: () => step(1) }, '다음 질문 →');
    const bottombar = el('div', { class: 'bottombar' },
      prevBtn, nextBtn,
      el('div', { class: 'spacer' }),
      el('span', { style: 'font-size:13px;color:var(--ink-2);margin-right:6px' }, live),
      el('button', { class: 'btn', onclick: openDrawer }, '단어 관리'),
      el('button', { class: 'btn', onclick: savePng }, 'PNG 저장'),
      el('button', { class: 'btn hide-fs', onclick: toggleSide }, '목록 접기'),
      el('button', { class: 'btn', onclick: toggleFullscreen }, '전체 화면'));

    const stage = el('section', { class: 'stage' }, topbar,
      el('div', { class: 'prompt-area' }, promptH, limit), wrap, bottombar);

    const root = el('div', { class: 'teacher' }, side, stage);

    // 단어 관리 서랍
    const words = el('div', { class: 'words' });
    const drawer = el('aside', { class: 'drawer', 'aria-label': '단어 관리' },
      el('header', {}, el('h3', {}, '단어 관리'), el('button', { class: 'btn ghost small', onclick: closeDrawer }, '닫기')),
      words,
      el('footer', {}, el('button', { class: 'btn small', onclick: clearAll }, '이 질문의 응답 모두 지우기')));

    // QR 크게
    const bigQr = el('canvas', { width: '400', height: '400' });
    const qrOverlay = el('div', { class: 'qr-overlay', onclick: (e) => { if (e.target === qrOverlay) closeQr(); } },
      el('button', { class: 'btn close', onclick: closeQr }, '닫기'),
      bigQr,
      el('div', {}, el('div', { class: 'u' }, studentUrl(S.code).replace(/\?c=.*/, '')), el('div', { class: 'big' }, S.code),
        el('div', { class: 'u', style: 'margin-top:18px' }, 'QR을 찍거나 주소에 들어가 코드를 입력하세요')));

    app.replaceChildren(root, drawer, qrOverlay);
    ui = { root, side, stage, qlist, qform, promptBox, maxSel, addBtn, cancelBtn, stats, accBtn, promptH, limit, canvas, empty, wrap, prevBtn, nextBtn, words, drawer, live, qrOverlay };

    drawQr(qrCanvas, studentUrl(S.code), 64);
    drawQr(bigQr, studentUrl(S.code), 400);
    renderAccepting();

    new ResizeObserver(() => scheduleDraw(true)).observe(wrap);
  }

  function drawQr(canvas, text, size) {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const quiet = 2;
    const cell = Math.floor(size / (n + quiet * 2)) || 1;
    const px = cell * (n + quiet * 2);
    canvas.width = px; canvas.height = px;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = '#000';
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
              el('button', { title: '위로', onclick: (e) => { e.stopPropagation(); move(q, -1); } }, '↑'),
              el('button', { title: '아래로', onclick: (e) => { e.stopPropagation(); move(q, 1); } }, '↓'),
              el('button', { onclick: (e) => { e.stopPropagation(); startEdit(q); } }, '수정'),
              el('button', { onclick: (e) => { e.stopPropagation(); removeQuestion(q); } }, '삭제')))));
      li.addEventListener('click', () => setCurrent(q.id));
      return li;
    }));
    if (!questions.length) {
      ui.qlist.append(el('li', { style: 'padding:14px 8px;color:var(--ink-2);font-size:14px' }, '아래에 첫 질문을 입력하세요. 수업 전에 여러 개를 만들어 둘 수 있어요.'));
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
    rows = []; lastSig = '';
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
  }
  function renderAccepting() {
    ui.accBtn.classList.toggle('on', S.accepting);
    $('.t', ui.accBtn).textContent = S.accepting ? '입력 받는 중' : '입력 멈춤';
  }

  function renderPrompt() {
    const q = cur();
    ui.promptH.textContent = q ? q.prompt : '질문을 추가하거나 왼쪽에서 골라 주세요';
    ui.limit.textContent = q ? '1명당 ' + maxLabel(q.max_per_student) : '';
  }

  // ---------- 집계와 그리기 ----------
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

  function refresh() {
    const gs = groups();
    const visible = gs.filter((g) => !g.isHidden);
    const people = new Set(rows.map((r) => r.participant)).size;
    ui.stats.replaceChildren(
      el('div', {}, el('b', {}, String(people)), ' 명 참여'),
      el('div', {}, `응답 ${rows.length}개 · 단어 ${visible.length}종`));
    if (ui.drawer.classList.contains('open')) renderDrawer(gs);
    scheduleDraw(false);
  }

  function scheduleDraw(force) {
    if (force) lastSig = '';
    clearTimeout(drawTimer);
    drawTimer = setTimeout(drawCloud, force ? 150 : 350);
  }

  function colorFor(norm) {
    let h = 0;
    for (let i = 0; i < norm.length; i++) h = (h * 31 + norm.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }

  function drawCloud() {
    const visible = groups().filter((g) => !g.isHidden).slice(0, 150);
    const { canvas, wrap, empty } = ui;
    const dpr = 2; // 저장 PNG를 선명하게 하려고 항상 2배로 그림
    const W = Math.max(200, Math.floor(wrap.clientWidth * dpr));
    const H = Math.max(150, Math.floor(wrap.clientHeight * dpr));
    const sig = W + 'x' + H + '|' + visible.map((g) => g.norm + ':' + g.count).join(',');
    if (sig === lastSig) return;
    lastSig = sig;

    if (!cur()) { empty.textContent = ''; clearCanvas(); return; }
    if (!visible.length) {
      empty.textContent = S.accepting ? '학생들의 키워드를 기다리는 중이에요' : '아직 응답이 없어요';
      clearCanvas();
      return;
    }
    empty.textContent = '';
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }

    const m = visible[0].count;
    const n = visible.length;
    const maxSize = Math.min(H * 0.26, W * 0.13);
    const minSize = Math.max(15 * dpr, maxSize * 0.2);
    const list = visible.map((g) => {
      let size;
      if (m === 1) size = maxSize * Math.max(0.3, Math.min(0.8, 1.8 / Math.sqrt(n)));
      else size = minSize + (maxSize - minSize) * Math.sqrt((g.count - 1) / (m - 1));
      // 긴 단어가 화면을 넘지 않도록
      size = Math.min(size, (W * 0.9) / Math.max(1, g.word.length * 0.95));
      return [g.word, size, g.norm];
    });

    WordCloud(canvas, {
      list,
      fontFamily: FONT,
      fontWeight: '700',
      // 다섯 번째 이후 인자는 목록 항목의 세 번째 값부터 담긴 배열
      color: (word, weight, fontSize, distance, theta, extra) => colorFor((extra && extra[0]) || normWord(word)),
      backgroundColor: 'rgba(0,0,0,0)',
      rotateRatio: 0,
      shuffle: false,
      shrinkToFit: true,
      drawOutOfBound: false,
      gridSize: Math.round(9 * dpr),
      weightFactor: 1,
      minSize: 0,
      wait: 0,
      click: (item, dim, ev) => showPop(item, ev),
    });
  }

  function clearCanvas() {
    const ctx = ui.canvas.getContext('2d');
    ctx.clearRect(0, 0, ui.canvas.width, ui.canvas.height);
  }

  // ---------- 단어 숨기기·삭제 ----------
  let popEl = null;
  function closePop() { if (popEl) { popEl.remove(); popEl = null; } }
  function showPop(item, ev) {
    closePop();
    const norm = item[2];
    popEl = el('div', { class: 'pop', role: 'dialog' },
      el('span', { class: 'lbl' }, item[0]),
      el('button', { onclick: () => { closePop(); hideWord(norm, true); } }, '숨기기'),
      el('button', { onclick: () => { closePop(); deleteWord(norm); } }, '삭제'),
      el('button', { onclick: closePop }, '취소'));
    document.body.append(popEl);
    const x = Math.min(ev.clientX, window.innerWidth - popEl.offsetWidth - 10);
    const y = Math.max(10, ev.clientY - popEl.offsetHeight - 12);
    popEl.style.left = x + 'px'; popEl.style.top = y + 'px';
    setTimeout(() => document.addEventListener('pointerdown', outside, { once: true }), 0);
  }
  function outside(e) { if (popEl && !popEl.contains(e.target)) closePop(); else if (popEl) document.addEventListener('pointerdown', outside, { once: true }); }

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
      ui.words.replaceChildren(el('p', { style: 'padding:16px;color:var(--ink-2)' }, '아직 들어온 단어가 없어요.'));
      return;
    }
    ui.words.replaceChildren(...gs.map((g) => el('div', { class: 'wrow' + (g.isHidden ? ' hidden' : '') },
      el('span', { class: 'w' }, g.word),
      el('span', { class: 'n' }, String(g.count)),
      el('button', { class: 'btn small', onclick: () => hideWord(g.norm, !g.isHidden) }, g.isHidden ? '보이기' : '숨기기'),
      el('button', { class: 'btn small ghost', onclick: () => deleteWord(g.norm) }, '삭제'))));
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
      toast('관리 링크를 복사했어요. 다른 컴퓨터에서 이 링크로 열면 이어서 쓸 수 있어요. 학생에게는 보내지 마세요.');
    } catch (e) {
      window.prompt('아래 링크를 복사하세요. 학생에게는 보내지 마세요.', link);
    }
  }

  // ---------- PNG 저장 ----------
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
  function savePng() {
    const q = cur();
    if (!q) return toast('저장할 질문이 없어요.');
    const src = ui.canvas;
    const W = src.width;
    const pad = Math.round(W * 0.04);
    const fs = Math.round(Math.max(28, W * 0.032));
    const tmp = document.createElement('canvas').getContext('2d');
    tmp.font = `900 ${fs}px ${FONT}`;
    const lines = wrapLines(tmp, q.prompt, W - pad * 2);
    const headH = pad + lines.length * fs * 1.3 + pad * 0.5;
    const footH = Math.round(fs * 1.6);
    const out = document.createElement('canvas');
    out.width = W; out.height = Math.round(headH + src.height + footH);
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#f5f1e8'; ctx.fillRect(0, 0, out.width, out.height);
    ctx.fillStyle = '#23201b'; ctx.font = `900 ${fs}px ${FONT}`; ctx.textBaseline = 'top';
    lines.forEach((l, i) => ctx.fillText(l, pad, pad + i * fs * 1.3));
    ctx.drawImage(src, 0, headH);
    const people = new Set(rows.map((r) => r.participant)).size;
    const d = new Date();
    const ds = `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
    ctx.font = `400 ${Math.round(fs * 0.5)}px ${FONT}`; ctx.fillStyle = '#5d574c';
    ctx.fillText(`${S.title ? S.title + ' · ' : ''}${ds} · ${people}명 참여, 응답 ${rows.length}개`, pad, out.height - footH + fs * 0.4);
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
  (document.fonts ? document.fonts.load(`700 20px ${FONT}`).catch(() => {}) : Promise.resolve()).then(route);
})();
