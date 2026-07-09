// 彩虹外链网盘 - SQL 预提取服务
// 仅解析 SQL 中的 pre_config 和 pre_file 统计，不写入 D1
// 用于 /install 流程的第一步：上传 SQL 后展示可勾选的配置项

/** 解析出的 pre_config 字典 */
export type PreConfigMap = Record<string, string>;

/** SQL 预提取结果 */
export interface SqlPreExtractResult {
  /** 解析出的 pre_config 键值对 */
  preConfig: PreConfigMap;
  /** pre_file 记录数（用于显示"预计下载 N 个文件"） */
  fileCount: number;
  /** 警告信息（如 storage=local） */
  warnings: string[];
  /** 无法解析的 INSERT pre_config 语句数（用于提示用户） */
  unparseableConfigCount: number;
  /** 推测的存储类型（当 storage=local 但其他存储字段有完整配置时） */
  suggestedStorage?: string;
  /** 推测存储类型对应的字段（用于自动填表） */
  suggestedStorageFields?: Record<string, string>;
}

/**
 * 把 SQL 文本切成语句数组（按分号，且忽略字符串内的分号）
 * 同时去除行首 -- 注释
 * 比 restore.ts 的 splitSqlStatements 简单，预提取不需要那么严格
 */
function splitStatements(sql: string): string[] {
  const result: string[] = [];
  let buf = '';
  let inString = false;
  let stringChar = '';
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inString) {
      buf += ch;
      // 处理转义：\' 或 \\
      if (ch === '\\' && i + 1 < sql.length) {
        buf += sql[++i];
        continue;
      }
      if (ch === stringChar) {
        inString = false;
      }
    } else {
      // 行首注释：-- 到换行为止
      if (ch === '-' && sql[i + 1] === '-') {
        while (i < sql.length && sql[i] !== '\n') i++;
        if (i < sql.length) buf += '\n'; // 保留换行
        continue;
      }
      // /* ... */ 块注释
      if (ch === '/' && sql[i + 1] === '*') {
        i += 2;
        while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
        i += 1; // 跳过 /
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        inString = true;
        stringChar = ch;
        buf += ch;
      } else if (ch === ';') {
        const trimmed = buf.trim();
        if (trimmed.length > 0) result.push(trimmed);
        buf = '';
      } else {
        buf += ch;
      }
    }
  }
  const tail = buf.trim();
  if (tail.length > 0) result.push(tail);
  return result;
}

/**
 * 解析 INSERT INTO pre_config ... VALUES (...) 语句
 * 支持两种常见格式：
 *   1) INSERT INTO `pre_config` VALUES ('k1','v1'),('k2','v2'),...
 *   2) INSERT INTO `pre_config` (`k`,`v`) VALUES ('k1','v1'),('k2','v2'),...
 * 返回解析出的 k-v 列表；返回 null 表示无法解析
 */
