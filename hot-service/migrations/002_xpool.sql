-- 推特号池：账号、每日用量、状态变化记录
create table x_accounts (
  id integer primary key autoincrement,
  username text not null,
  auth_token text not null unique,
  cookies text not null,
  -- active 可用 / cooldown 暂时不可用，按退避间隔重测 / locked 账号被锁，等人工解锁 / invalid Cookie 已失效
  status text not null default 'active' check (status in ('active', 'cooldown', 'locked', 'invalid')),
  status_reason text,
  status_since real not null,
  failures integer not null default 0,  -- 当前状态下连续失败的次数，决定下次重测的间隔
  next_check_at real,                   -- invalid 为空，不再重测
  last_ok_at real,
  last_used_at real,
  created_at real not null,
  updated_at real not null
);
create unique index x_accounts_username_key on x_accounts (lower(username));
create index x_accounts_next_check_idx on x_accounts (next_check_at) where status <> 'invalid';

create table x_account_usage (
  account_id integer not null references x_accounts (id) on delete cascade,
  day text not null,  -- 本地日期 YYYY-MM-DD
  requests integer not null default 0,
  primary key (account_id, day)
);

-- 账号删除后保留记录（account_id 置空，username 留着），用来统计账号能活多久、多久能恢复
create table x_account_events (
  id integer primary key autoincrement,
  account_id integer references x_accounts (id) on delete set null,
  username text not null,
  at real not null,
  source text not null check (source in ('import', 'check', 'request', 'manual')),
  event text not null,
  detail text
);
create index x_account_events_at_idx on x_account_events (at desc);
create index x_account_events_account_idx on x_account_events (account_id, at desc);
