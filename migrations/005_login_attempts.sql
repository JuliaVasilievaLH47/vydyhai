-- Миграция 005: лимит попыток входа в админку (аудит безопасности, M1).
-- Выполнить ОДИН раз в Supabase: SQL Editor → New query → вставить весь файл → Run.
-- Выполнять ДО загрузки нового кода на GitHub/Vercel: без таблицы вход в админку отвечает 503.
-- Повторный запуск безопасен. Откат: drop table public.login_attempts;
--
-- Что делает:
--   Создаёт таблицу login_attempts. api/login.js пишет сюда каждую попытку входа
--   и считает попытки за 15 минут: больше 10 с одного адреса или больше 100 всего → 429.
--   Вместо IP хранится его HMAC-отпечаток: сам адрес в базе не лежит.

begin;

create table if not exists public.login_attempts (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  ip_hash text not null constraint login_attempts_ip_hash_check check (length(ip_hash) between 1 and 64)
);

create index if not exists login_attempts_ip_at_idx on public.login_attempts (ip_hash, at);
create index if not exists login_attempts_at_idx on public.login_attempts (at);

-- RLS без политик, как у остальных таблиц: доступ только у сервера с секретным ключом.
-- Плюс отбираем права у публичных ролей — второй замок на случай ошибки в RLS.
alter table public.login_attempts enable row level security;
revoke all on public.login_attempts from anon, authenticated;

commit;

-- Сообщаем Supabase API, что схема поменялась
notify pgrst, 'reload schema';
