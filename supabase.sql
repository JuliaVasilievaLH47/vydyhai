-- Полная схема для НОВОЙ установки. Выполнить один раз в Supabase: SQL Editor → New query → вставить → Run.
-- Если таблица leads уже есть (проект работал до CRM), этот файл не нужен —
-- выполните migrations/001_crm.sql.

-- Этапы воронки: этот же список есть в api/_lib.js и admin.html (STATUSES), а также в migrations/001_crm.sql.
create table if not exists public.leads (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  name       text not null,
  phone      text not null,
  age        int,
  topic      text,
  comment    text,               -- комментарий посетителя из формы на сайте
  notes      text,               -- заметки админа, редактируются в карточке
  source     text not null default 'Сайт'
             constraint leads_source_check check (source in ('Сайт', 'Вручную')),
  status     text not null default 'Новая'
             constraint leads_status_check check (status in (
               'Новая', 'Связались', 'Записан на консультацию', 'Консультация проведена', 'Отказ'
             ))
);

create index if not exists leads_created_at_idx on public.leads (created_at desc);
create index if not exists leads_status_idx on public.leads (status);

-- История этапов: строка при создании заявки и при каждой смене этапа (пишет триггер ниже)
create table if not exists public.lead_stage_history (
  id         bigint generated always as identity primary key,
  lead_id    bigint not null references public.leads (id) on delete cascade,
  from_stage text,                 -- пусто, если это создание заявки
  to_stage   text not null,
  changed_at timestamptz not null default now(),
  note       text
);

create index if not exists lead_stage_history_lead_idx
  on public.lead_stage_history (lead_id, changed_at);

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

-- RLS включён и политик нет: публичный (anon) ключ не может ни читать, ни писать.
-- Доступ есть только у сервера на Vercel с секретным ключом.
alter table public.leads enable row level security;
alter table public.lead_stage_history enable row level security;
