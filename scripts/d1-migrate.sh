#!/usr/bin/env bash
# =====================================================================
# D1 增量迁移脚本（GitHub Actions / 手动调用）
#   对比 expected 表结构与远程 D1 实际情况：
#   1. schema.ensure.sql 幂等建表 + INSERT OR IGNORE 默认配置（不覆盖已有值）
#   2. PRAGMA 对比缺失列 -> ALTER TABLE ADD COLUMN（不动已有数据）
#   3. CREATE INDEX IF NOT EXISTS
#
# 用法: bash ./scripts/d1-migrate.sh [wrangler.toml] [db-name]
# 依赖: CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID
# =====================================================================
set -euo pipefail

CONFIG="${1:-wrangler.spa.toml}"
DB_NAME="${2:-pan-db}"

# 期望表结构：(表名|列名:类型), 逗号分隔列
# 注意：SQLite ALTER TABLE ADD COLUMN 不能加 PRIMARY KEY / UNIQUE，
#       所以这里只列出非主键列。
declare -A EXPECTED=(
  ["pre_file"]="name:TEXT NOT NULL DEFAULT '',type:TEXT NOT NULL DEFAULT '',size:INTEGER NOT NULL DEFAULT 0,hash:TEXT NOT NULL DEFAULT '',addtime:TEXT NOT NULL DEFAULT '',lasttime:TEXT,ip:TEXT,hide:INTEGER DEFAULT 0,pwd:TEXT,uid:INTEGER DEFAULT 0,block:INTEGER DEFAULT 0,count:INTEGER DEFAULT 0"
  ["pre_user"]="type:TEXT,openid:TEXT,nickname:TEXT,faceimg:TEXT,level:INTEGER DEFAULT 0,enable:INTEGER DEFAULT 1,regip:TEXT,loginip:TEXT,addtime:TEXT,lasttime:TEXT"
  ["pre_config"]="v:TEXT"
  ["install_session"]="created_at:INTEGER NOT NULL DEFAULT 0,sql_text:TEXT NOT NULL DEFAULT '',pre_extract:TEXT NOT NULL DEFAULT '',storage_type:TEXT,storage_fields:TEXT,selected_config:TEXT,source_url:TEXT,fresh_install:INTEGER DEFAULT 0,task_id:TEXT,task_status:TEXT,remote_source_url:TEXT,remote_admin_user:TEXT,remote_admin_password:TEXT"
)

# 1) 先执行幂等建表（CREATE TABLE IF NOT EXISTS + INSERT OR IGNORE）
echo "==> [1/3] 执行 schema.ensure.sql（幂等创建缺失表 + 默认配置）"
npx wrangler d1 execute "$DB_NAME" --config "$CONFIG" --remote --file=./schema.ensure.sql

# 2) 逐表对比列结构
echo "==> [2/3] 对比列结构"
CHANGED=0
for table in "${!EXPECTED[@]}"; do
  # 远程现有列（兼容 wrangler 两种 rows 结构：[[cid,name,...],...] 或 [{...}]
  EXISTING_COLS=$(npx wrangler d1 execute "$DB_NAME" --config "$CONFIG" --remote --json --command "PRAGMA table_info($table)" 2>/dev/null \
    | jq -r '.. | .rows? // empty | .[]? | if type == "array" then .[1] else .name end' 2>/dev/null | tr '\n' ',' | sed 's/,$//')
  if [ -z "$EXISTING_COLS" ]; then
    echo "    表 $table 不存在或无法读取，跳过列迁移（由 schema.ensure.sql 创建）"
    continue
  fi
  # 逐列检查
  IFS=',' read -r -a COLS <<< "${EXPECTED[$table]}"
  for coldef in "${COLS[@]}"; do
    colname="${coldef%%:*}"
    colddl="${coldef#*:}"
    if ! echo "$EXISTING_COLS" | tr ',' '\n' | grep -qx "$colname"; then
      echo "    + $table.$colname ($colddl)"
      npx wrangler d1 execute "$DB_NAME" --config "$CONFIG" --remote --command "ALTER TABLE $table ADD COLUMN $colname $colddl"
      CHANGED=1
    fi
  done
done
if [ "$CHANGED" = "0" ]; then
  echo "    所有列均已存在，无需变更"
fi

# 3) 建索引（此时列已齐全）
echo "==> [3/3] 确保索引存在"
npx wrangler d1 execute "$DB_NAME" --config "$CONFIG" --remote --command "CREATE INDEX IF NOT EXISTS idx_pre_file_hash ON pre_file(hash)"
npx wrangler d1 execute "$DB_NAME" --config "$CONFIG" --remote --command "CREATE INDEX IF NOT EXISTS idx_pre_file_uid ON pre_file(uid)"
npx wrangler d1 execute "$DB_NAME" --config "$CONFIG" --remote --command "CREATE INDEX IF NOT EXISTS idx_pre_file_ip ON pre_file(ip)"

echo "==> 完成：数据保留，仅增量更新"