-- 彩虹外链网盘 D1 数据库 - 增量建表（幂等，不删除已有数据）
-- 运行方式: wrangler d1 execute pan-db --file=./schema.ensure.sql
-- 说明: 全部使用 CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS，
--       pre_config 默认配置使用 INSERT OR IGNORE，已存在的键不会被覆盖。

-- 站点配置表 (key-value)
CREATE TABLE IF NOT EXISTS pre_config (
  k TEXT PRIMARY KEY,
  v TEXT
);

-- 文件元数据表 (与原项目 pre_file 完全对应)
CREATE TABLE IF NOT EXISTS pre_file (
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

-- 会员表 (与原项目 pre_user 完全对应)
CREATE TABLE IF NOT EXISTS pre_user (
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

-- 注意：pre_file 的索引 (idx_pre_file_hash/uid/ip) 在 scripts/d1-migrate.sh
--       补列完成后创建，因为旧库可能缺少 uid/ip 列，直接建索引会失败。

-- 默认配置数据（INSERT OR IGNORE：已存在键不覆盖，不重置管理员/存储配置）
INSERT OR IGNORE INTO pre_config (k, v) VALUES
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

-- 安装/恢复会话临时表（30 分钟后自动清理）
CREATE TABLE IF NOT EXISTS install_session (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  sql_text TEXT NOT NULL,
  pre_extract TEXT NOT NULL,
  storage_type TEXT,
  storage_fields TEXT,
  selected_config TEXT,
  source_url TEXT,
  fresh_install INTEGER DEFAULT 0,
  task_id TEXT,
  task_status TEXT,
  remote_source_url TEXT,
  remote_admin_user TEXT,
  remote_admin_password TEXT
);
CREATE INDEX IF NOT EXISTS idx_install_session_created_at ON install_session(created_at);

-- 注：pre_file 的三个索引移到 scripts/d1-migrate.sh（需先补齐列）