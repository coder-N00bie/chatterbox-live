-- Cooliomatic admin mode: IP/country logging, kicks, device + IP bans.
-- The admin code itself is set separately (see bottom) and is never stored in this repo.

create extension if not exists pgcrypto with schema extensions;

alter table public.devices
  add column if not exists ip text,
  add column if not exists country text,
  add column if not exists kicked_at timestamptz;

create table if not exists public.device_ips (
  device_id uuid not null references public.devices(id) on delete cascade,
  ip text not null,
  country text,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key (device_id, ip)
);
create table if not exists public.bans (
  kind text not null check (kind in ('ip', 'device')),
  value text not null,
  label text,
  created_at timestamptz not null default now(),
  primary key (kind, value)
);
create table if not exists public.admin_conf (
  id int primary key default 1 check (id = 1),
  code_hash text not null
);
create table if not exists public.admin_fails (ip text, at timestamptz not null default now());

alter table public.device_ips enable row level security;
alter table public.bans enable row level security;
alter table public.admin_conf enable row level security;
alter table public.admin_fails enable row level security;
revoke all on table public.device_ips, public.bans, public.admin_conf, public.admin_fails from anon, authenticated;

-- who is calling (Supabase sits behind Cloudflare, which sets these)
create or replace function public._hdr(k text) returns text language sql stable as $$
  select nullif(current_setting('request.headers', true), '')::json ->> k
$$;
create or replace function public._req_ip() returns text language sql stable as $$
  select left(coalesce(
    public._hdr('cf-connecting-ip'),
    nullif(trim(split_part(coalesce(public._hdr('x-forwarded-for'), ''), ',', 1)), ''),
    public._hdr('x-real-ip')), 64)
$$;
create or replace function public._req_country() returns text language sql stable as $$
  select nullif(nullif(upper(left(public._hdr('cf-ipcountry'), 2)), 'XX'), 'T1')
$$;
create or replace function public._is_banned(p_id uuid, p_ip text) returns boolean language sql stable as $$
  select exists (select 1 from public.bans
                 where (kind = 'device' and value = p_id::text) or (kind = 'ip' and value = p_ip))
$$;

