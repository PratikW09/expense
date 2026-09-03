-- =========================================================================
-- Supabase SQL Schema for Expense & Split Tracker Users
-- Run this in your Supabase Project -> SQL Editor
-- =========================================================================

create table if not exists public.users (
  id uuid default gen_random_uuid() primary key,
  google_id text unique not null,
  email text unique not null,
  name text,
  picture text,
  encrypted_refresh_token text not null,
  spreadsheet_id text,
  created_at timestamptz default now(),
  last_login_at timestamptz default now()
);

-- Create indexes for quick lookups
create index if not exists idx_users_google_id on public.users(google_id);
create index if not exists idx_users_email on public.users(email);

-- Enable Row Level Security (RLS)
alter table public.users enable row level security;

-- Service role has full access
create policy "Allow service role full access" on public.users
  for all using (true);
