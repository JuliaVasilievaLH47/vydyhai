-- Выполнить один раз в Supabase: SQL Editor → New query → вставить → Run

create table if not exists public.leads (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  name       text not null,
  phone      text not null,
  age        int,
  topic      text,
  comment    text,
  status     text not null default 'новая'
             check (status in ('новая', 'в работе', 'закрыта'))
);

create index if not exists leads_created_at_idx on public.leads (created_at desc);
create index if not exists leads_status_idx on public.leads (status);

-- RLS включён и политик нет: публичный (anon) ключ не может ни читать, ни писать заявки.
-- Доступ есть только у сервера на Vercel с секретным ключом.
alter table public.leads enable row level security;