-- record where a device is coming from
create or replace function public._seen(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_ip text := public._req_ip(); v_cc text := public._req_country();
begin
  if v_ip is null then return; end if;
  update public.devices set ip = v_ip, country = coalesce(v_cc, country), last_seen = now() where id = p_id;
  if found then
    insert into public.device_ips(device_id, ip, country) values (p_id, v_ip, v_cc)
    on conflict (device_id, ip) do update set last_seen = now(), country = coalesce(excluded.country, device_ips.country);
  end if;
end $$;

create or replace function public.touch_device(p_id uuid, p_name text, p_location text)
returns json language plpgsql security definer set search_path = public as $$
declare r public.devices;
begin
  insert into public.devices(id, name, location)
  values (p_id, left(trim(p_name), 24), left(trim(coalesce(p_location,'')), 24))
  on conflict (id) do update
    set name = excluded.name, location = excluded.location,
        visits = public.devices.visits + 1, last_seen = now()
  returning * into r;
  perform public._seen(p_id);
  return json_build_object('name', r.name, 'location', r.location, 'visits', r.visits, 'first_seen', r.first_seen,
                           'banned', public._is_banned(p_id, public._req_ip()));
end $$;

-- polled by every open tab: am I banned / when was I last kicked?
create or replace function public.check_me(p_id uuid)
returns json language plpgsql security definer set search_path = public as $$
declare k timestamptz;
begin
  perform public._seen(p_id);
  select kicked_at into k from public.devices where id = p_id;
  return json_build_object('banned', public._is_banned(p_id, public._req_ip()), 'kicked_at', k);
end $$;

-- admin helpers: wrong codes are counted per IP, 8 wrong tries locks that IP out for 15 minutes
create or replace function public._admin_ok(p_code text) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare v_ip text := coalesce(public._req_ip(), '?'); h text;
begin
  if (select count(*) from public.admin_fails where ip = v_ip and at > now() - interval '15 minutes') >= 8 then
    return false;
  end if;
  select code_hash into h from public.admin_conf where id = 1;
  if h is not null and p_code is not null and crypt(p_code, h) = h then return true; end if;
  insert into public.admin_fails(ip) values (v_ip);
  delete from public.admin_fails where at < now() - interval '1 day';
  return false;
end $$;

create or replace function public.admin_list(p_code text)
returns json language plpgsql security definer set search_path = public as $$
begin
  if not public._admin_ok(p_code) then return json_build_object('error', 'nope'); end if;
  return json_build_object(
    'now', now(),
    'devices', coalesce((
      select json_agg(x order by x.last_seen desc) from (
        select d.id, d.name, d.location, d.ip, d.country, d.visits, d.first_seen, d.last_seen,
               (select json_agg(json_build_object('ip', i.ip, 'country', i.country, 'last_seen', i.last_seen) order by i.last_seen desc)
                  from public.device_ips i where i.device_id = d.id) as ips,
               exists (select 1 from public.bans b where b.kind = 'device' and b.value = d.id::text) as dev_banned,
               exists (select 1 from public.bans b where b.kind = 'ip' and b.value = d.ip) as ip_banned
        from public.devices d order by d.last_seen desc limit 500) x), '[]'::json),
    'bans', coalesce((select json_agg(b order by b.created_at desc) from public.bans b), '[]'::json));
end $$;

create or replace function public.admin_kick(p_code text, p_device uuid)
returns json language plpgsql security definer set search_path = public as $$
begin
  if not public._admin_ok(p_code) then return json_build_object('error', 'nope'); end if;
  update public.devices set kicked_at = now() where id = p_device;
  return json_build_object('ok', true);
end $$;

create or replace function public.admin_ban(p_code text, p_kind text, p_value text, p_label text)
returns json language plpgsql security definer set search_path = public as $$
begin
  if not public._admin_ok(p_code) then return json_build_object('error', 'nope'); end if;
  if p_kind not in ('ip', 'device') or coalesce(trim(p_value), '') = '' then return json_build_object('error', 'bad ban'); end if;
  if p_kind = 'ip' and p_value = public._req_ip() then return json_build_object('error', 'that is your own IP'); end if;
  insert into public.bans(kind, value, label) values (p_kind, trim(p_value), left(p_label, 60))
  on conflict (kind, value) do nothing;
  return json_build_object('ok', true);
end $$;

create or replace function public.admin_unban(p_code text, p_kind text, p_value text)
returns json language plpgsql security definer set search_path = public as $$
begin
  if not public._admin_ok(p_code) then return json_build_object('error', 'nope'); end if;
  delete from public.bans where kind = p_kind and value = p_value;
  return json_build_object('ok', true);
end $$;

create or replace function public.admin_set_code(p_code text, p_new text)
returns json language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public._admin_ok(p_code) then return json_build_object('error', 'nope'); end if;
  if char_length(coalesce(p_new, '')) < 8 then return json_build_object('error', 'make it at least 8 characters'); end if;
  update public.admin_conf set code_hash = crypt(p_new, gen_salt('bf')) where id = 1;
  return json_build_object('ok', true);
end $$;

-- lock everything down, then open only the public entry points
revoke all on function public._hdr(text), public._req_ip(), public._req_country(), public._is_banned(uuid, text),
  public._seen(uuid), public._admin_ok(text) from public, anon, authenticated;
revoke all on function public.check_me(uuid), public.admin_list(text), public.admin_kick(text, uuid),
  public.admin_ban(text, text, text, text), public.admin_unban(text, text, text), public.admin_set_code(text, text) from public;
grant execute on function public.touch_device(uuid, text, text), public.check_me(uuid),
  public.admin_list(text), public.admin_kick(text, uuid), public.admin_ban(text, text, text, text),
  public.admin_unban(text, text, text), public.admin_set_code(text, text) to anon, authenticated;

-- set the admin code once (run separately, don't commit the real code):
-- insert into public.admin_conf(id, code_hash) values (1, extensions.crypt('YOUR-CODE', extensions.gen_salt('bf')))
--   on conflict (id) do update set code_hash = excluded.code_hash;
