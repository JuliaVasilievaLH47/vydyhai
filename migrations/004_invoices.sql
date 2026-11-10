-- Миграция 004: счета на оплату, этап «Оплачено», источник «Голос».
-- Выполнить ОДИН раз в Supabase: SQL Editor → New query → вставить весь файл → Run.
-- Выполнять ДО загрузки нового кода на GitHub/Vercel.
-- Повторный запуск безопасен: существующие данные не меняются.
--
-- Что делает:
--   1. Добавляет этап «Оплачено» между «Консультация проведена» и «Отказ».
--   2. Разрешает источник «Голос» (заявки от голосового агента, блок 4).
--   3. Создаёт таблицу invoices (счета). Номер счёта = id, идёт по порядку.
--   4. Создаёт приватный bucket invoices для PDF.

begin;

-- 1. Этап «Оплачено». Тот же список — STATUSES в api/_lib.js и admin.html ---------

alter table public.leads drop constraint if exists leads_status_check;
alter table public.leads add constraint leads_status_check
  check (status in (
    'Новая', 'Связались', 'Записан на консультацию', 'Консультация проведена', 'Оплачено', 'Отказ'
  ));

-- 2. Источник «Голос» -----------------------------------------------------------

alter table public.leads drop constraint if exists leads_source_check;
alter table public.leads add constraint leads_source_check
  check (source in ('Сайт', 'Вручную', 'Telegram', 'Голос'));

-- 3. Счета ------------------------------------------------------------------------
-- items — позиции [{title, qty, price_cents}], суммы хранятся в целых копейках.
-- Клиента со счетами удалить нельзя (on delete restrict): финансовые записи не пропадают молча.

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

-- RLS без политик, как у остальных таблиц: доступ только у сервера с секретным ключом
alter table public.invoices enable row level security;

-- 4. Приватный bucket для PDF (политик на storage.objects нет — файлы видит только сервер)

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('invoices', 'invoices', false, 2097152, array['application/pdf'])
on conflict (id) do update
  set public             = false,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

commit;

-- Сообщаем Supabase API, что схема поменялась
notify pgrst, 'reload schema';
