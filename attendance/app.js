(() => {
  'use strict';

  // ---------- أدوات مساعدة ----------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const show = (el, on = true) => el.classList.toggle('hidden', !on);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cleanName = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const nameKey = (s) => cleanName(s).toLowerCase();
  const fmtDateTime = (iso) => new Date(iso).toLocaleString('ar', { dateStyle: 'full', timeStyle: 'short' });
  const fmtTime = (iso) => new Date(iso).toLocaleTimeString('ar', { timeStyle: 'short' });
  const toLocalInput = (iso) => {
    const d = iso ? new Date(iso) : new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  };

  let toastTimer;
  function toast(msg, type = 'ok') {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `toast show ${type}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = 'toast'), 3000);
  }
  function fail(error) {
    console.error(error);
    toast(error?.message || 'حدث خطأ غير متوقع', 'err');
  }

  // ---------- الإعداد ----------
  const cfg = window.APP_CONFIG || {};
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || cfg.SUPABASE_URL.includes('YOUR-PROJECT')) {
    show($('#config-screen'));
    return;
  }
  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

  // كل البيانات في جدول واحد: سطر لكل اسم (kind = member) وسطر لكل اجتماع (kind = meeting)
  const TABLE = 'meeting_attendance';
  const tbl = () => sb.from(TABLE);
  const toMeeting = (r) => ({ ...r, title: r.name, present: r.present || {}, notes: r.notes || [] });

  const state = {
    members: [],
    meetings: [],
    meeting: null,
    present: new Map(), // member_id -> checked_at
    notes: [],
    attFilter: 'all',
    attSearch: '',
    membersSearch: '',
    pendingImport: [],
  };

  // ---------- المصادقة ----------
  let booted = false;
  sb.auth.onAuthStateChange((_event, session) => {
    setTimeout(() => handleSession(session), 0);
  });

  function handleSession(session) {
    if (session) {
      show($('#login-screen'), false);
      show($('#app'));
      $('#user-email').textContent = displayUser(session.user.email || '');
      if (!booted) { booted = true; boot(); }
    } else {
      booted = false;
      show($('#app'), false);
      show($('#login-screen'));
    }
  }

  // الدخول باسم مستخدم: «admin» يصبح admin@attendance.local (هكذا يُنشأ الحساب في Supabase)
  // ومن يكتب بريداً كاملاً يُستخدم كما هو
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
    btn.disabled = true;
    const { error } = await sb.auth.signInWithPassword({ email: toLoginEmail(f.email.value), password: f.password.value });
    btn.disabled = false;
    if (error) $('#login-error').textContent = 'بيانات الدخول غير صحيحة';
    else f.reset();
  });

  $('#logout-btn').addEventListener('click', () => sb.auth.signOut());

  async function boot() {
    await loadMembers(); // أولاً: عدّاد الحضور في بطاقات الاجتماعات يعتمد على قائمة الأسماء
    await loadMeetings();
    showView('meetings');
  }

  // ---------- التنقل ----------
  function showView(name) {
    ['meetings', 'members', 'meeting'].forEach((v) => show($(`#view-${v}`), v === name));
    $$('.tab').forEach((t) => t.classList.toggle('active',
      t.dataset.view === name || (name === 'meeting' && t.dataset.view === 'meetings')));
  }
  $$('.tab').forEach((t) => t.addEventListener('click', async () => {
    if (t.dataset.view === 'meetings') await loadMeetings();
    showView(t.dataset.view);
  }));

  // =====================================================================
  //  الأسماء
  // =====================================================================
  async function loadMembers() {
    // Supabase يعيد 1000 صف كحد أقصى في الطلب الواحد، فنجلب على دفعات
    const all = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await tbl().select('id, name').eq('kind', 'member')
        .order('name').range(from, from + 999);
      if (error) return fail(error);
      all.push(...data.map((r) => ({ id: r.id, full_name: r.name })));
      if (data.length < 1000) break;
    }
    state.members = all;
    renderMembers();
  }

  function renderMembers() {
    $('#members-count').textContent = `${state.members.length} اسم مسجّل`;
    const q = state.membersSearch.trim();
    const list = state.members.filter((m) => !q || m.full_name.includes(q));
    const el = $('#members-list');
    if (!state.members.length) {
      el.innerHTML = `<li class="empty">لا توجد أسماء بعد. استورد ملف Excel أو أضف الأسماء يدوياً.</li>`;
      return;
    }
    if (!list.length) { el.innerHTML = `<li class="empty">لا نتائج.</li>`; return; }
    el.innerHTML = list.map((m, i) => `
      <li>
        <span class="num">${i + 1}</span>
        <span class="name">${esc(m.full_name)}</span>
        <button class="icon-btn" data-edit="${m.id}" title="تعديل">✎</button>
        <button class="icon-btn del" data-del="${m.id}" title="حذف">✕</button>
      </li>`).join('');
  }

  $('#members-search').addEventListener('input', (e) => { state.membersSearch = e.target.value; renderMembers(); });

  $('#members-list').addEventListener('click', async (e) => {
    const editId = e.target.dataset.edit;
    const delId = e.target.dataset.del;
    if (editId) {
      const m = state.members.find((x) => x.id === editId);
      const name = cleanName(prompt('تعديل الاسم:', m.full_name));
      if (!name || name === m.full_name) return;
      const { error } = await tbl().update({ name }).eq('id', editId).eq('kind', 'member');
      if (error) return fail(error);
      toast('تم تعديل الاسم');
      loadMembers();
    }
    if (delId) {
      const m = state.members.find((x) => x.id === delId);
      if (!confirm(`حذف "${m.full_name}"؟\nلن يظهر بعدها في قوائم الحضور، ومنها الاجتماعات السابقة.`)) return;
      const { error } = await tbl().delete().eq('id', delId).eq('kind', 'member');
      if (error) return fail(error);
      toast('تم الحذف');
      loadMembers();
    }
  });

  // يحفظ قائمة أسماء مع تجاهل الفارغ والمكرر (داخل القائمة ومع الموجود مسبقاً)
  async function saveNames(names) {
    const existing = new Set(state.members.map((m) => nameKey(m.full_name)));
    const seen = new Set();
    const fresh = [];
    let dup = 0;
    for (const raw of names) {
      const n = cleanName(raw);
      if (!n) continue;
      const k = nameKey(n);
      if (existing.has(k) || seen.has(k)) { dup++; continue; }
      seen.add(k);
      fresh.push(n);
    }
    if (!fresh.length) {
      toast(dup ? 'كل الأسماء موجودة مسبقاً' : 'لا توجد أسماء', 'err');
      return false;
    }
    for (let i = 0; i < fresh.length; i += 500) {
      const chunk = fresh.slice(i, i + 500).map((name) => ({ kind: 'member', name }));
      const { error } = await tbl().insert(chunk);
      if (error) { fail(error); await loadMembers(); return false; }
    }
    toast(`تمت إضافة ${fresh.length} اسم${dup ? ` (وتجاهل ${dup} مكرر)` : ''}`);
    await loadMembers();
    return true;
  }

  // ---------- إضافة يدوية ----------
  $('#manual-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('button');
    btn.disabled = true;
    const ok = await saveNames(f.names.value.split(/\r?\n/));
    btn.disabled = false;
    if (ok) f.reset();
  });

  // ---------- استيراد Excel ----------
  const HEADER_WORDS = ['الاسم', 'اسم', 'الأسماء', 'الاسماء', 'الاسم الكامل', 'name', 'names', 'full name', 'fullname'];

  async function readExcel(file) {
    if (!window.XLSX) throw new Error('تعذّر تحميل مكتبة Excel، تحقق من اتصال الإنترنت');
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });
    const names = rows.map((r) => cleanName(r[0])).filter(Boolean);
    if (names.length && HEADER_WORDS.includes(names[0].toLowerCase())) names.shift();
    return names;
  }

  async function handleFile(file) {
    if (!file) return;
    try {
      const names = await readExcel(file);
      const existing = new Set(state.members.map((m) => nameKey(m.full_name)));
      const seen = new Set();
      state.pendingImport = names.filter((n) => {
        const k = nameKey(n);
        if (existing.has(k) || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      const skipped = names.length - state.pendingImport.length;
      $('#import-summary').innerHTML =
        `في الملف <b>${names.length}</b> اسم، منها <b>${state.pendingImport.length}</b> جديد` +
        (skipped ? ` و<b>${skipped}</b> مكرر أو موجود مسبقاً.` : '.');
      $('#import-names').innerHTML = state.pendingImport.slice(0, 200).map((n) => `<li>${esc(n)}</li>`).join('') +
        (state.pendingImport.length > 200 ? `<li class="muted">... و${state.pendingImport.length - 200} اسم آخر</li>` : '');
      $('#import-confirm').disabled = !state.pendingImport.length;
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

  $('#import-cancel').addEventListener('click', () => { state.pendingImport = []; show($('#import-preview'), false); });
  $('#import-confirm').addEventListener('click', async (e) => {
    e.target.disabled = true;
    const ok = await saveNames(state.pendingImport);
    e.target.disabled = false;
    if (ok) { state.pendingImport = []; show($('#import-preview'), false); }
  });

  // =====================================================================
  //  الاجتماعات
  // =====================================================================
  async function loadMeetings() {
    const { data, error } = await tbl()
      .select('id, name, meeting_date, location, present, notes')
      .eq('kind', 'meeting')
      .order('meeting_date', { ascending: false });
    if (error) return fail(error);
    state.meetings = data.map(toMeeting);
    renderMeetings();
  }

  function renderMeetings() {
    const el = $('#meetings-list');
    if (!state.meetings.length) {
      el.innerHTML = `<div class="card empty">لا توجد اجتماعات بعد. اضغط «بدء اجتماع جديد».</div>`;
      return;
    }
    const ids = new Set(state.members.map((x) => x.id));
    el.innerHTML = state.meetings.map((m) => `
      <button class="card meeting-card" data-id="${m.id}">
        <h3>${esc(m.title)}</h3>
        <p class="muted">${esc(fmtDateTime(m.meeting_date))}</p>
        ${m.location ? `<p class="muted">📍 ${esc(m.location)}</p>` : ''}
        <div class="meeting-card-foot">
          <span class="badge present">✓ حضر ${Object.keys(m.present).filter((id) => ids.has(id)).length}</span>
          <span class="badge">الملاحظات ${m.notes.length}</span>
        </div>
      </button>`).join('');
  }

  $('#meetings-list').addEventListener('click', (e) => {
    const card = e.target.closest('.meeting-card');
    if (card) openMeeting(card.dataset.id);
  });

  let editingMeetingId = null;
  function openMeetingDialog(meeting = null) {
    editingMeetingId = meeting?.id || null;
    const f = $('#meeting-form');
    f.reset();
    $('#meeting-dialog-title').textContent = meeting ? 'تعديل الاجتماع' : 'اجتماع جديد';
    f.title.value = meeting?.title || '';
    f.meeting_date.value = toLocalInput(meeting?.meeting_date);
    f.location.value = meeting?.location || '';
    $('#meeting-dialog').showModal();
  }
  $('#new-meeting-btn').addEventListener('click', () => openMeetingDialog());
  $('#edit-meeting-btn').addEventListener('click', () => openMeetingDialog(state.meeting));

  $('#meeting-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const row = {
      name: f.title.value.trim(),
      meeting_date: new Date(f.meeting_date.value).toISOString(),
      location: f.location.value.trim() || null,
    };
    const q = editingMeetingId
      ? tbl().update(row).eq('id', editingMeetingId).eq('kind', 'meeting')
      : tbl().insert({ ...row, kind: 'meeting' });
    const { data, error } = await q.select().single();
    if (error) return fail(error);
    $('#meeting-dialog').close();
    if (editingMeetingId) {
      state.meeting = toMeeting(data);
      renderMeetingHeader();
      toast('تم تحديث الاجتماع');
    } else {
      openMeeting(data.id);
    }
  });

  $('#delete-meeting-btn').addEventListener('click', async () => {
    if (!confirm(`حذف اجتماع "${state.meeting.title}" مع سجل الحضور والملاحظات؟`)) return;
    const { error } = await tbl().delete().eq('id', state.meeting.id).eq('kind', 'meeting');
    if (error) return fail(error);
    state.meeting = null;
    toast('تم حذف الاجتماع');
    await loadMeetings();
    showView('meetings');
  });

  $('#back-btn').addEventListener('click', async () => {
    state.meeting = null;
    await loadMeetings();
    showView('meetings');
  });

  $('#print-btn').addEventListener('click', () => window.print());

  async function openMeeting(id) {
    const { data, error } = await tbl().select('*').eq('id', id).eq('kind', 'meeting').single();
    if (error) return fail(error);
    state.meeting = toMeeting(data);
    state.present = new Map(Object.entries(state.meeting.present));
    state.notes = state.meeting.notes;
    state.attSearch = '';
    state.attFilter = 'all';
    $('#att-search').value = '';
    $$('#att-filters .chip').forEach((c) => c.classList.toggle('active', c.dataset.filter === 'all'));
    renderMeetingHeader();
    renderAttendance();
    renderNotes();
    showView('meeting');
    window.scrollTo(0, 0);
  }

  function renderMeetingHeader() {
    const m = state.meeting;
    $('#m-title').textContent = m.title;
    $('#m-meta').textContent = [fmtDateTime(m.meeting_date), m.location].filter(Boolean).join(' · ');
  }

  // ---------- التفقّد ----------
  function renderStats() {
    const total = state.members.length;
    const here = state.members.filter((m) => state.present.has(m.id)).length;
    const rate = total ? Math.round((here / total) * 100) : 0;
    $('#m-stats').innerHTML = `
      <div class="stat present"><b>${here}</b><span>حضر</span></div>
      <div class="stat absent"><b>${total - here}</b><span>لم يحضر</span></div>
      <div class="stat"><b>${total}</b><span>المجموع</span></div>
      <div class="stat"><b>${rate}%</b><span>نسبة الحضور</span></div>`;
  }

  function renderAttendance() {
    renderStats();
    const el = $('#att-list');
    if (!state.members.length) {
      el.innerHTML = `<li class="empty">لا توجد أسماء. أضفها من تبويب «الأسماء».</li>`;
      return;
    }
    const q = state.attSearch.trim();
    const list = state.members.filter((m) => {
      const isHere = state.present.has(m.id);
      if (state.attFilter === 'present' && !isHere) return false;
      if (state.attFilter === 'absent' && isHere) return false;
      return !q || m.full_name.includes(q);
    });
    if (!list.length) { el.innerHTML = `<li class="empty">لا نتائج.</li>`; return; }
    el.innerHTML = list.map((m) => {
      const at = state.present.get(m.id);
      return `
        <li>
          <label class="att-item ${at ? 'on' : ''}">
            <input type="checkbox" data-member="${m.id}" ${at ? 'checked' : ''}>
            <span class="tick" aria-hidden="true">✓</span>
            <span class="name">${esc(m.full_name)}</span>
            ${at ? `<small class="muted">${esc(fmtTime(at))}</small>` : ''}
          </label>
        </li>`;
    }).join('');
  }

  $('#att-search').addEventListener('input', (e) => { state.attSearch = e.target.value; renderAttendance(); });
  $('#att-filters').addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    state.attFilter = c.dataset.filter;
    $$('.chip', e.currentTarget).forEach((x) => x.classList.toggle('active', x === c));
    renderAttendance();
  });

  let pendingTicks = 0;
  $('#att-list').addEventListener('change', async (e) => {
    const memberId = e.target.dataset.member;
    if (!memberId) return;
    const meetingId = state.meeting.id;
    const checked = e.target.checked;
    const prev = state.present.get(memberId);

    // تحديث فوري للواجهة ثم الحفظ
    if (checked) state.present.set(memberId, new Date().toISOString());
    else state.present.delete(memberId);
    renderAttendance();

    pendingTicks++;
    const { data, error } = await sb.rpc('meeting_attendance_set_present',
      { p_meeting: meetingId, p_member: memberId, p_on: checked });
    pendingTicks--;
    if (error) {
      if (prev) state.present.set(memberId, prev); else state.present.delete(memberId);
      renderAttendance();
      return fail(error);
    }
    // القائمة المُرجعة تشمل ما سجّله الآخرون من أجهزتهم؛ تُعتمد بعد اكتمال كل الضغطات الجارية
    if (data && pendingTicks === 0 && state.meeting?.id === meetingId) {
      state.present = new Map(Object.entries(data));
      renderAttendance();
    }
  });

  // ---------- الملاحظات ----------
  function renderNotes() {
    const el = $('#notes-list');
    if (!state.notes.length) { el.innerHTML = `<li class="empty">لا توجد ملاحظات بعد.</li>`; return; }
    el.innerHTML = state.notes.map((n) => `
      <li class="note-item">
        <p class="note-content">${esc(n.content)}</p>
        <div class="note-foot">
          <small class="muted">${esc(fmtTime(n.created_at))}</small>
          <button class="icon-btn del no-print" data-del-note="${n.id}" title="حذف">✕</button>
        </div>
      </li>`).join('');
  }

  const noteForm = $('#note-form');
  noteForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const content = noteForm.content.value.trim();
    if (!content) return;
    const btn = noteForm.querySelector('button');
    btn.disabled = true;
    const { data, error } = await sb.rpc('meeting_attendance_add_note',
      { p_meeting: state.meeting.id, p_content: content });
    btn.disabled = false;
    if (error) return fail(error);
    state.notes.push(data);
    noteForm.reset();
    renderNotes();
    noteForm.content.focus();
  });
  noteForm.content.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) noteForm.requestSubmit();
  });

  $('#notes-list').addEventListener('click', async (e) => {
    const id = e.target.dataset.delNote;
    if (!id || !confirm('حذف هذه الملاحظة؟')) return;
    const { error } = await sb.rpc('meeting_attendance_delete_note', { p_meeting: state.meeting.id, p_note: id });
    if (error) return fail(error);
    state.notes = state.notes.filter((n) => n.id !== id);
    renderNotes();
  });

  // ---------- النوافذ ----------
  $$('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
})();
