-- =====================================================================
--  منصة الحضور: جدول واحد (meeting_attendance) داخل مشروع Supabase الخاص بالشكاوى
--  التنفيذ: Supabase → SQL Editor → New query → الصق الملف كاملاً → Run
--  آمن لإعادة التشغيل، ولا يمسّ أي جدول أو دالة من جداول الشكاوى، ولا يحذف بيانات.
--
--  كل سطر في الجدول أحد ثلاثة أنواع (kind):
--    list     قائمة أسماء     name = اسم القائمة (مثل: رؤساء المجموعات)
--    member   اسم شخص         name = الاسم، list_id = قائمته، photo_url = رابط صورته (اختياري)
--    meeting  اجتماع          name = العنوان، meeting_date، location
--                             list_ids = القوائم المشاركة (فارغ = كل القوائم)
--                             خانات مقروءة تتحدث تلقائياً مع كل تفقّد:
--                               names_all      أسماء التفقّد (كل المطلوبين)
--                               names_present  الحاضرون
--                               names_late     المتأخرون
--                               names_absent   الغائبون (من لم يُسجَّل حاضراً ولا متأخراً)
--                             present / late = {"<member id>": "<وقت التفقد>"}
--                             notes = الملاحظات [{"id","content","created_at"}]
--                             details = بيانات المحضر والنص المنقّح (summary)
--
--  الوصول: المستخدمون المسجّلون في Supabase Auth فقط (منصة الشكاوى لا تستخدم Supabase Auth).
--  ⚠️ يجب تعطيل التسجيل الذاتي: Authentication → Sign In / Providers → Allow new users to sign up = OFF
-- =====================================================================

create table if not exists public.meeting_attendance (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null,
  name          text not null check (length(trim(name)) > 0),
  meeting_date  timestamptz,
  location      text,
  present       jsonb not null default '{}'::jsonb,
  notes         jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now()
);

-- ---------- الخانات ----------
alter table public.meeting_attendance add column if not exists photo_url     text;
alter table public.meeting_attendance add column if not exists list_id       uuid
  references public.meeting_attendance(id) on delete cascade;
alter table public.meeting_attendance add column if not exists list_ids      uuid[] not null default '{}';
alter table public.meeting_attendance add column if not exists late          jsonb  not null default '{}'::jsonb;
alter table public.meeting_attendance add column if not exists names_all     text;
alter table public.meeting_attendance add column if not exists names_present text;
alter table public.meeting_attendance add column if not exists names_late    text;
alter table public.meeting_attendance add column if not exists names_absent  text;
-- بيانات المحضر والنص المنقّح للاجتماع:
-- {ref_no, meeting_no, committee, secretary, end_time, next_meeting, postponed, summary}
alter table public.meeting_attendance add column if not exists details       jsonb  not null default '{}'::jsonb;

alter table public.meeting_attendance drop constraint if exists meeting_attendance_kind_check;
alter table public.meeting_attendance add constraint meeting_attendance_kind_check
  check (kind in ('list', 'member', 'meeting'));

create index if not exists meeting_attendance_kind_idx on public.meeting_attendance (kind, meeting_date desc);
create index if not exists meeting_attendance_list_idx on public.meeting_attendance (list_id);

-- الأسماء المسجّلة قبل إضافة القوائم تُنقل إلى «القائمة العامة»
do $$
declare v_list uuid;
begin
  if exists (select 1 from public.meeting_attendance where kind = 'member' and list_id is null) then
    insert into public.meeting_attendance (kind, name) values ('list', 'القائمة العامة') returning id into v_list;
    update public.meeting_attendance set list_id = v_list where kind = 'member' and list_id is null;
  end if;
end $$;

-- ---------- الصلاحيات: المسجّلون فقط، لا شيء للزوار (anon) ----------
alter table public.meeting_attendance enable row level security;
revoke all on public.meeting_attendance from anon;
grant select, insert, update, delete on public.meeting_attendance to authenticated;

drop policy if exists "authenticated full access" on public.meeting_attendance;
create policy "authenticated full access" on public.meeting_attendance
  for all to authenticated using (true) with check (true);

