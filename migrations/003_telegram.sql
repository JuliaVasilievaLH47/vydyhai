-- Миграция 003: запись на консультацию через Telegram Mini App.
-- Выполнить ОДИН раз в Supabase: SQL Editor → New query → вставить весь файл → Run.
-- Выполнять ДО загрузки нового кода на GitHub/Vercel.
-- Повторный запуск безопасен: существующие данные не меняются.
--
-- Что делает:
--   1. Разрешает источник «Telegram» (к «Сайт» и «Вручную»).
--   2. Добавляет в leads: telegram_id, telegram_username, consultation_at (дата и время консультации).
--   3. Защищает слоты от двойной записи на уровне базы:
--        - один слот — не больше одной записи (кроме клиентов на этапе «Отказ»: их время освобождается);
--        - у одного пользователя Telegram — не больше одной записи на этапе «Записан на консультацию».
--   4. Требует, чтобы время консультации было ровно началом часа.

begin;

-- 1. Источник «Telegram» -------------------------------------------------------

alter table public.leads drop constraint if exists leads_source_check;
alter table public.leads add constraint leads_source_check
  check (source in ('Сайт', 'Вручную', 'Telegram'));

-- 2. Новые поля ---------------------------------------------------------------

alter table public.leads add column if not exists telegram_id       bigint;       -- id пользователя Telegram (из проверенного initData)
alter table public.leads add column if not exists telegram_username text;         -- @username без «@», может отсутствовать
alter table public.leads add column if not exists consultation_at   timestamptz;  -- начало консультации

-- 3. Защита от двойной записи -------------------------------------------------
-- Уникальные индексы срабатывают даже при одновременных запросах: второй INSERT получит ошибку 23505.

create unique index if not exists leads_consultation_slot_uniq
  on public.leads (consultation_at)
  where consultation_at is not null and status <> 'Отказ';

create unique index if not exists leads_telegram_active_uniq
  on public.leads (telegram_id)
  where telegram_id is not null and status = 'Записан на консультацию';

-- 4. Слоты — только начало часа (в Молдове смещение от UTC целое, так что это начало часа и по Кишинёву)

alter table public.leads drop constraint if exists leads_consultation_hour_check;
alter table public.leads add constraint leads_consultation_hour_check
  check (consultation_at is null or date_trunc('hour', consultation_at) = consultation_at);

commit;

-- Сообщаем Supabase API, что схема поменялась
notify pgrst, 'reload schema';
