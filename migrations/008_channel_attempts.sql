-- Миграция 008: лимит заявок голосового агента и записей Mini App (аудит безопасности, N5).
-- Выполнить ОДИН раз в Supabase: SQL Editor → New query → вставить весь файл → Run.
-- Выполнять ДО загрузки нового кода на GitHub/Vercel: без таблиц голосовой агент и Mini App отвечают 503.
-- Старый код таблицы не замечает, поэтому миграцию можно применить заранее.
-- Повторный запуск безопасен. Откат:
--   drop table public.voice_attempts;
--   drop table public.app_attempts;
--
-- Что делает:
--   Создаёт две таблицы с тем же устройством, что lead_attempts (миграции 006, 007).
--   Отдельные таблицы, чтобы спам в одном канале не закрывал другие: общий лимит считается по таблице.
--   voice_attempts — api/voice-lead.js: больше 2 заявок с одного телефона или 10 всего за 60 минут → отказ.
--     Все запросы приходят с серверов ElevenLabs, поэтому лимит по IP не годится, считаем по телефону.
--   app_attempts — api/app.js (POST): больше 5 попыток записи с одного аккаунта Telegram или 10 всего за 60 минут → 429.
--   В ip_hash лежит HMAC-отпечаток телефона или telegram_id, а не сами данные.

begin;

create table if not exists public.voice_attempts (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  ip_hash text not null constraint voice_attempts_ip_hash_check check (length(ip_hash) between 1 and 64),
  passed  boolean not null default false
);

create index if not exists voice_attempts_ip_at_idx on public.voice_attempts (ip_hash, at);
create index if not exists voice_attempts_at_idx on public.voice_attempts (at);
create index if not exists voice_attempts_passed_at_idx on public.voice_attempts (at) where passed;

create table if not exists public.app_attempts (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  ip_hash text not null constraint app_attempts_ip_hash_check check (length(ip_hash) between 1 and 64),
  passed  boolean not null default false
);

create index if not exists app_attempts_ip_at_idx on public.app_attempts (ip_hash, at);
create index if not exists app_attempts_at_idx on public.app_attempts (at);
create index if not exists app_attempts_passed_at_idx on public.app_attempts (at) where passed;

-- RLS без политик, как у остальных таблиц: доступ только у сервера с секретным ключом.
-- Плюс отбираем права у публичных ролей — второй замок на случай ошибки в RLS.
alter table public.voice_attempts enable row level security;
alter table public.app_attempts enable row level security;
revoke all on public.voice_attempts from anon, authenticated;
revoke all on public.app_attempts from anon, authenticated;

commit;

-- Сообщаем Supabase API, что схема поменялась
notify pgrst, 'reload schema';
