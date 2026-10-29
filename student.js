(() => {
  const app = $('#app');
  const brand = $('.brand', app);

  let pid = storeGet('wc_pid', null);
  if (!pid) {
    pid = (crypto.randomUUID ? crypto.randomUUID() : 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
    storeSet('wc_pid', pid);
  }

  let session = null;   // {id, code, title, current_question_id, accepting}
  let question = null;  // {id, prompt, max_per_student}
  let mine = [];        // 현재 질문에 내가 낸 단어
  let channel = null;
  let pollTimer = null;
  let busy = false;

  const REASONS = {
    empty: '단어를 입력해 주세요.',
    too_long: '30자 이내로 입력해 주세요.',
    limit: '이 질문에 낼 수 있는 개수를 다 썼어요.',
    duplicate: '이미 낸 단어예요.',
    closed: '선생님이 입력을 잠시 멈췄어요.',
    not_current: '질문이 바뀌었어요. 화면을 다시 불러올게요.',
    no_question: '질문을 찾을 수 없어요.',
    bad_participant: '접속 정보가 올바르지 않아요. 새로고침해 주세요.',
  };

  function clear() {
    app.replaceChildren(brand);
  }

  function showCodeForm(prefill = '', error = '') {
    clear();
    const input = el('input', {
      class: 'code-input', inputmode: 'numeric', autocomplete: 'off', maxlength: '6',
      placeholder: '000000', value: prefill, 'aria-label': '참여 코드',
    });
    input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, '').slice(0, 6); });
    const form = el('form', {
      onsubmit: (e) => { e.preventDefault(); if (input.value.length === 6) join(input.value); },
    }, input, el('button', { class: 'btn primary', type: 'submit', style: 'padding:14px;font-size:18px' }, '참여하기'));
    app.append(
      el('h1', {}, '참여 코드를 입력하세요'),
      el('p', { class: 'hint' }, '선생님 화면에 보이는 6자리 숫자예요.'),
      form,
      el('div', { class: 'status-line', style: error ? 'color:var(--accent)' : '' }, error),
      el('div', { class: 'foot' }, el('a', { href: 'teacher.html' }, '선생님이신가요? 질문 만들기')),
    );
    setTimeout(() => input.focus(), 50);
  }

  async function join(code) {
    const { data, error } = await sb.from('wc_sessions')
      .select('id, code, title, current_question_id, accepting').eq('code', code).maybeSingle();
    if (error) return showCodeForm(code, '연결에 실패했어요. 잠시 뒤 다시 시도해 주세요.');
    if (!data) return showCodeForm('', '그 코드의 수업을 찾지 못했어요.');
    session = data;
    storeSet('wc_last_code', code);
    if (new URLSearchParams(location.search).get('c') !== code) {
      history.replaceState(null, '', '?c=' + code);
    }
    subscribe();
    await loadQuestion();
  }

  function subscribe() {
    if (channel) sb.removeChannel(channel);
    channel = sb.channel('stu-' + session.id)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'wc_sessions', filter: 'id=eq.' + session.id },
        (p) => onSession(p.new))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wc_questions', filter: 'session_id=eq.' + session.id },
        (p) => { if (question && (p.new?.id === question.id || p.old?.id === question.id)) loadQuestion(); })
      .subscribe();
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      const { data } = await sb.from('wc_sessions')
        .select('id, code, title, current_question_id, accepting').eq('id', session.id).maybeSingle();
      if (!data) { session = null; clearInterval(pollTimer); return showCodeForm('', '수업이 끝났어요.'); }
      onSession(data);
    }, 7000);
  }

  function onSession(s) {
    const qChanged = s.current_question_id !== session.current_question_id;
    const accChanged = s.accepting !== session.accepting;
    session = { ...session, ...s };
    if (qChanged) loadQuestion();
    else if (accChanged) render();
  }

  async function loadQuestion() {
    const qid = session.current_question_id;
    if (!qid) { question = null; mine = []; return render(); }
    const [q, r] = await Promise.all([
      sb.from('wc_questions').select('id, prompt, max_per_student').eq('id', qid).maybeSingle(),
      sb.from('wc_responses').select('word').eq('question_id', qid).eq('participant', pid).order('id'),
    ]);
    if (session.current_question_id !== qid) return; // 그새 바뀜
    question = q.data || null;
    mine = (r.data || []).map((x) => x.word);
    render();
  }

  function remaining() {
    if (!question) return 0;
    const max = question.max_per_student === 0 ? 30 : question.max_per_student;
    return Math.max(0, max - mine.length);
  }

  function render() {
    clear();
    if (session.title) brand.textContent = session.title;
    if (!question) {
      app.append(el('h1', {}, '잠시만 기다려 주세요'), el('p', { class: 'waiting' }, '선생님이 질문을 띄우면 여기에 나타나요.'));
      return;
    }
    const left = remaining();
    const unlimited = question.max_per_student === 0;
    app.append(el('h1', {}, question.prompt));

    let hint = unlimited ? '여러 개를 낼 수 있어요.' : `한 사람당 ${question.max_per_student}개까지 낼 수 있어요.`;
    if (question.max_per_student !== 1) hint += ' 쉼표(,)로 나눠 한 번에 써도 돼요.';
    app.append(el('p', { class: 'hint' }, hint));

    const status = el('div', { class: 'status-line' });
    if (!session.accepting) {
      status.textContent = '지금은 입력을 받지 않아요.';
    } else if (left === 0) {
      status.textContent = unlimited ? '최대 개수를 다 냈어요.' : '다 냈어요. 선생님 화면을 봐 주세요.';
    } else {
      const input = el('input', { maxlength: '200', autocomplete: 'off', placeholder: '키워드 입력', enterkeyhint: 'send', 'aria-label': '키워드' });
      const btn = el('button', { class: 'btn accent', type: 'submit' }, '보내기');
      const form = el('form', {
        onsubmit: async (e) => {
          e.preventDefault();
          if (busy) return;
          const raw = input.value;
          const parts = (question.max_per_student === 1 ? [raw] : raw.split(/[,，、]/))
            .map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
          if (!parts.length) return;
          busy = true; btn.disabled = true;
          let lastErr = '';
          let sent = 0;
          for (const w of parts) {
            if (w.length > 30) { lastErr = REASONS.too_long; continue; }
            const { data, error } = await sb.rpc('wc_submit', { p_qid: question.id, p_participant: pid, p_word: w });
            if (error) { lastErr = '전송에 실패했어요. 다시 눌러 주세요.'; break; }
            if (data.ok) { mine.push(w); sent++; }
            else {
              lastErr = REASONS[data.reason] || '보내지 못했어요.';
              if (data.reason === 'not_current') { busy = false; return loadQuestion(); }
              if (data.reason === 'closed') session.accepting = false;
              if (data.reason === 'limit' || data.reason === 'closed') break;
            }
          }
          busy = false;
          render();
          if (lastErr) toast(lastErr, 'error');
          else if (sent) toast('보냈어요!');
        },
      }, el('div', { class: 'row' }, input, btn));
      app.append(form);
      if (!unlimited) status.textContent = `남은 개수 ${left}개`;
      setTimeout(() => input.focus(), 30);
    }
    app.append(status);

    if (mine.length) {
      app.append(el('section', { class: 'mine' },
        el('h2', {}, '내가 낸 단어'),
        el('div', { class: 'chips' }, mine.map((w) => el('span', { class: 'chip' }, w)))));
    }
    app.append(el('div', { class: 'foot' }, `참여 코드 ${session.code}`));
  }

  // 시작
  const code = (new URLSearchParams(location.search).get('c') || '').replace(/\D/g, '');
  if (code.length === 6) join(code);
  else showCodeForm('');
})();
