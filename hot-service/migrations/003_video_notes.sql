-- 视频素材的字幕和拆解报告，按平台和视频 id 存，和素材绑定：拿过一次，精选、出题、调研都复用，
-- 不重复下载、不重复拆解；手动可以重新拉字幕、重新拆解
create table video_notes (
  platform text not null,   -- youtube
  video_id text not null,
  title text,
  transcript text,          -- 整理过的纯文字字幕，每段开头带 [分:秒]
  transcript_lang text,
  transcript_source text,   -- manual 作者上传的 / auto 自动生成的
  transcript_at real,
  transcript_error text,    -- 上次没拿到的原因（拿到了就清空）
  teardown text,            -- Claude 写的拆解报告（Markdown）
  teardown_at real,
  primary key (platform, video_id)
);
