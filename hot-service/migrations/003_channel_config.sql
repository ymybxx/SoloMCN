-- 各渠道在页面上改过的配置。没有记录的渠道用代码里的默认值
create table hot.channel_config (
  channel text primary key,
  every_min int,                        -- 多久抓一次
  settings jsonb not null default '{}', -- 渠道自己的设置
  updated_at timestamptz not null default now()
);
