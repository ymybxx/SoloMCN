-- 各渠道定时抓取的内容。同一条再次抓到时更新内容和数字，保留 first_seen
-- 时间都是 UTC 的 Unix 秒，JSON 存成文本
create table entries (
  channel text not null,
  item_id text not null,                 -- 渠道内唯一，热榜词条用标题
  title text not null,                   -- 一行短标题，用于列表展示
  text text,                             -- 原文全文
  url text,
  links text not null default '[]',      -- 原文里的链接（JSON 数组）
  author text,
  published_at real,
  metrics text not null default '{}',    -- 平台原始数字，各渠道不同（JSON）
  score real not null default 0,         -- 0–100 的热度分，由渠道自己算
  extra text not null default '{}',      -- 渠道特有的信息（JSON）
  first_seen real not null,
  last_seen real not null,
  primary key (channel, item_id)
);
create index entries_published_idx on entries (channel, published_at desc);

create table runs (
  id integer primary key autoincrement,
  channel text not null,
  started_at real not null,
  finished_at real,
  count integer,
  error text
);
create index runs_channel_idx on runs (channel, started_at desc);

-- 各渠道在页面上改过的配置。没有记录的渠道用代码里的默认值
create table channel_config (
  channel text primary key,
  every_min integer,                     -- 多久抓一次
  settings text not null default '{}',   -- 渠道自己的设置（JSON）
  updated_at real not null
);
