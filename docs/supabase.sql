-- JARVIS cloud mirror for Supabase.
-- Run this once in the Supabase SQL editor, then set SUPABASE_URL and
-- SUPABASE_SERVICE_ROLE_KEY. The service-role key bypasses RLS; never ship it
-- to a browser or mobile client. These tables are for a single trusted owner.

create table if not exists public.jarvis_memories (
  id text primary key,
  content text not null,
  kind text not null default 'note',
  source text,
  source_ref text,
  importance double precision not null default 0.5,
  sensitivity text not null default 'private',
  pinned integer not null default 0,
  hash text,
  access_count integer not null default 0,
  last_accessed_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.jarvis_profile_facts (
  id text primary key,
  key text not null,
  value text not null,
  category text not null default 'general',
  confidence double precision not null default 0.7,
  source text,
  sensitivity text not null default 'private',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_confirmed_at timestamptz,
  superseded_by text
);
create unique index if not exists jarvis_profile_active_key
  on public.jarvis_profile_facts(key) where superseded_by is null;

create table if not exists public.jarvis_tasks (
  id text primary key,
  title text not null,
  notes text,
  due_at timestamptz,
  recurrence text,
  priority integer not null default 2,
  status text not null default 'open',
  channel text,
  notified_at timestamptz,
  source text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create or replace function public.jarvis_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists jarvis_memories_touch on public.jarvis_memories;
create trigger jarvis_memories_touch
  before update on public.jarvis_memories
  for each row execute function public.jarvis_touch_updated_at();

drop trigger if exists jarvis_profile_facts_touch on public.jarvis_profile_facts;
create trigger jarvis_profile_facts_touch
  before update on public.jarvis_profile_facts
  for each row execute function public.jarvis_touch_updated_at();

drop trigger if exists jarvis_tasks_touch on public.jarvis_tasks;
create trigger jarvis_tasks_touch
  before update on public.jarvis_tasks
  for each row execute function public.jarvis_touch_updated_at();

-- No anon/authenticated policies: only the service role (used by the
-- assistant) may read or write. If you later add a UI, add narrow policies.
alter table public.jarvis_memories enable row level security;
alter table public.jarvis_profile_facts enable row level security;
alter table public.jarvis_tasks enable row level security;

create index if not exists jarvis_memories_updated on public.jarvis_memories(updated_at);
create index if not exists jarvis_profile_updated on public.jarvis_profile_facts(updated_at);
create index if not exists jarvis_tasks_updated on public.jarvis_tasks(updated_at);
