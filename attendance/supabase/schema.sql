-- =====================================================================
--  منصة الحضور: جدول واحد (meeting_attendance) داخل مشروع Supabase الخاص بالشكاوى
--  التنفيذ: Supabase → SQL Editor → New query → الصق الملف كاملاً → Run
--  آمن لإعادة التشغيل، ولا يمسّ أي جدول أو دالة من جداول الشكاوى.
--
--  كل سطر في الجدول أحد ثلاثة أنواع (kind):
--    list     قائمة أسماء          name = اسم القائمة (مثل: رؤساء المجموعات)
--    member   اسم شخص              name = الاسم، list_id = قائمته، photo_url = رابط صورته (اختياري)
--                                  (حذف القائمة يحذف أسماءها، ويبقى سجل الاجتماعات السابقة في attendees)
--    meeting  اجتماع               name = عنوان الاجتماع، meeting_date، location
--                                  list_ids = القوائم المشاركة (فارغ = كل القوائم)
--                                  present = من حضر {"<member id>": "<وقت التفقد>"}
--                                  attendees = أسماء الحاضرين في خانة واحدة: «أحمد، سارة، ...»
--                                  notes   = الملاحظات [{"id","content","created_at"}]
--
--  الوصول: المستخدمون المسجّلون في Supabase Auth فقط (منصة الشكاوى لا تستخدم Supabase Auth).
--  ⚠️ يجب تعطيل التسجيل الذاتي: Authentication → Sign In / Providers → Allow new users to sign up = OFF
-- =====================================================================

create table if not exists public.meeting_attendance (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('member', 'meeting')),
  name          text not null check (length(trim(name)) > 0),
  meeting_date  timestamptz,
  location      text,
  present       jsonb not null default '{}'::jsonb,
  notes         jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now()
);

-- أسماء الحاضرين مكتوبة في خانة واحدة (تتحدث تلقائياً مع كل علامة حضور)
alter table public.meeting_attendance add column if not exists attendees text;

-- رابط صورة الشخص (لأسطر member)
alter table public.meeting_attendance add column if not exists photo_url text;

-- القوائم: سطر لكل قائمة (kind = list)، وكل اسم ينتمي لقائمة (list_id)،
-- وكل اجتماع يحدد القوائم المشاركة فيه (list_ids؛ فارغ = كل القوائم)
alter table public.meeting_attendance drop constraint if exists meeting_attendance_kind_check;
alter table public.meeting_attendance add constraint meeting_attendance_kind_check
  check (kind in ('list', 'member', 'meeting'));
alter table public.meeting_attendance add column if not exists list_id uuid
  references public.meeting_attendance(id) on delete cascade;
alter table public.meeting_attendance add column if not exists list_ids uuid[] not null default '{}';
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

create index if not exists meeting_attendance_kind_idx on public.meeting_attendance (kind, meeting_date desc);

-- ---------- الصلاحيات: المسجّلون فقط، لا شيء للزوار (anon) ----------
alter table public.meeting_attendance enable row level security;
revoke all on public.meeting_attendance from anon;
grant select, insert, update, delete on public.meeting_attendance to authenticated;

drop policy if exists "authenticated full access" on public.meeting_attendance;
create policy "authenticated full access" on public.meeting_attendance
  for all to authenticated using (true) with check (true);

-- ---------- تعديلات ذرّية (حتى لا يمحو جهازان تعديلات بعضهما أثناء الاجتماع) ----------
-- وضع/إزالة علامة الحضور لشخص في اجتماع، وتحديث خانة أسماء الحاضرين؛ تُرجع قائمة الحضور بعد التعديل
create or replace function public.meeting_attendance_set_present(p_meeting uuid, p_member uuid, p_on boolean)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_present jsonb;
begin
  update public.meeting_attendance
     set present = case when p_on then present || jsonb_build_object(p_member::text, now())
                        else present - p_member::text end
   where id = p_meeting and kind = 'meeting'
  returning present into v_present;
  if v_present is null then raise exception 'الاجتماع غير موجود'; end if;

  update public.meeting_attendance
     set attendees = (select string_agg(m.name, '، ' order by m.name)
                        from public.meeting_attendance m
                       where m.kind = 'member' and v_present ? m.id::text)
   where id = p_meeting;
  return v_present;
end;
$$;

-- تعبئة خانة الأسماء للاجتماعات المسجّلة قبل إضافتها
update public.meeting_attendance t
   set attendees = (select string_agg(m.name, '، ' order by m.name)
                      from public.meeting_attendance m
                     where m.kind = 'member' and t.present ? m.id::text)
 where t.kind = 'meeting' and t.attendees is null and t.present <> '{}'::jsonb;

-- إضافة ملاحظة؛ تُرجع الملاحظة الجديدة
create or replace function public.meeting_attendance_add_note(p_meeting uuid, p_content text)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_note jsonb := jsonb_build_object('id', gen_random_uuid(), 'content', trim(p_content), 'created_at', now());
begin
  if coalesce(trim(p_content), '') = '' then raise exception 'الملاحظة فارغة'; end if;
  update public.meeting_attendance set notes = notes || jsonb_build_array(v_note)
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

revoke all on function public.meeting_attendance_set_present(uuid, uuid, boolean) from public, anon;
revoke all on function public.meeting_attendance_add_note(uuid, text)            from public, anon;
revoke all on function public.meeting_attendance_delete_note(uuid, uuid)         from public, anon;
grant execute on function public.meeting_attendance_set_present(uuid, uuid, boolean) to authenticated;
grant execute on function public.meeting_attendance_add_note(uuid, text)            to authenticated;
grant execute on function public.meeting_attendance_delete_note(uuid, uuid)         to authenticated;
