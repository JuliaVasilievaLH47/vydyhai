-- Миграция 006: лимит заявок с формы сайта (аудит безопасности, M2).
-- Выполнить ОДИН раз в Supabase: SQL Editor → New query → вставить весь файл → Run.
-- Выполнять ДО загрузки нового кода на GitHub/Vercel: без таблицы форма заявки отвечает 503.
-- Повторный запуск безопасен. Откат: drop table public.lead_attempts;
--
-- Что делает:
--   Создаёт таблицу lead_attempts. api/lead.js пишет сюда каждую отправку формы
--   и считает их за 60 минут: больше 5 с одного адреса или больше 30 всего → 429.
--   Вместо IP хранится его HMAC-отпечаток: сам адрес в базе не лежит.

begin;

create table if not exists public.lead_attempts (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  ip_hash text not null constraint lead_attempts_ip_hash_check check (length(ip_hash) between 1 and 64)
);

create index if not exists lead_attempts_ip_at_idx on public.lead_attempts (ip_hash, at);
create index if not exists lead_attempts_at_idx on public.lead_attempts (at);

-- RLS без политик, как у остальных таблиц: доступ только у сервера с секретным ключом.
-- Плюс отбираем права у публичных ролей — второй замок на случай ошибки в RLS.
alter table public.lead_attempts enable row level security;
revoke all on public.lead_attempts from anon, authenticated;

commit;

-- Сообщаем Supabase API, что схема поменялась
notify pgrst, 'reload schema';
