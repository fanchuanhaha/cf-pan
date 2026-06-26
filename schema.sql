-- 彩虹外链网盘 D1 数据库初始化
-- 运行方式: wrangler d1 execute pan-db --file=./schema.sql

DROP TABLE IF EXISTS pre_file;
DROP TABLE IF EXISTS pre_user;
DROP TABLE IF EXISTS pre_config;

-- 站点配置表 (key-value)
CREATE TABLE pre_config (
  k TEXT PRIMARY KEY,
  v TEXT
);

-- 文件元数据表 (与原项目 pre_file 完全对应)
CREATE TABLE pre_file (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  hash TEXT NOT NULL,
  addtime TEXT NOT NULL,
  lasttime TEXT,
  ip TEXT,
  hide INTEGER DEFAULT 0,
  pwd TEXT,
  uid INTEGER DEFAULT 0,
  block INTEGER DEFAULT 0,
  count INTEGER DEFAULT 0
);
CREATE INDEX idx_pre_file_hash ON pre_file(hash);
CREATE INDEX idx_pre_file_uid ON pre_file(uid);
CREATE INDEX idx_pre_file_ip ON pre_file(ip);

-- 会员表 (与原项目 pre_user 完全对应)
CREATE TABLE pre_user (
  uid INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT,
  openid TEXT,
  nickname TEXT,
  faceimg TEXT,
  level INTEGER DEFAULT 0,
  enable INTEGER DEFAULT 1,
  regip TEXT,
  loginip TEXT,
  addtime TEXT,
  lasttime TEXT
);

-- 默认配置数据
INSERT INTO pre_config (k, v) VALUES
  ('title', '彩虹外链网盘'),
  ('syskey', 'changeme_please'),
  ('admin_user', 'admin'),
  ('admin_pwd', '123456'),
  ('storage', 'r2'),
  ('uploadfile_type', '0'),
  ('downfile_type', '0'),
  ('downfile_protocol', '0'),
  ('downfile_domain', ''),
  ('upload_size', '10'),
  ('upload_limit', '0'),
  ('forcelogin', '0'),
  ('api_open', '0'),
  ('api_referer', ''),
  ('type_block', ''),
  ('name_block', ''),
  ('type_image', 'jpg|jpeg|png|gif|webp|bmp|svg'),
  ('type_video', 'mp4|mov|webm|flv|avi|mkv'),
  ('green_check', '0'),
  ('green_provider', ''),
  ('green_ak', ''),
  ('green_sk', ''),
  ('green_region', 'cn-beijing'),
  ('videoreview', '0'),
  ('version', '1001'),
  ('ip_type', '0'),
  ('blackip', ''),
  ('upload_max_filesize', ''),
  ('r2_public_url', ''),
  -- S3 存储配置
  ('s3_endpoint', ''),
  ('s3_region', ''),
  ('s3_bucket', ''),
  ('s3_ak', ''),
  ('s3_sk', ''),
  -- GitHub API 存储配置
  ('gh_owner', ''),
  ('gh_repo', ''),
  ('gh_token', ''),
  ('gh_ref', ''),
  ('gh_folder', ''),
  ('gh_api_base', 'https://api.github.com'),
  -- 安装标识 (0=未安装, 1=已安装)
  ('installed', '0');
