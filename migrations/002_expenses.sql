-- Миграция 002: модуль «Расходы» — чеки, распознанные через Gemini.
-- Выполнить ОДИН раз в Supabase: SQL Editor → New query → вставить весь файл → Run.
-- Выполнять ДО загрузки нового кода на GitHub/Vercel.
-- Повторный запуск безопасен: существующие данные не меняются.
--
-- Что делает:
--   1. Создаёт таблицу expenses (RLS включён, политик нет — доступ только у сервера).
--   2. Создаёт приватный bucket receipts для оригиналов чеков (до 5 МБ, только JPEG/PNG/WebP/PDF).
--   3. Проверяет, что RLS на файлах Storage включён и bucket receipts не открыт политиками.

begin;

-- 1. Таблица расходов ---------------------------------------------------------
-- Категории: этот же список есть в api/_lib.js и admin.html (CATEGORIES) и в supabase.sql.

create table if not exists public.expenses (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  expense_date date not null,                       -- дата из чека
  amount       numeric(12,2) not null
               constraint expenses_amount_check check (amount > 0),
  currency     text not null default 'MDL'
               constraint expenses_currency_check check (currency ~ '^[A-Z]{3}$'),
  vendor       text not null default '',            -- продавец (может быть не указан в чеке)
  category     text not null
               constraint expenses_category_check check (category in (
                 'Реклама', 'Печать материалов', 'Консультанты', 'Сервисы и подписки', 'Прочее'
               )),
  file_path    text not null,                       -- путь к оригиналу в bucket receipts
  file_type    text not null
               constraint expenses_file_type_check check (file_type in (
                 'image/jpeg', 'image/png', 'image/webp', 'application/pdf'
               ))
);

create index if not exists expenses_date_idx on public.expenses (expense_date desc);

-- Как и у leads: RLS без политик, доступ только у сервера с секретным ключом
alter table public.expenses enable row level security;

-- 2. Приватный bucket для оригиналов ------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 5242880,
        array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do update
  set public             = false,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 3. Проверка защиты файлов ---------------------------------------------------
-- В Supabase RLS на storage.objects включён всегда. Политик для receipts не создаём:
-- без них ни anon, ни authenticated не могут читать/писать файлы, работает только серверный ключ.

do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'storage.objects'::regclass) then
    raise exception 'RLS на storage.objects выключен — файлы были бы доступны всем. Миграция отменена.';
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and (coalesce(qual, '') ilike '%receipts%' or coalesce(with_check, '') ilike '%receipts%')
  ) then
    raise exception 'На storage.objects есть политики, упоминающие bucket receipts. Удалите их (Storage → Policies), иначе чеки могут стать доступны. Миграция отменена.';
  end if;
end $$;

commit;

-- Сообщаем Supabase API, что схема поменялась
notify pgrst, 'reload schema';
