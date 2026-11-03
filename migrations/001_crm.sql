-- Миграция 001: заявки превращаются в CRM с воронкой.
-- Выполнить ОДИН раз в Supabase: SQL Editor → New query → вставить весь файл → Run.
-- Выполнять ДО загрузки нового кода на GitHub/Vercel.
-- Повторный запуск безопасен: уже перенесённые данные не меняются, дубли истории не появятся.
--
-- Что делает:
--   1. Добавляет в leads поля source («Сайт» / «Вручную») и notes (заметки админа).
--   2. Создаёт таблицу истории этапов lead_stage_history.
--   3. Для старых заявок пишет историю: создание с настоящей датой и перенос со старого статуса.
--   4. Переносит старые статусы на новые этапы:
--        новая    → Новая
--        в работе → Связались
--        закрыта  → Консультация проведена
--   5. Ставит триггер: дальше история пишется сама при создании и каждой смене этапа.

begin;

-- 1. Новые поля ---------------------------------------------------------------

alter table public.leads add column if not exists source text not null default 'Сайт';
alter table public.leads add column if not exists notes  text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.leads'::regclass and conname = 'leads_source_check'
  ) then
    alter table public.leads
      add constraint leads_source_check check (source in ('Сайт', 'Вручную'));
  end if;
end $$;

-- Старое ограничение на статусы мешает новым значениям — убираем все check-ограничения на status
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.leads'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%status%'
  loop
    execute format('alter table public.leads drop constraint %I', c.conname);
  end loop;
end $$;

-- 2. Таблица истории ----------------------------------------------------------

create table if not exists public.lead_stage_history (
  id         bigint generated always as identity primary key,
  lead_id    bigint not null references public.leads (id) on delete cascade,
  from_stage text,                 -- пусто, если это создание заявки
  to_stage   text not null,
  changed_at timestamptz not null default now(),
  note       text                  -- служебная пометка (например, про миграцию)
);

create index if not exists lead_stage_history_lead_idx
  on public.lead_stage_history (lead_id, changed_at);

-- Как и у leads: RLS без политик, доступ только у сервера с секретным ключом
alter table public.lead_stage_history enable row level security;

-- 3. История для уже существующих заявок -------------------------------------
-- Пишем только тем заявкам, у которых истории ещё нет (поэтому повторный запуск не создаст дублей).
-- no_history — не таблица, а подзапрос (CTE): существует только внутри этого одного запроса.

with no_history as (
  select l.id, l.status, l.created_at
  from public.leads l
  where not exists (select 1 from public.lead_stage_history h where h.lead_id = l.id)
)
insert into public.lead_stage_history (lead_id, from_stage, to_stage, changed_at, note)
-- Создание заявки — с её настоящей датой
select id, null, 'Новая', created_at, null
from no_history
union all
-- Перенос со старого статуса — с датой миграции и пометкой, каким был статус
select id,
       'Новая',
       case status when 'в работе' then 'Связались'
                   when 'закрыта'  then 'Консультация проведена' end,
       now(),
       'перенесено из старого статуса «' || status || '»'
from no_history
where status in ('в работе', 'закрыта');

-- 4. Перенос статусов ---------------------------------------------------------

update public.leads
set status = case status when 'новая'    then 'Новая'
                         when 'в работе' then 'Связались'
                         when 'закрыта'  then 'Консультация проведена' end
where status in ('новая', 'в работе', 'закрыта');

alter table public.leads alter column status set default 'Новая';

alter table public.leads drop constraint if exists leads_status_check;
alter table public.leads add constraint leads_status_check check (status in (
  'Новая', 'Связались', 'Записан на консультацию', 'Консультация проведена', 'Отказ'
));

-- 5. Триггер истории ----------------------------------------------------------
-- Создаётся после переноса, чтобы перенос не записался в историю второй раз

create or replace function public.leads_log_stage() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    insert into public.lead_stage_history (lead_id, from_stage, to_stage, changed_at)
    values (new.id, null, new.status, new.created_at);
  elsif new.status is distinct from old.status then
    insert into public.lead_stage_history (lead_id, from_stage, to_stage)
    values (new.id, old.status, new.status);
  end if;
  return null;
end $$;

drop trigger if exists leads_log_stage on public.leads;
create trigger leads_log_stage
  after insert or update of status on public.leads
  for each row execute function public.leads_log_stage();

commit;

-- Сообщаем Supabase API, что схема поменялась
notify pgrst, 'reload schema';
