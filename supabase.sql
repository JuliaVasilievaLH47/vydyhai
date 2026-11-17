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
             constraint leads_source_check check (source in ('Сайт', 'Вручную', 'Telegram', 'Голос')),
  status     text not null default 'Новая'
             constraint leads_status_check check (status in (
               'Новая', 'Связались', 'Записан на консультацию', 'Консультация проведена', 'Оплачено', 'Отказ'
             )),
  -- Запись через Telegram Mini App (migrations/003_telegram.sql)
  telegram_id       bigint,
  telegram_username text,
  consultation_at   timestamptz
                    constraint leads_consultation_hour_check
                    check (consultation_at is null or date_trunc('hour', consultation_at) = consultation_at),
  -- Время согласия на обработку контактов, ставит сервер (migrations/009_consent.sql, аудит L5).
  -- Пусто у клиентов, добавленных админом вручную
  consent_at        timestamptz
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

-- ---------- Счета (то же, что migrations/004_invoices.sql) ----------
-- Номер счёта = id. items — позиции [{title, qty, price_cents}], суммы в целых копейках.
create table if not exists public.invoices (
  id             bigint generated always as identity primary key,
  created_at     timestamptz not null default now(),
  lead_id        bigint not null references public.leads (id) on delete restrict,
  issued_on      date not null,
  due_on         date not null,
  currency       text not null default 'MDL'
                 constraint invoices_currency_check check (currency ~ '^[A-Z]{3}$'),
  items          jsonb not null
                 constraint invoices_items_check
                 check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) between 1 and 10),
  total_cents    bigint not null
                 constraint invoices_total_check check (total_cents > 0),
  status         text not null default 'Не оплачен'
                 constraint invoices_status_check check (status in ('Не оплачен', 'Оплачен')),
  paid_at        timestamptz,
  file_path      text,                            -- путь PDF в bucket invoices
  sent_to_client boolean not null default false,  -- PDF ушёл клиенту в Telegram
  constraint invoices_due_check check (due_on >= issued_on),
  constraint invoices_paid_check check ((status = 'Оплачен') = (paid_at is not null))
);

create index if not exists invoices_lead_idx on public.invoices (lead_id, id desc);
alter table public.invoices enable row level security;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('invoices', 'invoices', false, 2097152, array['application/pdf'])
on conflict (id) do update
  set public             = false,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------- Попытки входа в админку (то же, что migrations/005 и 007) ----------
-- api/login.js: больше 10 попыток с одного адреса или 100 всего за 15 минут → 429.
-- Вместо IP хранится HMAC-отпечаток. passed = попытка прошла лимит адреса:
-- общий лимит считает только такие, поэтому один адрес не закроет вход для всех.
create table if not exists public.login_attempts (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  ip_hash text not null constraint login_attempts_ip_hash_check check (length(ip_hash) between 1 and 64),
  passed  boolean not null default false
);

create index if not exists login_attempts_ip_at_idx on public.login_attempts (ip_hash, at);
create index if not exists login_attempts_at_idx on public.login_attempts (at);
create index if not exists login_attempts_passed_at_idx on public.login_attempts (at) where passed;
alter table public.login_attempts enable row level security;
revoke all on public.login_attempts from anon, authenticated;

-- ---------- Отправки формы заявки (то же, что migrations/006 и 007) ----------
-- api/lead.js: больше 5 заявок с одного адреса или 30 всего за 60 минут → 429.
-- Вместо IP хранится HMAC-отпечаток. passed — как в login_attempts.
create table if not exists public.lead_attempts (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  ip_hash text not null constraint lead_attempts_ip_hash_check check (length(ip_hash) between 1 and 64),
  passed  boolean not null default false
);

create index if not exists lead_attempts_ip_at_idx on public.lead_attempts (ip_hash, at);
create index if not exists lead_attempts_at_idx on public.lead_attempts (at);
create index if not exists lead_attempts_passed_at_idx on public.lead_attempts (at) where passed;
alter table public.lead_attempts enable row level security;
revoke all on public.lead_attempts from anon, authenticated;

-- ---------- Заявки голосового агента и записи Mini App (то же, что migrations/008) ----------
-- Устройство как у lead_attempts. Отдельные таблицы: спам в одном канале не закрывает другие.
-- voice_attempts — api/voice-lead.js: больше 2 заявок с одного телефона или 10 всего за 60 минут → отказ.
-- app_attempts — api/app.js (POST): больше 5 попыток с одного аккаунта Telegram или 10 всего за 60 минут → 429.
-- В ip_hash — HMAC-отпечаток телефона или telegram_id.
create table if not exists public.voice_attempts (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  ip_hash text not null constraint voice_attempts_ip_hash_check check (length(ip_hash) between 1 and 64),
  passed  boolean not null default false
);

create index if not exists voice_attempts_ip_at_idx on public.voice_attempts (ip_hash, at);
create index if not exists voice_attempts_at_idx on public.voice_attempts (at);
create index if not exists voice_attempts_passed_at_idx on public.voice_attempts (at) where passed;
alter table public.voice_attempts enable row level security;
revoke all on public.voice_attempts from anon, authenticated;

create table if not exists public.app_attempts (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  ip_hash text not null constraint app_attempts_ip_hash_check check (length(ip_hash) between 1 and 64),
  passed  boolean not null default false
);

create index if not exists app_attempts_ip_at_idx on public.app_attempts (ip_hash, at);
create index if not exists app_attempts_at_idx on public.app_attempts (at);
create index if not exists app_attempts_passed_at_idx on public.app_attempts (at) where passed;
alter table public.app_attempts enable row level security;
revoke all on public.app_attempts from anon, authenticated;
