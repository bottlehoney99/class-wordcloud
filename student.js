(() => {
  const app = $('#app');

  let pid = storeGet('wc_pid', null);
  if (!pid) {
    pid = (crypto.randomUUID ? crypto.randomUUID() : 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
    storeSet('wc_pid', pid);
  }

  let session = null;   // {id, code, title, current_question_id, accepting}
  let question = null;  // {id, prompt, max_per_student}
  let questionNo = 0;
  let mine = [];        // 현재 질문에 내가 낸 단어
  let lastReply = '';   // 몽글이의 마지막 반응
  let draft = '';
  let channel = null;
  let pollTimer = null;
  let busy = false;

  const REASONS = {
    empty: '단어를 입력해 줘!',
    too_long: '30자 안으로 줄여 줄래?',
    limit: '이 질문에 낼 수 있는 개수를 다 썼어.',
    duplicate: '그 단어는 벌써 보냈어!',
    closed: '선생님이 입력을 잠깐 멈췄어.',
    not_current: '질문이 바뀌었어. 새 질문을 가져올게.',
    no_question: '질문을 찾을 수 없어.',
    bad_participant: '접속 정보가 이상해. 새로고침해 줄래?',
  };
  const CHEERS = ['좋아! 구름에 올라갔어', '오, 멋진 생각이야', '받았어! 선생님 화면을 봐 봐', '고마워! 잘 띄웠어'];

  // ---------- 코드 입력 ----------
  function showCodeForm(prefill = '', error = '') {
    app.replaceChildren();
    const input = el('input', {
      id: 'code', class: 'code-input', inputmode: 'numeric', autocomplete: 'off', maxlength: '6',
      placeholder: '000000', value: prefill,
    });
    input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, '').slice(0, 6); });
    const form = el('form', {
      onsubmit: (e) => { e.preventDefault(); if (input.value.length === 6) join(input.value); else input.focus(); },
    },
      el('label', { for: 'code', class: 'sr-only' }, '참여 코드 6자리'),
      input,
      el('button', { class: 'btn coral', type: 'submit' }, '들어가기'),
      el('div', { class: 'err', role: 'alert' }, error));
    app.append(el('div', { class: 'join-box' },
      mascot(120),
      el('div', { class: 'msg bot q' }, el('h1', {}, '참여 코드를 알려 줘!'), el('small', {}, '선생님 화면에 있는 숫자 6개야')),
      form,
      el('a', { class: 'foot', href: 'teacher.html' }, '선생님이신가요? 수업 만들기')));
    setTimeout(() => input.focus(), 50);
  }

  async function join(code) {
    const { data, error } = await sb.from('wc_sessions')
      .select('id, code, title, current_question_id, accepting').eq('code', code).maybeSingle();
    if (error) return showCodeForm(code, '연결이 잘 안 돼. 잠시 뒤에 다시 해 줘.');
    if (!data) return showCodeForm('', '그 코드의 수업을 못 찾았어. 다시 확인해 줄래?');
    session = data;
    storeSet('wc_last_code', code);
    if (new URLSearchParams(location.search).get('c') !== code) history.replaceState(null, '', '?c=' + code);
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
      if (!data) { session = null; clearInterval(pollTimer); return showCodeForm('', '수업이 끝났어. 함께해 줘서 고마워!'); }
      onSession(data);
    }, 7000);
  }

  function onSession(s) {
    const qChanged = s.current_question_id !== session.current_question_id;
    const accChanged = s.accepting !== session.accepting;
    session = { ...session, ...s };
    if (qChanged) { lastReply = ''; loadQuestion(); }
    else if (accChanged) render();
  }

  async function loadQuestion() {
    const qid = session.current_question_id;
    if (!qid) { question = null; mine = []; return render(); }
    const [q, r, list] = await Promise.all([
      sb.from('wc_questions').select('id, prompt, max_per_student').eq('id', qid).maybeSingle(),
      sb.from('wc_responses').select('word').eq('question_id', qid).eq('participant', pid).order('id'),
      sb.from('wc_questions').select('id').eq('session_id', session.id).order('position'),
    ]);
    if (session.current_question_id !== qid) return;
    question = q.data || null;
    mine = (r.data || []).map((x) => x.word);
    questionNo = (list.data || []).findIndex((x) => x.id === qid) + 1;
    render();
  }

  function limitOf() {
    if (!question) return 0;
    return question.max_per_student === 0 ? 30 : question.max_per_student;
  }

  // ---------- 화면 ----------
  function render() {
    const unlimited = question && question.max_per_student === 0;
    const head = el('header', { class: 's-head' },
      mascot(44, '#dcefff', false),
      el('div', { class: 'who' }, el('b', {}, '몽글이'),
        el('small', {}, `${session.title ? session.title + ' · ' : ''}코드 ${session.code}`)),
      question && !unlimited ? el('span', { class: 'count', 'aria-label': '낸 개수' }, `${mine.length}/${limitOf()}`) : null);

    const chat = el('main', { class: 'chat', 'aria-live': 'polite' });
    if (!question) {
      chat.append(el('div', { class: 'msg bot' }, '안녕! 선생님이 질문을 준비하고 있어.'),
        el('div', { class: 'msg bot' }, '질문이 오면 여기에 바로 보여 줄게.'));
    } else {
      chat.append(el('div', { class: 'msg bot' }, questionNo > 0 ? `${questionNo}번째 질문이야!` : '질문이 왔어!'));
      let hint = unlimited ? '여러 개 보내도 돼' : (question.max_per_student === 1 ? '딱 하나만 골라 줘' : `${question.max_per_student}개까지 보낼 수 있어`);
      if (question.max_per_student !== 1) hint += ' · 쉼표로 한 번에 보내도 돼';
      chat.append(el('div', { class: 'msg bot q' }, el('h1', {}, question.prompt), el('small', {}, hint)));
      mine.forEach((w) => chat.append(el('div', { class: 'msg me' }, w)));
      if (mine.length) chat.append(el('span', { class: 'msg-note' }, '구름에 올라갔어요'));
      const left = limitOf() - mine.length;
      if (lastReply) chat.append(el('div', { class: 'msg bot' }, lastReply));
      if (!session.accepting) chat.append(el('div', { class: 'msg bot' }, '선생님이 입력을 잠깐 멈췄어. 화면을 같이 봐 볼까?'));
      else if (left <= 0) chat.append(el('div', { class: 'msg bot' }, '다 보냈어! 선생님 화면에서 구름을 확인해 봐.'));
      else if (mine.length && !unlimited) chat.append(el('div', { class: 'msg bot' }, `${left}개 더 보낼 수 있어.`));
    }

    let bar;
    const canSend = question && session.accepting && limitOf() - mine.length > 0;
    if (canSend) {
      const input = el('input', { id: 'kw', maxlength: '200', autocomplete: 'off', placeholder: '떠오르는 단어를 써 봐', enterkeyhint: 'send', value: draft });
      input.addEventListener('input', () => { draft = input.value; });
      const btn = el('button', { class: 'send', type: 'submit', 'aria-label': '보내기' }, SEND_ICON());
      bar = el('form', { class: 's-input', onsubmit: (e) => { e.preventDefault(); submit(input, btn); } },
        el('label', { for: 'kw', class: 'sr-only' }, '키워드'), input, btn);
      setTimeout(() => input.focus({ preventScroll: true }), 30);
    } else {
      bar = el('div', { class: 's-input off' }, !question ? '질문을 기다리는 중…' : (!session.accepting ? '지금은 입력을 받지 않아요' : '이 질문은 다 보냈어요'));
    }

    app.replaceChildren(head, chat, bar);
    chat.scrollTop = chat.scrollHeight;
  }

  async function submit(input, btn) {
    if (busy) return;
    const raw = input.value;
    const parts = (question.max_per_student === 1 ? [raw] : raw.split(/[,，、]/))
      .map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
    if (!parts.length) return input.focus();
    busy = true; btn.disabled = true;
    let lastErr = '';
    let sent = 0;
    for (const w of parts) {
      if (w.length > 30) { lastErr = REASONS.too_long; continue; }
      const { data, error } = await sb.rpc('wc_submit', { p_qid: question.id, p_participant: pid, p_word: w });
      if (error) { lastErr = '전송이 안 됐어. 한 번 더 눌러 줄래?'; break; }
      if (data.ok) { mine.push(w); sent++; }
      else {
        lastErr = REASONS[data.reason] || '보내지 못했어.';
        if (data.reason === 'not_current') { busy = false; lastReply = ''; return loadQuestion(); }
        if (data.reason === 'closed') session.accepting = false;
        if (data.reason === 'limit' || data.reason === 'closed') break;
      }
    }
    busy = false;
    if (sent) { draft = ''; lastReply = lastErr || CHEERS[(mine.length - 1) % CHEERS.length]; }
    else { draft = raw; lastReply = lastErr; }
    render();
  }

  const code = (new URLSearchParams(location.search).get('c') || '').replace(/\D/g, '');
  if (code.length === 6) join(code);
  else showCodeForm('');
})();
