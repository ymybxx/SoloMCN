-- 各渠道定时抓取的内容。同一条再次抓到时更新内容和数字，保留 first_seen
create schema if not exists hot;

create table hot.entries (
  channel text not null,
  item_id text not null,             -- 渠道内唯一，比如推文 id
  title text not null,               -- 一行短标题，用于列表展示
  text text,                         -- 原文全文
  url text,
  links jsonb not null default '[]', -- 原文里的链接（已展开）
  author text,
  published_at timestamptz,
  metrics jsonb not null default '{}',  -- 平台原始数字，各渠道不同
  score real not null default 0,        -- 0–100 的热度分，由渠道自己算
  extra jsonb not null default '{}',    -- 渠道特有的信息
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key (channel, item_id)
);
create index entries_published_idx on hot.entries (channel, published_at desc);

create table hot.runs (
  id bigint generated always as identity primary key,
  channel text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  count int,
  error text
);
create index runs_channel_idx on hot.runs (channel, started_at desc);
