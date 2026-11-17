-- Миграция 007: один адрес не может закрыть вход или форму для всех (аудит безопасности, N2 и N3).
-- Выполнить ОДИН раз в Supabase: SQL Editor → New query → вставить весь файл → Run.
-- Выполнять ДО загрузки нового кода на GitHub/Vercel: без колонки вход в админку и форма заявки отвечают 503.
-- Старый код колонку не замечает, поэтому миграцию можно применить заранее.
-- Повторный запуск безопасен. Откат:
--   alter table public.login_attempts drop column passed;
--   alter table public.lead_attempts  drop column passed;
--
-- Что делает:
--   Добавляет в login_attempts и lead_attempts колонку passed: true — попытка прошла лимит адреса.
--   Общий лимит (100 входов за 15 минут, 30 заявок за час) считает только такие попытки
--   (countAttempt в api/_lib.js). Заблокированные попытки одного адреса в общий счётчик больше не попадают.
--   Старые записи получают false: в общий счётчик они не идут, через 24 часа их удаляет уборка.

begin;

alter table public.login_attempts add column if not exists passed boolean not null default false;
alter table public.lead_attempts  add column if not exists passed boolean not null default false;

-- Общий счётчик читает только passed = true за последнее окно
create index if not exists login_attempts_passed_at_idx on public.login_attempts (at) where passed;
create index if not exists lead_attempts_passed_at_idx  on public.lead_attempts (at) where passed;

commit;

-- Сообщаем Supabase API, что схема поменялась
notify pgrst, 'reload schema';
