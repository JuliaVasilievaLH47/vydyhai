-- Полная схема для НОВОЙ установки. Выполнить один раз в Supabase: SQL Editor → New query → вставить → Run.
-- Если база уже работает, этот файл не нужен — выполните недостающие файлы из migrations/ по порядку.

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
             constraint leads_source_check check (source in ('Сайт', 'Вручную', 'Telegram')),
  status     text not null default 'Новая'
             constraint leads_status_check check (status in (
               'Новая', 'Связались', 'Записан на консультацию', 'Консультация проведена', 'Отказ'
             )),
  -- Запись через Telegram Mini App (migrations/003_telegram.sql)
  telegram_id       bigint,
  telegram_username text,
  consultation_at   timestamptz
                    constraint leads_consultation_hour_check
                    check (consultation_at is null or date_trunc('hour', consultation_at) = consultation_at)
);

create index if not exists leads_created_at_idx on public.leads (created_at desc);
create index if not exists leads_status_idx on public.leads (status);

-- Защита от двойной записи: один слот — одна запись (кроме «Отказа»),
-- у одного пользователя Telegram — одна запись на этапе «Записан на консультацию»
create unique index if not exists leads_consultation_slot_uniq
  on public.leads (consultation_at)
  where consultation_at is not null and status <> 'Отказ';
create unique index if not exists leads_telegram_active_uniq
  on public.leads (telegram_id)
  where telegram_id is not null and status = 'Записан на консультацию';

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

-- ---------- Расходы (то же, что migrations/002_expenses.sql) ----------
-- Категории: этот же список есть в api/_lib.js и admin.html (CATEGORIES).
create table if not exists public.expenses (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  expense_date date not null,
  amount       numeric(12,2) not null
               constraint expenses_amount_check check (amount > 0),
  currency     text not null default 'MDL'
               constraint expenses_currency_check check (currency ~ '^[A-Z]{3}$'),
  vendor       text not null default '',
  category     text not null
               constraint expenses_category_check check (category in (
                 'Реклама', 'Печать материалов', 'Консультанты', 'Сервисы и подписки', 'Прочее'
               )),
  file_path    text not null,
  file_type    text not null
               constraint expenses_file_type_check check (file_type in (
                 'image/jpeg', 'image/png', 'image/webp', 'application/pdf'
               ))
);

create index if not exists expenses_date_idx on public.expenses (expense_date desc);
alter table public.expenses enable row level security;

-- Приватный bucket для оригиналов чеков. Политик на storage.objects для него не создаём:
-- RLS там включён всегда, поэтому файлы доступны только серверу с секретным ключом.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 5242880,
        array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do update
  set public             = false,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