function parseInsertPreConfig(stmt: string): Array<[string, string]> | null {
  // 匹配 INSERT INTO ... pre_config
  const intoMatch = stmt.match(/^INSERT\s+INTO\s+[`"]?pre_config[`"]?\s*(?:\(([^)]+)\))?\s*VALUES\s*(.+)$/is);
  if (!intoMatch) return null;

  const colsRaw = intoMatch[1];
  const valuesRaw = intoMatch[2];

  // 决定 k/v 的列索引
  let kIdx = 0;
  let vIdx = 1;
  if (colsRaw) {
    const cols = colsRaw.split(',').map(c => c.trim().replace(/^[`"]|[`"]$/g, '').toLowerCase());
    kIdx = cols.indexOf('k');
    vIdx = cols.indexOf('v');
    if (kIdx < 0 || vIdx < 0) {
      // 没 k/v 列时不支持
      return null;
    }
  }

  // 切分 values 列表：按顶层逗号
  const groups = splitTopLevelCommas(valuesRaw);
  if (groups.length === 0) return null;

  const pairs: Array<[string, string]> = [];
  for (const g of groups) {
    const items = parseTuple(g);
    if (items.length <= Math.max(kIdx, vIdx)) {
      return null; // 列数不匹配 → 视为无法解析
    }
    const k = unquote(items[kIdx]);
    const v = unquote(items[vIdx]);
    if (k === null || v === null) return null;
    pairs.push([k, v]);
  }
  return pairs;
}

/** 把 "('a','b'),('c','d')" 切成 ["('a','b')", "('c','d')"]（按顶层逗号） */
function splitTopLevelCommas(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = '';
  let inStr = false;
  let strCh = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      buf += ch;
      if (ch === '\\' && i + 1 < s.length) {
        buf += s[++i];
        continue;
      }
      if (ch === strCh) inStr = false;
    } else {
      if (ch === "'" || ch === '"') {
        inStr = true;
        strCh = ch;
        buf += ch;
      } else if (ch === '(') {
        depth++;
        buf += ch;
      } else if (ch === ')') {
        depth--;
        buf += ch;
      } else if (ch === ',' && depth === 0) {
        out.push(buf.trim());
        buf = '';
      } else {
        buf += ch;
      }
    }
  }
  const tail = buf.trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

/** 把 "('a', 'b', NULL)" 切成 ["'a'", "'b'", "NULL"] */
function parseTuple(s: string): string[] {
  let t = s.trim();
  if (t.startsWith('(')) t = t.substring(1);
  if (t.endsWith(')')) t = t.substring(0, t.length - 1);
  const out: string[] = [];
  let buf = '';
  let inStr = false;
  let strCh = '';
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      buf += ch;
      if (ch === '\\' && i + 1 < t.length) {
        buf += t[++i];
        continue;
      }
      if (ch === strCh) inStr = false;
    } else {
      if (ch === "'" || ch === '"') {
        inStr = true;
        strCh = ch;
        buf += ch;
      } else if (ch === ',') {
        out.push(buf.trim());
        buf = '';
      } else {
        buf += ch;
      }
    }
  }
  const tail = buf.trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

/** 去掉 SQL 字符串/数字/NULL 的字面量外壳 */
function unquote(s: string): string | null {
  if (s === null) return null;
  const t = s.trim();
  if (t.toUpperCase() === 'NULL') return '';
  // 字符串 'foo' 或 "foo"
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    let inner = t.substring(1, t.length - 1);
    // 处理常见转义
    inner = inner.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
    return inner;
  }
  // 数字字面量
  if (/^-?\d+(\.\d+)?$/.test(t)) {
    return t;
  }
  // 其它字面量（十六进制、binary）暂不支持
  return null;
}

/** 统计 pre_file 表的 INSERT 语句条数（粗略：数行数） */
function countPreFileRows(stmt: string): number {
  // 支持 INSERT INTO `pre_file` VALUES (...),(...),(...);
  // 也支持 INSERT INTO `pre_file` (...) VALUES (...),(...);
  const m = stmt.match(/^INSERT\s+INTO\s+[`"]?pre_file[`"]?\s*(?:\([^)]+\))?\s*VALUES\s*(.+?);?\s*$/is);
  if (!m) return 0;
  const groups = splitTopLevelCommas(m[1]);
  return groups.length;
}

/**
 * 主入口：解析 SQL 文本，提取 pre_config 字典和 pre_file 统计
 */
export function extractFromSql(sqlText: string): SqlPreExtractResult {
  const preConfig: PreConfigMap = {};
  const warnings: string[] = [];
  let unparseableConfigCount = 0;
  let fileCount = 0;

  const stmts = splitStatements(sqlText);

  for (const stmt of stmts) {
    const head = stmt.substring(0, 60).toLowerCase();
    // pre_config
    if (/^insert\s+into\s+[`"]?pre_config[`"]?/i.test(stmt)) {
      const pairs = parseInsertPreConfig(stmt);
      if (pairs) {
        for (const [k, v] of pairs) {
          preConfig[k] = v;
        }
      } else {
        unparseableConfigCount++;
      }
      continue;
    }
    // pre_file
    if (/^insert\s+into\s+[`"]?pre_file[`"]?/i.test(stmt)) {
      fileCount += countPreFileRows(stmt);
      continue;
    }
  }

  // 常见警告
  if (preConfig['storage'] === 'local') {
    warnings.push('检测到 storage=local（原 PHP 项目配置），本系统不支持。请在下一步重新选择 R2 / S3 / GitHub / WebDAV / 又拍云 / 七牛云。');
  }
  if (preConfig['storage'] && preConfig['storage'] !== 'local') {
    const validTypes = ['r2', 's3', 'github', 'webdav', 'upyun', 'qiniu'];
    if (!validTypes.includes(preConfig['storage'])) {
      warnings.push(`检测到 storage="${preConfig['storage']}"，本系统不支持。建议重新选择存储类型。`);
    }
  }
  if (unparseableConfigCount > 0) {
    warnings.push(`有 ${unparseableConfigCount} 条 pre_config INSERT 语句无法解析（如使用了非标准语法），请手动填写。`);
  }
  if (fileCount === 0) {
    warnings.push('未在 SQL 中检测到 pre_file 表数据，可能无法从原站点下载文件。');
  }

  // 智能推测存储类型：若 storage=local 但其他存储有完整配置，提示用户切换
  const result: SqlPreExtractResult = {
    preConfig,
    fileCount,
    warnings,
    unparseableConfigCount,
  };
  if (preConfig['storage'] === 'local' || !preConfig['storage']) {
    // 检测各存储类型是否字段完整
    const checks: Array<{ name: string; required: string[] }> = [
      { name: 'r2', required: [] }, // R2 不需要额外字段
      { name: 'qiniu', required: ['qiniu_ak', 'qiniu_sk', 'qiniu_bucket'] },
      { name: 'upyun', required: ['upyun_bucket', 'upyun_operator', 'upyun_password'] },
      { name: 'webdav', required: ['webdav_endpoint', 'webdav_user', 'webdav_pass'] },
      { name: 's3', required: ['s3_endpoint', 's3_bucket', 's3_ak', 's3_sk'] },
      { name: 'github', required: ['gh_owner', 'gh_repo', 'gh_token'] },
    ];
    for (const c of checks) {
      const missing = c.required.filter(k => !preConfig[k]);
      if (c.required.length > 0 && missing.length === 0) {
        // 找到完整配置的存储类型
        result.suggestedStorage = c.name;
        result.suggestedStorageFields = {};
        const prefixMap: Record<string, string> = {
          qiniu: 'qiniu_', upyun: 'upyun_', webdav: 'webdav_',
          s3: 's3_', github: 'gh_',
        };
        const p = prefixMap[c.name] || '';
        for (const k of Object.keys(preConfig)) {
          if (k === 'storage') continue;
          if (k.startsWith(p) && preConfig[k]) result.suggestedStorageFields![k] = preConfig[k];
        }
        break; // 只取第一个匹配的
      }
    }
  }

  return result;
}

/**
 * 安全过滤：从勾选的 pre_config 中过滤掉"本系统不支持"的项
 * 返回最终可以写入 D1 的键值对
 */
export function filterPreConfigForApply(
  selected: PreConfigMap,
  options: { skipStorage?: boolean } = {}
): PreConfigMap {
  const skipStorage = options.skipStorage !== false; // 默认 true
  const out: PreConfigMap = {};
  for (const [k, v] of Object.entries(selected)) {
    // 跳过 storage（永远由用户在 step-config 显式选择）
    if (skipStorage && k === 'storage') continue;
    // 跳过 installed/admin_pwd 这类敏感字段
    if (k === 'installed') continue;
    // 跳过长度过大的值（>10MB 防止误把大文件 base64 塞进 config）
    if (typeof v === 'string' && v.length > 10 * 1024 * 1024) continue;
    out[k] = v;
  }
  return out;
}
