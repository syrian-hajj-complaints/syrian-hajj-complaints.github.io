(() => {
  'use strict';

  // =====================================================================
  //  أدوات مساعدة
  // =====================================================================
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const show = (el, on = true) => el.classList.toggle('hidden', !on);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cleanName = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const nameKey = (s) => cleanName(s).toLowerCase();
  const countWords = (s) => (String(s ?? '').trim().match(/\S+/g) || []).length;
  const wordsLabel = (n) => (n === 1 ? 'كلمة واحدة' : n === 2 ? 'كلمتان' : n >= 3 && n <= 10 ? `${n} كلمات` : `${n} كلمة`);
  // التاريخ: ميلادي وهجري (تقويم أم القرى؛ قد يختلف يوماً عن رؤية الهلال المحلية)
  const HIJRI = 'ar-SA-u-ca-islamic-umalqura-nu-latn';
  const gregFull = new Intl.DateTimeFormat('ar', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const gregWeekday = new Intl.DateTimeFormat('ar', { weekday: 'long' });
  const gregMonth = new Intl.DateTimeFormat('ar', { month: 'long', year: 'numeric' });
  const timeFmt = new Intl.DateTimeFormat('ar', { timeStyle: 'short' });
  const hijriFull = new Intl.DateTimeFormat(HIJRI, { day: 'numeric', month: 'long', year: 'numeric' });
  const hijriDay = new Intl.DateTimeFormat(HIJRI, { day: 'numeric' });
  const hijriMonth = new Intl.DateTimeFormat(HIJRI, { month: 'long' });
  const hijriMonthShort = new Intl.DateTimeFormat(HIJRI, { month: 'short' });
  const hijriMonthYear = new Intl.DateTimeFormat(HIJRI, { month: 'long', year: 'numeric' });
  const hijriDayNum = (d) => Number(new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', { day: 'numeric' }).format(d));
  const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const fmtDateTime = (iso) => {
    const d = new Date(iso);
    return `${gregFull.format(d)} · ${hijriFull.format(d)} · ${timeFmt.format(d)}`;
  };
  const fmtTime = (iso) => timeFmt.format(new Date(iso));
  const toLocalInput = (iso) => {
    const d = iso ? new Date(iso) : new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  };
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    }));

  let toastTimer;
  function toast(msg, type = 'ok') {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `toast show ${type}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = 'toast'), 3500);
  }
  function fail(error) {
    console.error(error);
    toast(isNetErr(error) ? 'لا يوجد اتصال بالإنترنت' : (error?.message || 'حدث خطأ غير متوقع'), 'err');
  }

  // خطأ اتصال (لا إنترنت) أم خطأ حقيقي من الخادم؟
  const isNetErr = (e) => !navigator.onLine ||
    /failed to fetch|networkerror|network request failed|load failed|fetch failed|timeout/i.test(`${e?.message || ''} ${e?.details || ''}`);
  // أخطاء بيانات لا فائدة من إعادة محاولتها (مثل: الاجتماع حُذف من جهاز آخر)
  const isDataErr = (e) => /^(P0001|22|23|42703|PGRST116)/.test(e?.code || '');

  function requireOnline() {
    if (navigator.onLine) return true;
    toast('هذا الإجراء يحتاج اتصالاً بالإنترنت. التفقّد والملاحظات تعمل بدونه.', 'err');
    return false;
  }

  // =====================================================================
  //  الإعداد
  // =====================================================================
  const cfg = window.APP_CONFIG || {};
  if (!window.supabase || !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || cfg.SUPABASE_URL.includes('YOUR-PROJECT')) {
    show($('#config-screen'));
    return;
  }
  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

  // كل البيانات في جدول واحد: list (قائمة) / member (اسم) / meeting (اجتماع)
  const TABLE = 'meeting_attendance';
  const tbl = () => sb.from(TABLE);
  const MEETING_COLS = 'id, name, meeting_date, location, list_ids, present, late, notes';

  const CACHE_KEY = 'att-cache-v1';   // آخر نسخة من البيانات (للفتح بدون إنترنت)
  const OUTBOX_KEY = 'att-outbox-v1'; // تعديلات لم تُرفع بعد
  const USER_KEY = 'att-user';        // آخر مستخدم دخل من هذا الجهاز

  const normMeeting = (r) => ({
    id: r.id,
    name: r.name,
    meeting_date: r.meeting_date,
    location: r.location || null,
    list_ids: r.list_ids || [],
    present: r.present || {},
    late: r.late || {},
    notes: r.notes || [],
  });

  const state = {
    lists: [],
    currentListId: localStorage.getItem('current-list') || null,
    members: [],
    meetings: [],
    openId: null,
    attSort: localStorage.getItem('att-sort') || 'name',
    collapsed: (() => { try { return JSON.parse(localStorage.getItem('att-collapsed') || '{}'); } catch (_) { return {}; } })(),
    attList: 'all',
    attSearch: '',
    membersSearch: '',
    pendingImport: null,
  };

  // =====================================================================
  //  الحفظ على الجهاز
  // =====================================================================
  function saveCache() {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        lists: state.lists, members: state.members, meetings: state.meetings, savedAt: new Date().toISOString(),
      }));
    } catch (err) { console.warn('cache save failed', err); }
  }
  function loadCache() {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (!c) return;
      state.lists = c.lists || [];
      state.members = c.members || [];
      state.meetings = (c.meetings || []).map(normMeeting);
    } catch (_) { /* نسخة تالفة: تُتجاهل */ }
  }

  // =====================================================================
  //  صندوق الانتظار: كل تعديل على الاجتماعات يُطبَّق فوراً على الجهاز،
  //  ويُرفع إلى Supabase بالترتيب متى توفر الإنترنت.
  // =====================================================================
  let outbox = [];
  try { outbox = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]'); } catch (_) { outbox = []; }
  const saveOutbox = () => localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox));
  let flushing = false;
  let inflight = null;
  let queuedOffline = false;

  // تطبيق تعديل على نسخة الاجتماعات (يمكن تكراره بلا ضرر)
  function applyOp(meetings, op) {
    const find = (id) => meetings.find((m) => m.id === id);
    switch (op.t) {
      case 'mcreate':
        if (!find(op.row.id)) meetings.push(normMeeting(op.row));
        meetings.sort((a, b) => new Date(b.meeting_date) - new Date(a.meeting_date));
        break;
      case 'mupdate': {
        const m = find(op.id);
        if (m) Object.assign(m, op.patch);
        meetings.sort((a, b) => new Date(b.meeting_date) - new Date(a.meeting_date));
        break;
      }
      case 'mdelete': {
        const i = meetings.findIndex((m) => m.id === op.id);
        if (i >= 0) meetings.splice(i, 1);
        break;
      }
      case 'status': {
        const m = find(op.m);
        if (!m) break;
        delete m.present[op.member];
        delete m.late[op.member];
        if (op.s === 'present') m.present[op.member] = op.at;
        if (op.s === 'late') m.late[op.member] = op.at;
        break;
      }
      case 'note+': {
        const m = find(op.m);
        if (m && !m.notes.some((n) => n.id === op.note.id)) m.notes.push(op.note);
        break;
      }
      case 'note-': {
        const m = find(op.m);
        if (m) m.notes = m.notes.filter((n) => n.id !== op.id);
        break;
      }
    }
    return meetings;
  }

  // إرسال تعديل إلى Supabase
  function runOp(op) {
    switch (op.t) {
      case 'mcreate':
        return tbl().upsert({ ...op.row, kind: 'meeting' }, { onConflict: 'id', ignoreDuplicates: true });
      case 'mupdate':
        return tbl().update(op.patch).eq('id', op.id).eq('kind', 'meeting');
      case 'mdelete':
        return tbl().delete().eq('id', op.id).eq('kind', 'meeting');
      case 'status':
        return sb.rpc('meeting_attendance_set_status', { p_meeting: op.m, p_member: op.member, p_status: op.s, p_at: op.at });
      case 'note+':
        return sb.rpc('meeting_attendance_add_note',
          { p_meeting: op.m, p_content: op.note.content, p_id: op.note.id, p_created_at: op.note.created_at });
      case 'note-':
        return sb.rpc('meeting_attendance_delete_note', { p_meeting: op.m, p_note: op.id });
      default:
        return Promise.resolve({ error: null });
    }
  }

  const opMeeting = (o) => o.m || o.id || o.row?.id;

  function enqueue(op) {
    op.qid = uuid();
    op.tries = 0;
    const live = (o) => o.qid === inflight; // التعديل الجاري إرساله لا يُلغى
    if (op.t === 'status') {
      // يكفي آخر علامة لكل شخص في الاجتماع
      outbox = outbox.filter((o) => live(o) || !(o.t === 'status' && o.m === op.m && o.member === op.member));
    }
    let skip = false;
    if (op.t === 'mdelete') {
      // اجتماع لم يُرفع بعد ثم حُذف: لا داعي لرفعه ولا لحذفه
      const createdLocally = outbox.some((o) => o.t === 'mcreate' && o.row.id === op.id && !live(o));
      outbox = outbox.filter((o) => live(o) || opMeeting(o) !== op.id);
      skip = createdLocally;
    }
    if (!skip) outbox.push(op);
    if (!navigator.onLine) queuedOffline = true;
    saveOutbox();
    applyOp(state.meetings, op);
    saveCache();
    renderAfterMeetingChange();
    flush();
  }

  async function flush() {
    updateSyncUI();
    if (flushing || !navigator.onLine || !outbox.length) return;
    flushing = true;
    let sent = 0;
    let retryLater = false;
    try {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) return; // يُرفع بعد تسجيل الدخول
      updateSyncUI();
      while (outbox.length && navigator.onLine) {
        const op = outbox[0];
        inflight = op.qid;
        const { error } = await runOp(op);
        inflight = null;
        if (error) {
          if (isNetErr(error)) { retryLater = true; break; }
          op.tries = (op.tries || 0) + 1;
          if (isDataErr(error) || op.tries >= 5) {
            console.error('dropped op', op, error);
            outbox = outbox.filter((o) => o.qid !== op.qid);
            saveOutbox();
            toast(`تعذّر رفع تعديل: ${error.message}`, 'err');
            continue;
          }
          saveOutbox();
          retryLater = true;
          break;
        }
        outbox = outbox.filter((o) => o.qid !== op.qid);
        saveOutbox();
        sent++;
        updateSyncUI();
      }
    } catch (err) {
      retryLater = true;
      console.warn('flush', err);
    } finally {
      flushing = false;
      inflight = null;
      updateSyncUI();
    }
    if (sent && !outbox.length) {
      if (queuedOffline) toast(`تم رفع ${sent} تعديل إلى المنصة ✓`);
      queuedOffline = false;
      refreshMeetingsSoon();
    }
    if (outbox.length && retryLater) setTimeout(flush, 15000);
  }

  function updateSyncUI() {
    const el = $('#sync-status');
    if (!el) return;
    const n = outbox.length;
    let text;
    let cls;
    if (!navigator.onLine) { text = `📴 بدون إنترنت${n ? ` · ${n} بانتظار الرفع` : ''}`; cls = 'off'; }
    else if (flushing && n) { text = `⏳ جارٍ الرفع (${n})`; cls = 'busy'; }
    else if (n) { text = `⏳ ${n} بانتظار الرفع`; cls = 'busy'; }
    else { text = '✓ محفوظ'; cls = 'ok'; }
    el.textContent = text;
    el.className = `sync ${cls}`;
  }

  window.addEventListener('online', async () => {
    updateSyncUI();
    const { data } = await sb.auth.getSession();
    // دخل بدون إنترنت بجلسة منتهية: يُطلب الدخول الآن (التعديلات المعلّقة تبقى وتُرفع بعده)
    if (!data.session) return handleSession(null);
    if (!booted) handleSession(data.session);
    else { flush(); refreshAll(); }
  });
  window.addEventListener('offline', updateSyncUI);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && booted && navigator.onLine) { flush(); refreshAll(); }
  });

  // =====================================================================
  //  المصادقة (تعمل بدون إنترنت لمن دخل سابقاً من هذا الجهاز)
  // =====================================================================
  let booted = false;
  sb.auth.onAuthStateChange((_event, session) => {
    setTimeout(() => handleSession(session), 0);
  });

  function handleSession(session) {
    const remembered = localStorage.getItem(USER_KEY);
    if (session) localStorage.setItem(USER_KEY, displayUser(session.user.email || ''));
    if (session || (!navigator.onLine && remembered)) {
      show($('#login-screen'), false);
      show($('#app'));
      $('#user-email').textContent = session ? displayUser(session.user.email || '') : remembered;
      if (!booted) { booted = true; boot(); } else flush();
    } else {
      booted = false;
      show($('#app'), false);
      show($('#login-screen'));
    }
  }

  // الدخول باسم مستخدم: «admin» يصبح admin@attendance.local (هكذا يُنشأ الحساب في Supabase)
  const LOGIN_DOMAIN = 'attendance.local';
  const toLoginEmail = (v) => {
    const s = v.trim().toLowerCase();
    return s.includes('@') ? s : `${s}@${LOGIN_DOMAIN}`;
  };
  const displayUser = (email) => email.endsWith(`@${LOGIN_DOMAIN}`) ? email.slice(0, -LOGIN_DOMAIN.length - 1) : email;

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('button');
    $('#login-error').textContent = '';
    if (!navigator.onLine) { $('#login-error').textContent = 'تسجيل الدخول أول مرة يحتاج اتصالاً بالإنترنت'; return; }
    btn.disabled = true;
    const { error } = await sb.auth.signInWithPassword({ email: toLoginEmail(f.email.value), password: f.password.value });
    btn.disabled = false;
    if (error) $('#login-error').textContent = isNetErr(error) ? 'لا يوجد اتصال بالإنترنت' : 'بيانات الدخول غير صحيحة';
    else f.reset();
  });

  $('#logout-btn').addEventListener('click', async () => {
    if (outbox.length && !confirm(`يوجد ${outbox.length} تعديل لم يُرفع بعد. سيُرفع بعد تسجيل الدخول مجدداً من هذا الجهاز.\nتسجيل الخروج؟`)) return;
    localStorage.removeItem(USER_KEY);
    await sb.auth.signOut();
    handleSession(null);
  });

  async function boot() {
    // 1) ما هو محفوظ على الجهاز (يعمل بدون إنترنت)
    loadCache();
    for (const op of outbox) applyOp(state.meetings, op);
    if (!currentList()) state.currentListId = state.lists[0]?.id || null;
    renderAll();
    showView('meetings');
    updateSyncUI();
    // 2) أحدث نسخة من المنصة، ثم رفع ما ينتظر
    await refreshAll();
    flush();
  }

  // =====================================================================
  //  التحميل من المنصة
  // =====================================================================
  async function fetchAll(build) {
    const all = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await build().range(from, from + 999);
      if (error) throw error;
      all.push(...data);
      if (data.length < 1000) break;
    }
    return all;
  }
  const fetchLists = () => fetchAll(() => tbl().select('id, name').eq('kind', 'list').order('created_at'));
  const fetchMembers = async () => (await fetchAll(() => tbl().select('id, name, list_id, photo_url')
    .eq('kind', 'member').order('name').order('id')))
    .map((r) => ({ id: r.id, full_name: r.name, list_id: r.list_id, photo_url: r.photo_url }));
  const fetchMeetings = async () => (await fetchAll(() => tbl().select(MEETING_COLS)
    .eq('kind', 'meeting').order('meeting_date', { ascending: false }).order('id')))
    .map(normMeeting);

  let refreshing = false;
  async function refreshAll() {
    if (!navigator.onLine || refreshing) return;
    refreshing = true;
    try {
      const [lists, members, meetings] = await Promise.all([fetchLists(), fetchMembers(), fetchMeetings()]);
      state.lists = lists;
      state.members = members;
      for (const op of outbox) applyOp(meetings, op); // ما لم يُرفع بعد يبقى ظاهراً
      state.meetings = meetings;
      if (!currentList()) state.currentListId = state.lists[0]?.id || null;
      saveCache();
      renderAll();
    } catch (err) {
      if (!isNetErr(err)) fail(err);
    } finally {
      refreshing = false;
    }
  }

  async function refreshMeetings() {
    if (!navigator.onLine || refreshing || flushing) return;
    try {
      const meetings = await fetchMeetings();
      for (const op of outbox) applyOp(meetings, op);
      state.meetings = meetings;
      saveCache();
      renderAfterMeetingChange();
    } catch (err) {
      if (!isNetErr(err)) console.warn(err);
    }
  }
  let refreshTimer;
  const refreshMeetingsSoon = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refreshMeetings, 1500); };

  // أثناء فتح اجتماع: جلب ما سجّله الآخرون من أجهزتهم كل 20 ثانية
  setInterval(() => {
    if (state.openId && navigator.onLine && !outbox.length && document.visibilityState === 'visible') refreshMeetings();
  }, 20000);

  // =====================================================================
  //  التنقل والعرض
  // =====================================================================
  function showView(name) {
    ['meetings', 'members', 'meeting'].forEach((v) => show($(`#view-${v}`), v === name));
    $$('.tab').forEach((t) => t.classList.toggle('active',
      t.dataset.view === name || (name === 'meeting' && t.dataset.view === 'meetings')));
  }
  $$('.tab').forEach((t) => t.addEventListener('click', () => {
    if (t.dataset.view === 'meetings') { state.openId = null; refreshMeetingsSoon(); }
    showView(t.dataset.view);
  }));

  function renderAll() {
    renderLists();
    renderMembers();
    renderAfterMeetingChange();
  }
  function renderAfterMeetingChange() {
    renderMeetings();
    if (state.openId) renderMeetingView();
  }

  // =====================================================================
  //  القوائم
  // =====================================================================
  const listName = (id) => state.lists.find((l) => l.id === id)?.name || '';
  const currentList = () => state.lists.find((l) => l.id === state.currentListId) || null;
  const membersOf = (listId) => state.members.filter((m) => m.list_id === listId);

  // القوائم المشاركة في اجتماع (الموجودة فعلاً)؛ اجتماع بلا قوائم محددة = كل القوائم
  const meetingLists = (m) => {
    const chosen = state.lists.filter((l) => m.list_ids.includes(l.id));
    return chosen.length ? chosen : state.lists;
  };
  const rosterOf = (m) => {
    const ids = new Set(meetingLists(m).map((l) => l.id));
    return state.members.filter((x) => ids.has(x.list_id));
  };
  const statusOf = (m, id) => (m.present[id] ? 'present' : m.late[id] ? 'late' : null);
  const countsOf = (m, roster = rosterOf(m)) => {
    const c = { total: roster.length, present: 0, late: 0, absent: 0 };
    for (const x of roster) {
      const s = statusOf(m, x.id);
      if (s) c[s]++; else c.absent++;
    }
    return c;
  };

  function selectList(id) {
    state.currentListId = id;
    localStorage.setItem('current-list', id || '');
    state.membersSearch = '';
    $('#members-search').value = '';
    state.pendingImport = null;
    show($('#import-preview'), false);
    renderLists();
    renderMembers();
  }

  function renderLists() {
    const has = state.lists.length > 0;
    show($('#no-lists'), !has);
    show($('#members-body'), has);
    $('#list-bar').innerHTML = state.lists.map((l) => `
      <button class="list-chip ${l.id === state.currentListId ? 'active' : ''}" data-list="${l.id}">
        ${esc(l.name)} <span class="count">${membersOf(l.id).length}</span>
      </button>`).join('');
    const cur = currentList();
    $('#current-list-title').textContent = cur?.name || '';
    $('#target-list-name').textContent = cur?.name || '';
  }

  $('#list-bar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-list]');
    if (b) selectList(b.dataset.list);
  });

  $('#new-list-btn').addEventListener('click', async () => {
    if (!requireOnline()) return;
    const name = cleanName(prompt('اسم القائمة الجديدة (مثل: رؤساء المجموعات):'));
    if (!name) return;
    if (state.lists.some((l) => nameKey(l.name) === nameKey(name))) return toast('توجد قائمة بهذا الاسم', 'err');
    const { data, error } = await tbl().insert({ kind: 'list', name }).select('id, name').single();
    if (error) return fail(error);
    state.lists.push(data);
    saveCache();
    toast(`تم إنشاء قائمة «${name}»`);
    selectList(data.id);
  });

  $('#rename-list-btn').addEventListener('click', async () => {
    const cur = currentList();
    if (!cur || !requireOnline()) return;
    const name = cleanName(prompt('الاسم الجديد للقائمة:', cur.name));
    if (!name || name === cur.name) return;
    const { error } = await tbl().update({ name }).eq('id', cur.id).eq('kind', 'list');
    if (error) return fail(error);
    cur.name = name;
    saveCache();
    renderAll();
    toast('تمت إعادة التسمية');
  });

  $('#delete-list-btn').addEventListener('click', async () => {
    const cur = currentList();
    if (!cur || !requireOnline()) return;
    const n = membersOf(cur.id).length;
    if (!confirm(`حذف قائمة «${cur.name}» مع أسمائها (${n} اسم)؟\nأسماء الحاضرين والغائبين في الاجتماعات السابقة تبقى محفوظة في سجلها.`)) return;
    const { error } = await tbl().delete().eq('id', cur.id).eq('kind', 'list');
    if (error) return fail(error);
    state.lists = state.lists.filter((l) => l.id !== cur.id);
    state.members = state.members.filter((m) => m.list_id !== cur.id);
    saveCache();
    toast('تم حذف القائمة');
    selectList(state.lists[0]?.id || null);
    renderAfterMeetingChange();
  });

  // =====================================================================
  //  الصور
  // =====================================================================
  const isUrl = (s) => /^https?:\/\/\S+$/i.test(String(s ?? '').trim());

  // روابط المشاركة الشائعة تُحوَّل إلى رابط صورة مباشر (الرابط الأصلي هو المحفوظ)
  function photoSrc(url) {
    const u = String(url || '').trim();
    if (!u) return '';
    const drive = u.match(/(?:drive|docs)\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:[^#]*&)?id=|thumbnail\?(?:[^#]*&)?id=)([\w-]{20,})/);
    if (drive) return `https://drive.google.com/thumbnail?id=${drive[1]}&sz=w400`;
    if (/(^|\.)dropbox\.com\//.test(u)) {
      try { const x = new URL(u); x.searchParams.delete('dl'); x.searchParams.set('raw', '1'); return x.toString(); } catch (_) { /* كما هو */ }
    }
    return u;
  }

  const initial = (name) => cleanName(name).charAt(0) || '؟';
  const avatar = (m) => `
    <span class="avatar" data-i="${esc(initial(m.full_name))}" ${m.photo_url ? `data-zoom="${m.id}"` : ''}>
      ${m.photo_url ? `<img src="${esc(photoSrc(m.photo_url))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
    </span>`;

  // صورة تعذّر فتحها: يظهر الحرف الأول بدلها
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (img.tagName === 'IMG' && img.parentElement?.classList.contains('avatar')) {
      img.parentElement.removeAttribute('data-zoom');
      img.parentElement.title = 'تعذّر فتح الصورة: تأكد أن الرابط عام (متاح لأي شخص لديه الرابط)';
      img.remove();
    }
  }, true);

  function zoomPhoto(id) {
    const m = state.members.find((x) => x.id === id);
    if (!m?.photo_url) return;
    $('#photo-dialog-img').src = photoSrc(m.photo_url).replace(/sz=w\d+/, 'sz=w1000');
    $('#photo-dialog-name').textContent = m.full_name;
    $('#photo-dialog').showModal();
  }
  $('#photo-dialog').addEventListener('click', () => $('#photo-dialog').close());

  // =====================================================================
  //  الأسماء
  // =====================================================================
  async function reloadMembers() {
    try {
      state.members = await fetchMembers();
      saveCache();
      renderAll();
    } catch (err) { fail(err); }
  }

  function renderMembers() {
    const inList = membersOf(state.currentListId);
    $('#members-count').textContent = `${inList.length} اسم`;
    const q = state.membersSearch.trim();
    const list = inList.filter((m) => !q || m.full_name.includes(q));
    const el = $('#members-list');
    if (!inList.length) {
      el.innerHTML = `<li class="empty">لا توجد أسماء في هذه القائمة بعد. استورد ملف Excel أو أضف الأسماء يدوياً.</li>`;
      return;
    }
    if (!list.length) { el.innerHTML = `<li class="empty">لا نتائج.</li>`; return; }
    el.innerHTML = list.map((m, i) => `
      <li>
        <span class="num">${i + 1}</span>
        ${avatar(m)}
        <span class="name">${esc(m.full_name)}</span>
        <button class="icon-btn" data-photo-edit="${m.id}" title="${m.photo_url ? 'تغيير الصورة' : 'إضافة صورة'}">🖼</button>
        <button class="icon-btn" data-edit="${m.id}" title="تعديل الاسم">✎</button>
        <button class="icon-btn del" data-del="${m.id}" title="حذف">✕</button>
      </li>`).join('');
  }

  $('#members-search').addEventListener('input', (e) => { state.membersSearch = e.target.value; renderMembers(); });

  $('#members-list').addEventListener('click', async (e) => {
    const zoom = e.target.closest('[data-zoom]');
    if (zoom) return zoomPhoto(zoom.dataset.zoom);

    const photoId = e.target.dataset.photoEdit;
    const editId = e.target.dataset.edit;
    const delId = e.target.dataset.del;
    if (!(photoId || editId || delId) || !requireOnline()) return;

    if (photoId) {
      const m = state.members.find((x) => x.id === photoId);
      const v = prompt(`رابط صورة «${m.full_name}»\n(اتركه فارغاً لحذف الصورة)`, m.photo_url || '');
      if (v === null) return;
      const url = v.trim();
      if (url && !isUrl(url)) return toast('الرابط يجب أن يبدأ بـ http:// أو https://', 'err');
      const { error } = await tbl().update({ photo_url: url || null }).eq('id', photoId).eq('kind', 'member');
      if (error) return fail(error);
      m.photo_url = url || null;
      saveCache();
      renderAll();
      toast(url ? 'تم حفظ الصورة' : 'تم حذف الصورة');
    }
    if (editId) {
      const m = state.members.find((x) => x.id === editId);
      const name = cleanName(prompt('تعديل الاسم:', m.full_name));
      if (!name || name === m.full_name) return;
      const { error } = await tbl().update({ name }).eq('id', editId).eq('kind', 'member');
      if (error) return fail(error);
      toast('تم تعديل الاسم');
      reloadMembers();
    }
    if (delId) {
      const m = state.members.find((x) => x.id === delId);
      if (!confirm(`حذف «${m.full_name}»؟\nلن يظهر بعدها في قوائم التفقّد.`)) return;
      const { error } = await tbl().delete().eq('id', delId).eq('kind', 'member');
      if (error) return fail(error);
      toast('تم الحذف');
      reloadMembers();
    }
  });

  // خطة الإضافة إلى قائمة: الأسماء الجديدة، وصور جديدة لأسماء موجودة، والمكرر المتجاهَل
  function planImport(entries, listId) {
    const existing = new Map(membersOf(listId).map((m) => [nameKey(m.full_name), m]));
    const seen = new Set();
    const fresh = [];
    const photoUpdates = [];
    let dup = 0;
    for (const e of entries) {
      const name = cleanName(e.name);
      const photo = String(e.photo || '').trim();
      if (!name) continue;
      const k = nameKey(name);
      if (seen.has(k)) { dup++; continue; }
      seen.add(k);
      const old = existing.get(k);
      if (old) {
        if (photo && photo !== old.photo_url) photoUpdates.push({ id: old.id, name: old.full_name, photo });
        else dup++;
        continue;
      }
      fresh.push({ name, photo });
    }
    return { listId, fresh, photoUpdates, dup };
  }

  async function savePlan(plan) {
    if (!requireOnline()) return false;
    const { listId, fresh, photoUpdates, dup } = plan;
    if (!fresh.length && !photoUpdates.length) {
      toast(dup ? 'كل الأسماء موجودة مسبقاً في هذه القائمة' : 'لا توجد أسماء', 'err');
      return false;
    }
    for (let i = 0; i < fresh.length; i += 500) {
      const chunk = fresh.slice(i, i + 500).map((x) => ({ kind: 'member', name: x.name, list_id: listId, photo_url: x.photo || null }));
      const { error } = await tbl().insert(chunk);
      if (error) { fail(error); await reloadMembers(); return false; }
    }
    for (let i = 0; i < photoUpdates.length; i += 20) {
      const results = await Promise.all(photoUpdates.slice(i, i + 20).map((u) =>
        tbl().update({ photo_url: u.photo }).eq('id', u.id).eq('kind', 'member')));
      const err = results.find((r) => r.error)?.error;
      if (err) { fail(err); await reloadMembers(); return false; }
    }
    const parts = [];
    if (fresh.length) parts.push(`إضافة ${fresh.length} اسم`);
    if (photoUpdates.length) parts.push(`صور ${photoUpdates.length} اسم موجود`);
    toast(`تم في «${listName(listId)}»: ${parts.join('، ')}${dup ? ` (وتجاهل ${dup} مكرر)` : ''}`);
    await reloadMembers();
    return true;
  }

  // ---------- إضافة يدوية: كل سطر اسم، ويمكن أن يتبعه رابط صورة ----------
  $('#manual-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    if (!state.currentListId) return toast('أنشئ قائمة أولاً', 'err');
    const entries = f.names.value.split(/\r?\n/).map((line) => {
      const url = line.match(/https?:\/\/\S+/i)?.[0] || '';
      return { name: url ? line.replace(url, ' ') : line, photo: url };
    });
    const btn = f.querySelector('button');
    btn.disabled = true;
    const ok = await savePlan(planImport(entries, state.currentListId));
    btn.disabled = false;
    if (ok) f.reset();
  });

  // ---------- استيراد Excel ----------
  const HEADER_WORDS = ['الاسم', 'اسم', 'الأسماء', 'الاسماء', 'الاسم الكامل', 'name', 'names', 'full name', 'fullname'];

  // الاسم من العمود الأول، والصورة من أول رابط في بقية الأعمدة (نصاً أو ارتباطاً تشعبياً)
  async function readExcel(file) {
    if (!window.XLSX) throw new Error('تعذّر تحميل مكتبة Excel، تحقق من اتصال الإنترنت');
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet || !sheet['!ref']) return [];
    const range = XLSX.utils.decode_range(sheet['!ref']);
    const rows = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
      let name = '';
      let photo = '';
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = sheet[XLSX.utils.encode_cell({ r, c })];
        if (!cell) continue;
        const text = cleanName(cell.w ?? cell.v);
        const link = cell.l?.Target && isUrl(cell.l.Target) ? cell.l.Target : '';
        if (c === range.s.c) {
          if (!isUrl(text)) name = text;
          if (link) photo = link;
        } else if (!photo) {
          photo = link || (isUrl(text) ? text : '');
        }
      }
      if (name) rows.push({ name, photo });
    }
    if (rows.length && HEADER_WORDS.includes(rows[0].name.toLowerCase())) rows.shift();
    return rows;
  }

  async function handleFile(file) {
    if (!file) return;
    try {
      if (!state.currentListId) throw new Error('أنشئ قائمة أولاً');
      const rows = await readExcel(file);
      const plan = planImport(rows, state.currentListId);
      state.pendingImport = plan;
      const withPhoto = plan.fresh.filter((x) => x.photo).length;
      const lines = [
        `في الملف <b>${rows.length}</b> اسم. القائمة: «${esc(listName(plan.listId))}».`,
        `جديد: <b>${plan.fresh.length}</b>${withPhoto ? ` (منها ${withPhoto} بصورة 📷)` : ''}.`,
      ];
      if (plan.photoUpdates.length) lines.push(`أسماء موجودة ستُضاف أو تُحدَّث صورها: <b>${plan.photoUpdates.length}</b>.`);
      if (plan.dup) lines.push(`مكرر أو موجود مسبقاً (يُتجاهل): <b>${plan.dup}</b>.`);
      if (rows.length && !rows.some((x) => x.photo)) lines.push('<span class="muted">لم يُعثر على روابط صور في الملف.</span>');
      $('#import-summary').innerHTML = lines.join('<br>');
      const preview = [
        ...plan.fresh.map((x) => `<li>${esc(x.name)}${x.photo ? ' 📷' : ''}</li>`),
        ...plan.photoUpdates.map((x) => `<li>${esc(x.name)} 📷 <span class="muted">(صورة)</span></li>`),
      ];
      $('#import-names').innerHTML = preview.slice(0, 200).join('') +
        (preview.length > 200 ? `<li class="muted">... و${preview.length - 200} آخرون</li>` : '');
      $('#import-confirm').disabled = !preview.length;
      show($('#import-preview'));
    } catch (err) {
      fail(err);
    } finally {
      $('#excel-input').value = '';
    }
  }

  $('#excel-input').addEventListener('change', (e) => handleFile(e.target.files[0]));
  const drop = $('#file-drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
  drop.addEventListener('drop', (e) => { e.preventDefault(); handleFile(e.dataTransfer.files[0]); });

  $('#import-cancel').addEventListener('click', () => { state.pendingImport = null; show($('#import-preview'), false); });
  $('#import-confirm').addEventListener('click', async (e) => {
    if (!state.pendingImport) return;
    e.target.disabled = true;
    const ok = await savePlan(state.pendingImport);
    e.target.disabled = false;
    if (ok) { state.pendingImport = null; show($('#import-preview'), false); }
  });

  // =====================================================================
  //  الاجتماعات (تعمل بدون إنترنت)
  // =====================================================================
  const openMeetingObj = () => state.meetings.find((m) => m.id === state.openId) || null;
  const isPending = (id) => outbox.some((o) => opMeeting(o) === id);

  function meetingCard(m) {
    const c = countsOf(m);
    const lists = m.list_ids.length ? meetingLists(m).map((l) => l.name).join('، ') : 'كل القوائم';
    return `
      <div class="card meeting-card" data-id="${m.id}" role="button" tabindex="0">
        <div class="meeting-card-actions">
          <button class="icon-btn" data-edit-meeting="${m.id}" title="تعديل الاجتماع">✎</button>
          <button class="icon-btn del" data-del-meeting="${m.id}" title="حذف الاجتماع">✕</button>
        </div>
        <h3>${esc(m.name)}</h3>
        <p class="muted">${esc(fmtDateTime(m.meeting_date))}</p>
        ${m.location ? `<p class="muted">📍 ${esc(m.location)}</p>` : ''}
        <p class="muted small-inline">📋 ${esc(lists)}</p>
        <div class="meeting-card-foot">
          <span class="badge present">✓ حاضر ${c.present}</span>
          ${c.late ? `<span class="badge late">⏰ متأخر ${c.late}</span>` : ''}
          <span class="badge absent">غائب ${c.absent}</span>
          <span class="badge">الملاحظات ${m.notes.length}</span>
          ${isPending(m.id) ? '<span class="badge pending">⏳ بانتظار الرفع</span>' : ''}
        </div>
      </div>`;
  }

  // ---------- العرض: تقويم شهري أو قائمة ----------
  const cal = (() => {
    const now = new Date();
    return {
      mode: localStorage.getItem('meetings-view') || 'calendar',
      y: now.getFullYear(),
      m: now.getMonth(),
      day: dayKey(now), // اليوم المختار
    };
  })();

  function renderMeetings() {
    $$('#view-toggle button').forEach((b) => b.classList.toggle('active', b.dataset.mode === cal.mode));
    show($('#calendar-wrap'), cal.mode === 'calendar');
    show($('#meetings-list'), cal.mode === 'list');
    if (cal.mode === 'calendar') return renderCalendar();
    const el = $('#meetings-list');
    el.innerHTML = state.meetings.length
      ? state.meetings.map(meetingCard).join('')
      : `<div class="card empty">لا توجد اجتماعات بعد. اضغط «بدء اجتماع جديد».</div>`;
  }

  function meetingsByDay() {
    const map = new Map();
    for (const m of state.meetings) {
      const k = dayKey(new Date(m.meeting_date));
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(m);
    }
    for (const list of map.values()) list.sort((a, b) => new Date(a.meeting_date) - new Date(b.meeting_date));
    return map;
  }

  function renderCalendar() {
    const first = new Date(cal.y, cal.m, 1);
    const last = new Date(cal.y, cal.m + 1, 0);
    const offset = (first.getDay() + 1) % 7; // الأسبوع يبدأ يوم السبت
    const byDay = meetingsByDay();
    const today = dayKey(new Date());

    $('#cal-title').textContent = gregMonth.format(first);
    const h1 = hijriMonth.format(first);
    const h2 = hijriMonthYear.format(last);
    $('#cal-hijri').textContent = h2.startsWith(h1) ? h2 : `${h1} – ${h2}`;

    let html = '';
    for (let i = 0; i < offset; i++) html += '<span class="cal-day blank"></span>';
    for (let d = 1; d <= last.getDate(); d++) {
      const date = new Date(cal.y, cal.m, d);
      const k = dayKey(date);
      const items = byDay.get(k) || [];
      const hDay = hijriDay.format(date);
      const hLabel = hijriDayNum(date) === 1 ? `${hDay} ${hijriMonthShort.format(date)}` : hDay;
      html += `
        <button type="button" class="cal-day ${k === today ? 'today' : ''} ${k === cal.day ? 'selected' : ''} ${items.length ? 'has' : ''}" data-day="${k}">
          <span class="cal-num"><b>${d.toLocaleString('ar')}</b><small>${esc(hLabel)}</small></span>
          <span class="cal-events">
            ${items.slice(0, 3).map((m) => `<span class="cal-ev" data-open="${m.id}" title="${esc(m.name)}">${esc(fmtTime(m.meeting_date))} ${esc(m.name)}</span>`).join('')}
            ${items.length > 3 ? `<span class="cal-more">+${(items.length - 3).toLocaleString('ar')}</span>` : ''}
          </span>
          ${items.length ? `<span class="cal-dot">${items.length.toLocaleString('ar')}</span>` : ''}
        </button>`;
    }
    const tail = (7 - ((offset + last.getDate()) % 7)) % 7;
    for (let i = 0; i < tail; i++) html += '<span class="cal-day blank"></span>';
    $('#cal-days').innerHTML = html;
    renderDayPanel(byDay);
  }

  function renderDayPanel(byDay = meetingsByDay()) {
    const [y, mo, d] = cal.day.split('-').map(Number);
    const date = new Date(y, mo - 1, d);
    $('#day-title').textContent = gregFull.format(date);
    $('#day-hijri').textContent = hijriFull.format(date);
    const items = byDay.get(cal.day) || [];
    $('#day-meetings').innerHTML = items.length
      ? items.map(meetingCard).join('')
      : `<div class="card empty">لا توجد اجتماعات في هذا اليوم.</div>`;
  }

  function goMonth(delta) {
    const d = new Date(cal.y, cal.m + delta, 1);
    cal.y = d.getFullYear();
    cal.m = d.getMonth();
    renderCalendar();
  }
  $('#cal-prev').addEventListener('click', () => goMonth(-1));
  $('#cal-next').addEventListener('click', () => goMonth(1));
  $('#cal-today').addEventListener('click', () => {
    const now = new Date();
    cal.y = now.getFullYear();
    cal.m = now.getMonth();
    cal.day = dayKey(now);
    renderCalendar();
  });
  $('#cal-days').addEventListener('click', (e) => {
    const ev = e.target.closest('[data-open]');
    if (ev) return openMeeting(ev.dataset.open);
    const day = e.target.closest('[data-day]');
    if (!day) return;
    cal.day = day.dataset.day;
    renderCalendar();
    if (window.matchMedia('(max-width: 900px)').matches) $('.day-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('#view-toggle').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    cal.mode = b.dataset.mode;
    localStorage.setItem('meetings-view', cal.mode);
    renderMeetings();
  });
  $('#day-new-btn').addEventListener('click', () => openMeetingDialog(null, cal.day));

  function deleteMeeting(m) {
    if (!confirm(`حذف اجتماع «${m.name}» مع سجل الحضور والملاحظات؟\nلا يمكن التراجع عن الحذف.`)) return false;
    enqueue({ t: 'mdelete', id: m.id });
    toast('تم حذف الاجتماع');
    return true;
  }

  // بطاقات الاجتماعات (في القائمة وتحت التقويم)
  for (const sel of ['#meetings-list', '#day-meetings']) {
    $(sel).addEventListener('click', (e) => {
      const editId = e.target.dataset.editMeeting;
      const delId = e.target.dataset.delMeeting;
      if (editId) return openMeetingDialog(state.meetings.find((m) => m.id === editId));
      if (delId) return deleteMeeting(state.meetings.find((m) => m.id === delId));
      const card = e.target.closest('.meeting-card');
      if (card) openMeeting(card.dataset.id);
    });
    $(sel).addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('meeting-card')) {
        e.preventDefault();
        openMeeting(e.target.dataset.id);
      }
    });
  }

  // التاريخ الهجري المقابل للتاريخ المختار في نافذة الاجتماع
  // اليوم الذي يقع فيه الاجتماع: اسم اليوم بارزاً، ثم التاريخان والوقت
  const updateDateHijri = () => {
    const v = $('#meeting-form').meeting_date.value;
    const el = $('#date-hijri');
    const d = v ? new Date(v) : null;
    if (!d || isNaN(d)) { el.innerHTML = ''; show(el, false); return; }
    const gDate = new Intl.DateTimeFormat('ar', { day: 'numeric', month: 'long', year: 'numeric' }).format(d);
    const rel = (() => {
      const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(new Date().toDateString())) / 86400000);
      const n = Math.abs(diff);
      const days = n === 2 ? 'يومين' : n <= 10 ? `${n} أيام` : `${n} يوماً`;
      return diff === 0 ? 'اليوم' : diff === 1 ? 'غداً' : diff === -1 ? 'أمس' : diff > 0 ? `بعد ${days}` : `قبل ${days}`;
    })();
    el.innerHTML = `
      <span class="dp-icon">📅</span>
      <span class="dp-text">
        <b>${esc(gregWeekday.format(d))}</b> <span class="dp-rel">${esc(rel)}</span><br>
        ${esc(gDate)} · ${esc(hijriFull.format(d))} · ${esc(timeFmt.format(d))}
      </span>`;
    show(el, true);
  };
  ['input', 'change'].forEach((ev) => $('#meeting-form').meeting_date.addEventListener(ev, updateDateHijri));

  let editingMeetingId = null;
  // presetDay: «2026-11-26» عند إنشاء اجتماع من يوم في التقويم
  function openMeetingDialog(meeting = null, presetDay = null) {
    editingMeetingId = meeting?.id || null;
    const f = $('#meeting-form');
    f.reset();
    $('#meeting-dialog-title').textContent = meeting ? 'تعديل الاجتماع' : 'اجتماع جديد';
    f.title.value = meeting?.name || '';
    if (meeting) f.meeting_date.value = toLocalInput(meeting.meeting_date);
    else if (presetDay && presetDay !== dayKey(new Date())) f.meeting_date.value = `${presetDay}T10:00`;
    else f.meeting_date.value = toLocalInput();
    updateDateHijri();
    f.location.value = meeting?.location || '';
    const chosen = meeting?.list_ids?.length ? meeting.list_ids : state.lists.map((l) => l.id);
    $('#meeting-lists').innerHTML = state.lists.length
      ? state.lists.map((l) => `
          <label class="check">
            <input type="checkbox" name="list" value="${l.id}" ${chosen.includes(l.id) ? 'checked' : ''}>
            <span>${esc(l.name)} <span class="muted">(${membersOf(l.id).length} اسم)</span></span>
          </label>`).join('')
      : `<p class="muted">لا توجد قوائم بعد. أنشئها من تبويب «الأسماء».</p>`;
    $('#meeting-dialog').showModal();
  }
  $('#new-meeting-btn').addEventListener('click', () => openMeetingDialog());
  $('#edit-meeting-btn').addEventListener('click', () => openMeetingDialog(openMeetingObj()));

  $('#meeting-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const listIds = $$('input[name="list"]:checked', f).map((c) => c.value);
    if (state.lists.length && !listIds.length) return toast('اختر قائمة واحدة على الأقل', 'err');
    const fields = {
      name: f.title.value.trim(),
      meeting_date: new Date(f.meeting_date.value).toISOString(),
      location: f.location.value.trim() || null,
      list_ids: listIds,
    };
    $('#meeting-dialog').close();
    if (editingMeetingId) {
      enqueue({ t: 'mupdate', id: editingMeetingId, patch: fields });
      toast('تم تحديث الاجتماع');
    } else {
      const id = uuid();
      enqueue({ t: 'mcreate', row: { id, ...fields } });
      openMeeting(id);
    }
  });

  $('#delete-meeting-btn').addEventListener('click', () => {
    const m = openMeetingObj();
    if (m && deleteMeeting(m)) closeMeeting();
  });

  function closeMeeting() {
    state.openId = null;
    hideUndo();
    if (listening) stopMic();
    renderMeetings();
    showView('meetings');
  }
  $('#back-btn').addEventListener('click', () => { closeMeeting(); refreshMeetingsSoon(); });
  $('#print-btn').addEventListener('click', () => window.print());

  function openMeeting(id) {
    state.openId = id;
    state.attSearch = '';
    state.attList = 'all';
    $('#att-search').value = '';
    renderMeetingView();
    showView('meeting');
    window.scrollTo(0, 0);
    refreshMeetingsSoon();
  }

  function renderMeetingView() {
    const m = openMeetingObj();
    if (!m) { closeMeeting(); return; }
    $('#m-title').textContent = m.name;
    const lists = meetingLists(m).map((l) => l.name).join('، ');
    $('#m-meta').textContent = [fmtDateTime(m.meeting_date), m.location, lists && `📋 ${lists}`].filter(Boolean).join(' · ');
    renderAttendance(m);
    renderNotes(m);
  }

  // ---------- التفقّد ----------
  function renderStats(m) {
    const c = countsOf(m);
    const rate = c.total ? Math.round(((c.present + c.late) / c.total) * 100) : 0;
    $('#m-stats').innerHTML = `
      <div class="stat present"><b>${c.present}</b><span>حاضر</span></div>
      <div class="stat late"><b>${c.late}</b><span>متأخر</span></div>
      <div class="stat absent"><b>${c.absent}</b><span>غائب</span></div>
      <div class="stat"><b>${c.total}</b><span>المجموع</span></div>
      <div class="stat"><b>${rate}%</b><span>نسبة الحضور</span></div>`;
  }

  function renderListFilter(m) {
    const lists = meetingLists(m);
    const el = $('#att-list-filter');
    if (lists.length < 2) { el.innerHTML = ''; state.attList = 'all'; return; }
    if (state.attList !== 'all' && !lists.some((l) => l.id === state.attList)) state.attList = 'all';
    el.innerHTML = `<button class="chip list ${state.attList === 'all' ? 'active' : ''}" data-att-list="all">كل القوائم</button>` +
      lists.map((l) => `<button class="chip list ${state.attList === l.id ? 'active' : ''}" data-att-list="${l.id}">${esc(l.name)}</button>`).join('');
  }

  function renderAttendance(m) {
    renderStats(m);
    renderListFilter(m);
    renderLock(m);
    const el = $('#att-list');
    if (!rosterOf(m).length) {
      el.innerHTML = `<li class="empty">لا توجد أسماء في قوائم هذا الاجتماع. أضفها من تبويب «الأسماء»، أو غيّر القوائم من «تعديل».</li>`;
      return;
    }
    const q = state.attSearch.trim();
    const listIds = new Set(meetingLists(m).filter((l) => state.attList === 'all' || l.id === state.attList).map((l) => l.id));
    const multi = meetingLists(m).length > 1;
    const people = state.members.filter((x) => listIds.has(x.list_id) && (!q || x.full_name.includes(q)));

    // ثلاثة أقسام: كل ضغطة تنقل الاسم من قسم إلى آخر
    const SECTIONS = [
      { key: null, cls: 'pending', title: '⏳ لم يُسجَّل بعد', empty: '🎉 تم تفقّد الجميع' },
      { key: 'present', cls: 'present', title: '✓ الحاضرون', empty: 'لا أحد بعد' },
      { key: 'late', cls: 'late', title: '⏰ المتأخرون', empty: 'لا أحد' },
    ];
    let html = '';
    for (const sec of SECTIONS) {
      const items = sortPeople(people.filter((x) => statusOf(m, x.id) === sec.key), m);
      const id = sec.key || 'pending';
      const closed = !!state.collapsed[id];
      html += `
        <li class="sec-head ${sec.cls}">
          <button type="button" data-sec="${id}" aria-expanded="${!closed}">
            <span>${sec.title}</span><span class="sec-count">${items.length}</span><span class="sec-arrow">${closed ? '◂' : '▾'}</span>
          </button>
        </li>`;
      if (closed) continue;
      if (!items.length) {
        html += `<li class="sec-empty">${q ? 'لا نتائج' : sec.empty}</li>`;
        continue;
      }
      html += items.map((x) => {
        const s = sec.key;
        const at = m.present[x.id] || m.late[x.id];
        return `
          <li class="att-row">
            <button type="button" class="att-item ${s || ''}" data-member="${x.id}"
              title="${s === 'present' ? 'اضغط لتسجيله متأخراً' : s === 'late' ? 'اضغط لإعادته إلى «لم يُسجَّل»' : 'اضغط لتسجيله حاضراً'}">
              <span class="tick" aria-hidden="true">${s === 'late' ? '⏰' : '✓'}</span>
              ${avatar(x)}
              <span class="name">${esc(x.full_name)}${multi ? `<small class="list-tag">${esc(listName(x.list_id))}</small>` : ''}</span>
              ${s ? `<small class="when">${esc(fmtTime(at))}</small>` : '<small class="when print-only">غائب</small>'}
            </button>
          </li>`;
      }).join('');
    }
    el.innerHTML = html;
  }

  // ---------- الفرز ----------
  const collator = new Intl.Collator('ar', { sensitivity: 'base', numeric: true });
  const SORTS = {
    name: (a, b) => collator.compare(a.full_name, b.full_name),
    'name-desc': (a, b) => collator.compare(b.full_name, a.full_name),
    list: (a, b) => collator.compare(listName(a.list_id), listName(b.list_id)) || collator.compare(a.full_name, b.full_name),
  };
  function sortPeople(arr, m) {
    if (state.attSort === 'time') {
      const t = (x) => m.present[x.id] || m.late[x.id] || '';
      return arr.sort((a, b) => (t(a) < t(b) ? -1 : t(a) > t(b) ? 1 : SORTS.name(a, b)));
    }
    return arr.sort(SORTS[state.attSort] || SORTS.name);
  }
  $('#att-sort').value = state.attSort;
  $('#att-sort').addEventListener('change', (e) => {
    state.attSort = e.target.value;
    localStorage.setItem('att-sort', state.attSort);
    renderMeetingView();
  });

  $('#att-search').addEventListener('input', (e) => { state.attSearch = e.target.value; renderMeetingView(); });
  $('#att-list-filter').addEventListener('click', (e) => {
    const c = e.target.closest('[data-att-list]');
    if (!c) return;
    state.attList = c.dataset.attList;
    renderMeetingView();
  });

  // ---------- الحماية من الخطأ: القفل والتراجع ----------
  // القفل محفوظ على الجهاز لكل اجتماع؛ الاجتماعات السابقة (قبل اليوم) مقفلة افتراضياً
  const LOCKS_KEY = 'att-locks';
  const locks = (() => { try { return JSON.parse(localStorage.getItem(LOCKS_KEY) || '{}'); } catch (_) { return {}; } })();
  const isLocked = (m) => (m.id in locks ? locks[m.id]
    : dayKey(new Date(m.meeting_date)) < dayKey(new Date()));
  function setLocked(m, on) {
    locks[m.id] = on;
    localStorage.setItem(LOCKS_KEY, JSON.stringify(locks));
    renderMeetingView();
  }
  function renderLock(m) {
    const on = isLocked(m);
    const b = $('#lock-btn');
    b.textContent = on ? '🔒 مقفل' : '🔓 قفل التفقّد';
    b.title = on ? 'التفقّد مقفل: اضغط لفتحه والتعديل' : 'اقفل التفقّد بعد الانتهاء حتى لا يتغير اسم بالخطأ';
    b.classList.toggle('on', on);
    $('#att-list').classList.toggle('locked', on);
  }
  $('#lock-btn').addEventListener('click', () => {
    const m = openMeetingObj();
    if (!m) return;
    if (isLocked(m)) {
      if (!confirm('فتح التفقّد للتعديل؟')) return;
      setLocked(m, false);
      toast('🔓 التفقّد مفتوح للتعديل');
    } else {
      setLocked(m, true);
      hideUndo();
      toast('🔒 تم قفل التفقّد');
    }
  });

  const STATUS_LABEL = { present: '✓ حاضر', late: '⏰ متأخر' };
  let undoTimer;
  let undoOp = null;
  function showUndo(text, op) {
    undoOp = op;
    $('#undo-text').textContent = text;
    $('#undo-bar').classList.add('show');
    clearTimeout(undoTimer);
    undoTimer = setTimeout(hideUndo, 6000);
  }
  function hideUndo() {
    clearTimeout(undoTimer);
    undoOp = null;
    $('#undo-bar').classList.remove('show');
  }
  $('#undo-btn').addEventListener('click', () => {
    if (!undoOp) return;
    enqueue(undoOp);
    const who = state.members.find((x) => x.id === undoOp.member)?.full_name || '';
    hideUndo();
    toast(`↩ أُعيد «${who}» كما كان`);
  });

  $('#att-list').addEventListener('click', (e) => {
    const sec = e.target.closest('[data-sec]');
    if (sec) {
      state.collapsed[sec.dataset.sec] = !state.collapsed[sec.dataset.sec];
      localStorage.setItem('att-collapsed', JSON.stringify(state.collapsed));
      return renderMeetingView();
    }
    const b = e.target.closest('.att-item[data-member]');
    if (!b) return;
    const m = openMeetingObj();
    if (!m) return;
    if (isLocked(m)) return toast('🔒 التفقّد مقفل. اضغط «مقفل» أعلى القائمة لفتحه.', 'err');
    const id = b.dataset.member;
    // الضغط المتكرر: بلا علامة ← حاضر ← متأخر ← بلا علامة
    const cur = statusOf(m, id);
    const curAt = m.present[id] || m.late[id] || null;
    const next = cur === null ? 'present' : cur === 'present' ? 'late' : null;
    enqueue({ t: 'status', m: m.id, member: id, s: next, at: new Date().toISOString() });
    // التراجع يعيد الحالة السابقة بوقتها الأصلي
    const who = state.members.find((x) => x.id === id)?.full_name || '';
    showUndo(`${who}: ${next ? STATUS_LABEL[next] : 'أُلغيت العلامة (غائب)'}`,
      { t: 'status', m: m.id, member: id, s: cur, at: curAt || new Date().toISOString() });
  });

  // ---------- الملاحظات ----------
  function renderNotes(m) {
    const el = $('#notes-list');
    const total = m.notes.reduce((n, x) => n + countWords(x.content), 0);
    $('#notes-words').textContent = m.notes.length ? `${m.notes.length} ملاحظة · ${wordsLabel(total)}` : '';
    if (!m.notes.length) { el.innerHTML = `<li class="empty">لا توجد ملاحظات بعد.</li>`; return; }
    el.innerHTML = m.notes.map((n) => `
      <li class="note-item">
        <p class="note-content">${esc(n.content)}</p>
        <div class="note-foot">
          <small class="muted">${esc(fmtTime(n.created_at))} · ${wordsLabel(countWords(n.content))}</small>
          <button class="icon-btn del no-print" data-del-note="${n.id}" title="حذف">✕</button>
        </div>
      </li>`).join('');
  }

  const noteForm = $('#note-form');
  const updateWordCount = () => { $('#word-count').textContent = wordsLabel(countWords(noteForm.content.value)); };
  noteForm.content.addEventListener('input', updateWordCount);

  noteForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const m = openMeetingObj();
    const content = noteForm.content.value.trim();
    if (!m || !content) return;
    enqueue({ t: 'note+', m: m.id, note: { id: uuid(), content, created_at: new Date().toISOString() } });
    noteForm.content.value = '';
    updateWordCount();
    noteForm.content.focus();
  });
  noteForm.content.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) noteForm.requestSubmit();
  });

  $('#notes-list').addEventListener('click', (e) => {
    const id = e.target.dataset.delNote;
    const m = openMeetingObj();
    if (!id || !m || !confirm('حذف هذه الملاحظة؟')) return;
    enqueue({ t: 'note-', m: m.id, id });
  });

  // ---------- إعادة الصياغة بـ ChatGPT ----------
  // تجهيز نص كامل (بيانات الاجتماع + الحضور + الملاحظات + التعليمات)، ونسخه وفتح ChatGPT.
  const AI_STYLES = {
    minutes: 'محضر اجتماع رسمي منظّم بالأقسام التالية: بيانات الاجتماع (العنوان، التاريخ، المكان)، الحضور، النقاط التي نوقشت، القرارات، المهام المطلوبة والمسؤول عنها وموعدها إن ذُكرت.',
    summary: 'ملخص مختصر وواضح على شكل نقاط مرتبة حسب الأهمية، يبدأ بسطر واحد عن الاجتماع، ثم أهم النقاط والقرارات والمهام.',
    report: 'تقرير رسمي موجّه إلى الإدارة، بمقدمة قصيرة، ثم عرض منظّم لما دار في الاجتماع، ثم القرارات والتوصيات والمهام، ثم خاتمة موجزة.',
  };

  function buildAiPrompt(m) {
    const withNames = $('#ai-names').checked;
    const style = AI_STYLES[$('#ai-style').value] || AI_STYLES.minutes;
    const roster = rosterOf(m);
    const c = countsOf(m, roster);
    const names = (s) => roster.filter((x) => statusOf(m, x.id) === s).map((x) => x.full_name).join('، ') || '—';
    const lists = meetingLists(m).map((l) => l.name).join('، ');
    const draft = noteForm.content.value.trim();
    const notes = m.notes.map((n, i) => `${i + 1}. (${fmtTime(n.created_at)}) ${n.content}`);
    if (draft) notes.push(`${notes.length + 1}. (لم تُحفظ بعد) ${draft}`);

    const lines = [
      'أنت كاتب محاضر اجتماعات محترف. أعد صياغة ملاحظات الاجتماع التالية باللغة العربية الفصحى الرسمية.',
      `الشكل المطلوب: ${style}`,
      '',
      'التزم بدقة بما يلي:',
      '- لا تحذف أي معلومة أو اسم أو رقم أو تاريخ أو قرار ورد في الملاحظات، مهما بدا صغيراً.',
      '- لا تضف أي معلومة غير موجودة، ولا تستنتج ما لم يُذكر.',
      '- الملاحظات مكتوبة بلهجة محلية أو منقولة من الكلام: حوّلها إلى فصحى سليمة مع الحفاظ على المعنى تماماً.',
      '- صحّح الأخطاء الإملائية والنحوية، ورتّب الأفكار المتكررة أو المتفرقة دون إسقاط شيء منها.',
      '- إن كانت عبارة غير واضحة فاكتبها كما هي واكتب بجانبها [غير واضح].',
      '',
      '=== بيانات الاجتماع ===',
      `العنوان: ${m.name}`,
      `التاريخ: ${fmtDateTime(m.meeting_date)}`,
    ];
    if (m.location) lines.push(`المكان: ${m.location}`);
    if (lists) lines.push(`القوائم المشاركة: ${lists}`);
    lines.push(`الحضور: ${c.present} حاضر، ${c.late} متأخر، ${c.absent} غائب، من أصل ${c.total}.`);
    if (withNames) {
      lines.push(`الحاضرون: ${names('present')}`);
      if (c.late) lines.push(`المتأخرون: ${names('late')}`);
      lines.push(`الغائبون: ${roster.filter((x) => !statusOf(m, x.id)).map((x) => x.full_name).join('، ') || '—'}`);
    }
    lines.push('', '=== ملاحظات الاجتماع ===', notes.length ? notes.join('\n') : '(لا توجد ملاحظات)');
    return lines.join('\n');
  }

  function refreshAiText() {
    const m = openMeetingObj();
    if (!m) return;
    const t = buildAiPrompt(m);
    $('#ai-text').value = t;
    $('#ai-count').textContent = `${wordsLabel(countWords(t))} · ${t.length.toLocaleString('ar')} حرف`;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      const ta = $('#ai-text');
      ta.focus();
      ta.select();
      try { return document.execCommand('copy'); } catch (__) { return false; }
    }
  }

  $('#ai-btn').addEventListener('click', () => {
    const m = openMeetingObj();
    if (!m) return;
    if (!m.notes.length && !noteForm.content.value.trim()) return toast('اكتب ملاحظات الاجتماع أولاً', 'err');
    refreshAiText();
    $('#ai-dialog').showModal();
  });
  $('#ai-names').addEventListener('change', refreshAiText);
  $('#ai-style').addEventListener('change', refreshAiText);
  $('#ai-text').addEventListener('input', () => {
    const t = $('#ai-text').value;
    $('#ai-count').textContent = `${wordsLabel(countWords(t))} · ${t.length.toLocaleString('ar')} حرف`;
  });

  $('#ai-copy').addEventListener('click', async () => {
    toast(await copyText($('#ai-text').value) ? 'تم النسخ ✓ الصقه في ChatGPT' : 'تعذّر النسخ: حدّد النص وانسخه يدوياً', 'ok');
  });

  $('#ai-open').addEventListener('click', async () => {
    const text = $('#ai-text').value.trim();
    if (!text) return;
    const copied = await copyText(text);
    // النص القصير يُمرَّر في الرابط فيظهر في ChatGPT مباشرة؛ الطويل يُلصق يدوياً
    const url = text.length <= 3500 ? `https://chatgpt.com/?q=${encodeURIComponent(text)}` : 'https://chatgpt.com/';
    window.open(url, '_blank', 'noopener');
    toast(copied ? 'تم نسخ النص ✓ إن لم يظهر في ChatGPT الصقه بـ Ctrl + V' : 'افتح ChatGPT والصق النص يدوياً', 'ok');
  });

  // ---------- تحويل الكلام إلى نص (التعرف على الكلام في المتصفح) ----------
  // النص المحوَّل يُضاف دائماً إلى آخر الملاحظة ولا يستبدل شيئاً مما كُتب.
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const isAndroid = /Android/i.test(navigator.userAgent);
  const micBtn = $('#mic-btn');
  const micLang = $('#mic-lang');
  let rec = null;
  let listening = false;
  let interimText = '';

  micLang.value = localStorage.getItem('mic-lang') || 'ar-SY';
  micLang.addEventListener('change', () => {
    localStorage.setItem('mic-lang', micLang.value);
    if (listening) { stopMic(); setTimeout(startMic, 300); }
  });

  function micStatus(text, type = '') {
    const el = $('#mic-status');
    el.textContent = text;
    el.className = `mic-status ${type}`;
    show(el, !!text);
  }
  function setInterim(t) {
    interimText = t;
    $('#mic-interim').textContent = t;
    show($('#mic-interim'), !!t);
  }
  function appendSpeech(t) {
    t = t.trim();
    if (!t) return;
    const ta = noteForm.content;
    const cur = ta.value;
    ta.value = cur + (cur && !/\s$/.test(cur) ? ' ' : '') + t;
    ta.scrollTop = ta.scrollHeight;
    updateWordCount();
  }

  function startMic() {
    if (!navigator.onLine) {
      micStatus('تحويل الكلام يحتاج اتصالاً بالإنترنت. يمكنك الكتابة يدوياً الآن.', 'err');
      return;
    }
    const r = new SR();
    rec = r;
    r.lang = micLang.value;
    r.interimResults = true;
    r.maxAlternatives = 1;
    // على أندرويد الوضع المستمر يكرر الكلام، فنستمع لكل جملة ونعيد التشغيل تلقائياً
    r.continuous = !isAndroid;

    r.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) appendSpeech(res[0].transcript); // حتى من مُستمِع قديم: لا نُضيّع كلاماً
        else interim += res[0].transcript;
      }
      if (rec === r) setInterim(interim);
    };
    r.onerror = (e) => {
      if (rec !== r) return;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        listening = false;
        micStatus('لم يُسمح باستخدام الميكروفون. اسمح به من إعدادات المتصفح (رمز القفل بجانب الرابط) ثم أعد المحاولة.', 'err');
      } else if (e.error === 'network') {
        listening = false;
        micStatus('تحويل الكلام يحتاج اتصالاً بالإنترنت.', 'err');
      } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
        console.warn('speech error:', e.error);
      }
    };
    r.onend = () => {
      if (rec !== r) return; // مُستمِع قديم (بعد تغيير اللهجة): لا يعيد التشغيل
      if (interimText) { appendSpeech(interimText); setInterim(''); } // لا نُضيّع آخر كلام
      if (listening) {
        try { r.start(); return; } catch (_) { /* يُعاد التشغيل أدناه */ }
        setTimeout(() => { if (listening) startMic(); }, 250);
        return;
      }
      updateMicUI();
    };

    listening = true;
    try { r.start(); } catch (err) { listening = false; fail(err); }
    updateMicUI();
  }

  function stopMic() {
    listening = false;
    if (rec) { try { rec.stop(); } catch (_) {} }
    updateMicUI();
  }

  function updateMicUI() {
    micBtn.classList.toggle('recording', listening);
    micBtn.textContent = listening ? '⏹ إيقاف التسجيل' : '🎤 تحويل الكلام إلى نص';
    if (listening) micStatus('🔴 أستمع الآن... تكلّم بوضوح وقرب الجهاز. يُضاف الكلام إلى آخر النص.', 'on');
    else if (!$('#mic-status').classList.contains('err')) micStatus('');
  }

  if (!SR) {
    micBtn.disabled = true;
    micLang.disabled = true;
    micStatus('تحويل الكلام غير مدعوم في هذا المتصفح. استخدم Google Chrome أو Microsoft Edge.', 'err');
  } else {
    micBtn.addEventListener('click', () => (listening ? stopMic() : (micStatus(''), startMic())));
  }
  $$('.tab').forEach((t) => t.addEventListener('click', () => { if (listening) stopMic(); }));

  // ---------- النوافذ ----------
  $$('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

  updateSyncUI();
})();
