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
  const toMeeting = (r) => ({ ...r, title: r.name, present: r.present || {}, notes: r.notes || [], list_ids: r.list_ids || [] });

  // القوائم المشاركة في اجتماع (الموجودة فعلاً)؛ اجتماع بلا قوائم محددة = كل القوائم
  const meetingLists = (m) => {
    const chosen = state.lists.filter((l) => m.list_ids.includes(l.id));
    return chosen.length ? chosen : state.lists;
  };
  // أسماء الاجتماع: أسماء قوائمه المشاركة
  const rosterOf = (m) => {
    const ids = new Set(meetingLists(m).map((l) => l.id));
    return state.members.filter((x) => ids.has(x.list_id));
  };

  const state = {
    lists: [],
    currentListId: localStorage.getItem('current-list') || null,
    members: [],
    meetings: [],
    meeting: null,
    present: new Map(), // member_id -> checked_at
    notes: [],
    attFilter: 'all',
    attSearch: '',
    membersSearch: '',
    pendingImport: null,
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
    // أولاً القوائم والأسماء: بطاقات الاجتماعات تعتمد عليها
    await loadLists();
    await loadMembers();
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
  //  القوائم
  // =====================================================================
  const listName = (id) => state.lists.find((l) => l.id === id)?.name || '';
  const currentList = () => state.lists.find((l) => l.id === state.currentListId) || null;
  const membersOf = (listId) => state.members.filter((m) => m.list_id === listId);

  async function loadLists() {
    const { data, error } = await tbl().select('id, name').eq('kind', 'list').order('created_at');
    if (error) return fail(error);
    state.lists = data;
    if (!currentList()) state.currentListId = state.lists[0]?.id || null;
    renderLists();
  }

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
    const name = cleanName(prompt('اسم القائمة الجديدة (مثل: رؤساء المجموعات):'));
    if (!name) return;
    if (state.lists.some((l) => nameKey(l.name) === nameKey(name))) return toast('توجد قائمة بهذا الاسم', 'err');
    const { data, error } = await tbl().insert({ kind: 'list', name }).select('id, name').single();
    if (error) return fail(error);
    state.lists.push(data);
    toast(`تم إنشاء قائمة «${name}»`);
    selectList(data.id);
  });

  $('#rename-list-btn').addEventListener('click', async () => {
    const cur = currentList();
    if (!cur) return;
    const name = cleanName(prompt('الاسم الجديد للقائمة:', cur.name));
    if (!name || name === cur.name) return;
    const { error } = await tbl().update({ name }).eq('id', cur.id).eq('kind', 'list');
    if (error) return fail(error);
    cur.name = name;
    renderLists();
    toast('تمت إعادة التسمية');
  });

  $('#delete-list-btn').addEventListener('click', async () => {
    const cur = currentList();
    if (!cur) return;
    const n = membersOf(cur.id).length;
    if (!confirm(`حذف قائمة «${cur.name}» مع أسمائها (${n} اسم)؟\nأسماء الحاضرين في الاجتماعات السابقة تبقى محفوظة في سجلها.`)) return;
    const { error } = await tbl().delete().eq('id', cur.id).eq('kind', 'list');
    if (error) return fail(error);
    state.lists = state.lists.filter((l) => l.id !== cur.id);
    state.members = state.members.filter((m) => m.list_id !== cur.id);
    toast('تم حذف القائمة');
    selectList(state.lists[0]?.id || null);
  });

  // =====================================================================
  //  الأسماء
  // =====================================================================
  // ---------- الصور ----------
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

  // تكبير الصورة
  function zoomPhoto(id) {
    const m = state.members.find((x) => x.id === id);
    if (!m?.photo_url) return;
    $('#photo-dialog-img').src = photoSrc(m.photo_url).replace(/sz=w\d+/, 'sz=w1000');
    $('#photo-dialog-name').textContent = m.full_name;
    $('#photo-dialog').showModal();
  }
  $('#photo-dialog').addEventListener('click', () => $('#photo-dialog').close());

  async function loadMembers() {
    // Supabase يعيد 1000 صف كحد أقصى في الطلب الواحد، فنجلب على دفعات
    const all = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await tbl().select('id, name, list_id, photo_url').eq('kind', 'member')
        .order('name').range(from, from + 999);
      if (error) return fail(error);
      all.push(...data.map((r) => ({ id: r.id, full_name: r.name, list_id: r.list_id, photo_url: r.photo_url })));
      if (data.length < 1000) break;
    }
    state.members = all;
    renderLists();
    renderMembers();
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
    if (photoId) {
      const m = state.members.find((x) => x.id === photoId);
      const v = prompt(`رابط صورة «${m.full_name}»\n(اتركه فارغاً لحذف الصورة)`, m.photo_url || '');
      if (v === null) return;
      const url = v.trim();
      if (url && !isUrl(url)) return toast('الرابط يجب أن يبدأ بـ http:// أو https://', 'err');
      const { error } = await tbl().update({ photo_url: url || null }).eq('id', photoId).eq('kind', 'member');
      if (error) return fail(error);
      m.photo_url = url || null;
      renderMembers();
      toast(url ? 'تم حفظ الصورة' : 'تم حذف الصورة');
      return;
    }
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

  // خطة الإضافة إلى قائمة: الأسماء الجديدة، وصور جديدة لأسماء موجودة، والمكرر المتجاهَل
  // entries: [{ name, photo }]
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
    const { listId, fresh, photoUpdates, dup } = plan;
    if (!fresh.length && !photoUpdates.length) {
      toast(dup ? 'كل الأسماء موجودة مسبقاً في هذه القائمة' : 'لا توجد أسماء', 'err');
      return false;
    }
    for (let i = 0; i < fresh.length; i += 500) {
      const chunk = fresh.slice(i, i + 500).map((x) => ({ kind: 'member', name: x.name, list_id: listId, photo_url: x.photo || null }));
      const { error } = await tbl().insert(chunk);
      if (error) { fail(error); await loadMembers(); return false; }
    }
    for (let i = 0; i < photoUpdates.length; i += 20) {
      const results = await Promise.all(photoUpdates.slice(i, i + 20).map((u) =>
        tbl().update({ photo_url: u.photo }).eq('id', u.id).eq('kind', 'member')));
      const err = results.find((r) => r.error)?.error;
      if (err) { fail(err); await loadMembers(); return false; }
    }
    const parts = [];
    if (fresh.length) parts.push(`إضافة ${fresh.length} اسم`);
    if (photoUpdates.length) parts.push(`صور ${photoUpdates.length} اسم موجود`);
    toast(`تم في «${listName(listId)}»: ${parts.join('، ')}${dup ? ` (وتجاهل ${dup} مكرر)` : ''}`);
    await loadMembers();
    return true;
  }

  // ---------- إضافة يدوية ----------
  // كل سطر اسم، ويمكن أن يتبعه رابط صورة: «أحمد محمد https://...»
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

  // يقرأ من الورقة الأولى: الاسم من العمود الأول، والصورة من أول رابط في بقية الأعمدة
  // (رابط مكتوب نصاً، أو ارتباط تشعبي على خلية، ومنها خلية الاسم نفسها)
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
  //  الاجتماعات
  // =====================================================================
  async function loadMeetings() {
    const { data, error } = await tbl()
      .select('id, name, meeting_date, location, present, notes, list_ids')
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
    el.innerHTML = state.meetings.map((m) => {
      const roster = rosterOf(m);
      const here = roster.filter((x) => m.present[x.id]).length;
      const lists = m.list_ids.length ? meetingLists(m).map((l) => l.name).join('، ') : 'كل القوائم';
      return `
        <div class="card meeting-card" data-id="${m.id}" role="button" tabindex="0">
          <div class="meeting-card-actions">
            <button class="icon-btn" data-edit-meeting="${m.id}" title="تعديل الاجتماع">✎</button>
            <button class="icon-btn del" data-del-meeting="${m.id}" title="حذف الاجتماع">✕</button>
          </div>
          <h3>${esc(m.title)}</h3>
          <p class="muted">${esc(fmtDateTime(m.meeting_date))}</p>
          ${m.location ? `<p class="muted">📍 ${esc(m.location)}</p>` : ''}
          <p class="muted small-inline">📋 ${esc(lists)}</p>
          <div class="meeting-card-foot">
            <span class="badge present">✓ حضر ${here} من ${roster.length}</span>
            <span class="badge">الملاحظات ${m.notes.length}</span>
          </div>
        </div>`;
    }).join('');
  }

  async function deleteMeeting(m) {
    if (!confirm(`حذف اجتماع «${m.title}» مع سجل الحضور والملاحظات؟\nلا يمكن التراجع عن الحذف.`)) return false;
    const { error } = await tbl().delete().eq('id', m.id).eq('kind', 'meeting');
    if (error) { fail(error); return false; }
    toast('تم حذف الاجتماع');
    return true;
  }

  $('#meetings-list').addEventListener('click', async (e) => {
    const editId = e.target.dataset.editMeeting;
    const delId = e.target.dataset.delMeeting;
    if (editId) return openMeetingDialog(state.meetings.find((m) => m.id === editId));
    if (delId) {
      if (await deleteMeeting(state.meetings.find((m) => m.id === delId))) loadMeetings();
      return;
    }
    const card = e.target.closest('.meeting-card');
    if (card) openMeeting(card.dataset.id);
  });
  $('#meetings-list').addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('meeting-card')) {
      e.preventDefault();
      openMeeting(e.target.dataset.id);
    }
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
    // القوائم المشاركة: عند التعديل ما سبق اختياره، وعند الإنشاء كلها
    const chosen = meeting?.list_ids?.length ? meeting.list_ids : state.lists.map((l) => l.id);
    $('#meeting-lists').innerHTML = state.lists.length
      ? state.lists.map((l) => `
          <label class="check">
            <input type="checkbox" name="list" value="${l.id}" ${chosen.includes(l.id) ? 'checked' : ''}>
            ${esc(l.name)} <span class="muted">(${membersOf(l.id).length})</span>
          </label>`).join('')
      : `<p class="muted">لا توجد قوائم بعد. أنشئها من تبويب «الأسماء».</p>`;
    $('#meeting-dialog').showModal();
  }
  $('#new-meeting-btn').addEventListener('click', () => openMeetingDialog());
  $('#edit-meeting-btn').addEventListener('click', () => openMeetingDialog(state.meeting));

  $('#meeting-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const listIds = $$('input[name="list"]:checked', f).map((c) => c.value);
    if (state.lists.length && !listIds.length) return toast('اختر قائمة واحدة على الأقل', 'err');
    const row = {
      name: f.title.value.trim(),
      meeting_date: new Date(f.meeting_date.value).toISOString(),
      location: f.location.value.trim() || null,
      list_ids: listIds,
    };
    const q = editingMeetingId
      ? tbl().update(row).eq('id', editingMeetingId).eq('kind', 'meeting')
      : tbl().insert({ ...row, kind: 'meeting' });
    const { data, error } = await q.select().single();
    if (error) return fail(error);
    $('#meeting-dialog').close();
    if (!editingMeetingId) return openMeeting(data.id);
    toast('تم تحديث الاجتماع');
    if (state.meeting?.id === editingMeetingId) {
      state.meeting = toMeeting(data);
      renderMeetingHeader();
      renderAttendance();
    } else {
      loadMeetings();
    }
  });

  $('#delete-meeting-btn').addEventListener('click', async () => {
    if (!(await deleteMeeting(state.meeting))) return;
    state.meeting = null;
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
    const lists = meetingLists(m).map((l) => l.name).join('، ');
    $('#m-meta').textContent = [fmtDateTime(m.meeting_date), m.location, lists && `📋 ${lists}`].filter(Boolean).join(' · ');
  }

  // ---------- التفقّد ----------
  function renderStats() {
    const roster = rosterOf(state.meeting);
    const total = roster.length;
    const here = roster.filter((m) => state.present.has(m.id)).length;
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
    if (!rosterOf(state.meeting).length) {
      el.innerHTML = `<li class="empty">لا توجد أسماء في قوائم هذا الاجتماع. أضفها من تبويب «الأسماء»، أو غيّر القوائم من «تعديل».</li>`;
      return;
    }
    const q = state.attSearch.trim();
    const match = (m) => {
      const isHere = state.present.has(m.id);
      if (state.attFilter === 'present' && !isHere) return false;
      if (state.attFilter === 'absent' && isHere) return false;
      return !q || m.full_name.includes(q);
    };
    const lists = meetingLists(state.meeting);
    const showHeads = lists.length > 1;
    let html = '';
    for (const l of lists) {
      const inList = membersOf(l.id);
      const items = inList.filter(match);
      if (!items.length) continue;
      if (showHeads) {
        const here = inList.filter((m) => state.present.has(m.id)).length;
        html += `<li class="group-head">${esc(l.name)} <span class="muted">${here} / ${inList.length}</span></li>`;
      }
      html += items.map((m) => {
        const at = state.present.get(m.id);
        return `
          <li>
            <label class="att-item ${at ? 'on' : ''}">
              <input type="checkbox" data-member="${m.id}" ${at ? 'checked' : ''}>
              <span class="tick" aria-hidden="true">✓</span>
              ${avatar(m)}
              <span class="name">${esc(m.full_name)}</span>
              ${at ? `<small class="muted">${esc(fmtTime(at))}</small>` : ''}
            </label>
          </li>`;
      }).join('');
    }
    el.innerHTML = html || `<li class="empty">لا نتائج.</li>`;
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
  }

  function startMic() {
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
        micStatus('تحويل الكلام يحتاج اتصالاً بالإنترنت.', 'err');
      } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
        console.warn('speech error:', e.error);
      }
    };
    r.onend = () => {
      if (rec !== r) return; // مُستمِع قديم (بعد تغيير اللهجة): لا يعيد التشغيل
      // لا نُضيّع آخر كلام لم يكتمل تحويله
      if (interimText) { appendSpeech(interimText); setInterim(''); }
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

  // إيقاف التسجيل عند مغادرة صفحة الاجتماع
  $('#back-btn').addEventListener('click', () => { if (listening) stopMic(); });
  $$('.tab').forEach((t) => t.addEventListener('click', () => { if (listening) stopMic(); }));

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