-- ---------- الخانات المقروءة: تُحسب تلقائياً عند أي تغيير في الحضور أو القوائم ----------
create or replace function public.meeting_attendance_names()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if new.kind <> 'meeting' then return new; end if;
  if tg_op = 'UPDATE'
     and new.names_all is not null
     and new.present  is not distinct from old.present
     and new.late     is not distinct from old.late
     and new.list_ids is not distinct from old.list_ids then
    return new;
  end if;

  select string_agg(r.name, '، ' order by r.name),
         string_agg(r.name, '، ' order by r.name) filter (where (new.present ? r.id::text)),
         string_agg(r.name, '، ' order by r.name) filter (where (new.late ? r.id::text)),
         string_agg(r.name, '، ' order by r.name) filter (where not (new.present ? r.id::text) and not (new.late ? r.id::text))
    into new.names_all, new.names_present, new.names_late, new.names_absent
    from public.meeting_attendance r
   where r.kind = 'member'
     and (cardinality(new.list_ids) = 0 or r.list_id = any (new.list_ids));
  return new;
end;
$$;

drop trigger if exists meeting_attendance_names_trg on public.meeting_attendance;
create trigger meeting_attendance_names_trg
  before insert or update on public.meeting_attendance
  for each row execute function public.meeting_attendance_names();

-- ---------- دوال التعديل (ذرّية، وتقبل الوقت الفعلي للتعديل حين يُرفع لاحقاً بعد انقطاع الإنترنت) ----------
drop function if exists public.meeting_attendance_set_present(uuid, uuid, boolean);
drop function if exists public.meeting_attendance_add_note(uuid, text);
alter table public.meeting_attendance drop column if exists attendees;

-- حالة شخص في اجتماع: 'present' حاضر، 'late' متأخر، null بلا علامة
create or replace function public.meeting_attendance_set_status(
  p_meeting uuid, p_member uuid, p_status text, p_at timestamptz default now())
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  k text := p_member::text;
  v jsonb;
begin
  if p_status is not null and p_status not in ('present', 'late') then
    raise exception 'حالة غير معروفة: %', p_status;
  end if;
  update public.meeting_attendance
     set present = (present - k) || case when p_status = 'present' then jsonb_build_object(k, coalesce(p_at, now())) else '{}'::jsonb end,
         late    = (late - k)    || case when p_status = 'late'    then jsonb_build_object(k, coalesce(p_at, now())) else '{}'::jsonb end
   where id = p_meeting and kind = 'meeting'
  returning jsonb_build_object('present', present, 'late', late) into v;
  if v is null then raise exception 'الاجتماع غير موجود'; end if;
  return v;
end;
$$;

-- إضافة ملاحظة (برقم يولّده الجهاز، فلا تتكرر إن أُعيد رفعها)
create or replace function public.meeting_attendance_add_note(
  p_meeting uuid, p_content text, p_id uuid default null, p_created_at timestamptz default null)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_id   uuid := coalesce(p_id, gen_random_uuid());
  v_note jsonb := jsonb_build_object('id', v_id, 'content', trim(p_content), 'created_at', coalesce(p_created_at, now()));
begin
  if coalesce(trim(p_content), '') = '' then raise exception 'الملاحظة فارغة'; end if;
  update public.meeting_attendance
     set notes = case when exists (select 1 from jsonb_array_elements(notes) e where e->>'id' = v_id::text)
                      then notes else notes || jsonb_build_array(v_note) end
   where id = p_meeting and kind = 'meeting';
  if not found then raise exception 'الاجتماع غير موجود'; end if;
  return v_note;
end;
$$;

-- حذف ملاحظة
create or replace function public.meeting_attendance_delete_note(p_meeting uuid, p_note uuid)
returns void language sql security invoker set search_path = public as $$
  update public.meeting_attendance
     set notes = coalesce((select jsonb_agg(e) from jsonb_array_elements(notes) e where e->>'id' <> p_note::text), '[]'::jsonb)
   where id = p_meeting and kind = 'meeting';
$$;

revoke all on function public.meeting_attendance_set_status(uuid, uuid, text, timestamptz)   from public, anon;
revoke all on function public.meeting_attendance_add_note(uuid, text, uuid, timestamptz)    from public, anon;
revoke all on function public.meeting_attendance_delete_note(uuid, uuid)                     from public, anon;
grant execute on function public.meeting_attendance_set_status(uuid, uuid, text, timestamptz) to authenticated;
grant execute on function public.meeting_attendance_add_note(uuid, text, uuid, timestamptz)  to authenticated;
grant execute on function public.meeting_attendance_delete_note(uuid, uuid)                   to authenticated;

-- تعبئة الخانات المقروءة للاجتماعات السابقة
update public.meeting_attendance set names_all = null where kind = 'meeting';
