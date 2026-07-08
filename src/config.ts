// 彩虹外链网盘 - 配置管理（D1 读取，内存缓存）

interface D1Result {
  k: string;
  v: string;
}

export type StorageType = 'r2' | 's3' | 'github' | 'webdav' | 'upyun' | 'qiniu' | 'local';

export interface AppConfig {
  title: string;
  keywords: string;
  description: string;
  gonggao: string;
  gg_file: string;
  tongji: string;
  filesearch: number;
  syskey: string;
  admin_user: string;
  admin_pwd: string;
  storage: StorageType;
  uploadfile_type: number;  // 0: 网站中转  1: 直传
  downfile_type: number;    // 0: 网站中转  1: 直链
  downfile_protocol: number; // 0: http  1: https
  downfile_domain: string;
  upload_size: number;  // MB
  upload_limit: number; // 每日上限
  forcelogin: number;
  api_open: number;
  api_referer: string;
  type_block: string;
  name_block: string;
  type_image: string;
  type_audio: string;
  type_video: string;
  green_check: number;
  green_provider: string;   // 'aliyun' | 'qcloud' | ''
  green_ak: string;
  green_sk: string;
  green_region: string;
  green_check_porn: number;
  green_check_terrorism: number;
  green_label_porn: string;
  green_label_terrorism: string;
  videoreview: number;
  version: number;
  ip_type: number;
  blackip: string;
  upload_max_filesize: string;
  r2_public_url: string;
  // 用户登录
  userlogin: number;
  login_apiurl: string;
  login_appid: string;
  login_appkey: string;
  login_qq: number;
  login_wx: number;
  // S3 配置
  s3_endpoint: string;
  s3_region: string;
  s3_bucket: string;
  s3_ak: string;
  s3_sk: string;
  // GitHub API 配置
  gh_owner: string;
  gh_repo: string;
  gh_token: string;
  gh_ref: string;
  gh_folder: string;
  gh_api_base: string;
  // WebDAV 配置
  webdav_endpoint: string;
  webdav_user: string;
  webdav_pass: string;
  webdav_folder: string;
  // 又拍云配置
  upyun_bucket: string;
  upyun_operator: string;
  upyun_password: string;
  upyun_endpoint: string;
  upyun_domain: string;
  upyun_folder: string;
  // 七牛云配置
  qiniu_ak: string;
  qiniu_sk: string;
  qiniu_bucket: string;
  qiniu_domain: string;
  qiniu_folder: string;
  // 安装标识
  installed: number;
}

const defaults: AppConfig = {
  title: '彩虹外链网盘',
  keywords: '',
  description: '',
  gonggao: '',
  gg_file: '',
  tongji: '',
  filesearch: 1,
  syskey: 'changeme_please',
  admin_user: 'admin',
  admin_pwd: '123456',
  storage: 'r2',
  uploadfile_type: 0,
  downfile_type: 0,
  downfile_protocol: 0,
  downfile_domain: '',
  upload_size: 10,
  upload_limit: 0,
  forcelogin: 0,
  api_open: 0,
  api_referer: '',
  type_block: '',
  name_block: '',
  type_image: 'jpg|jpeg|png|gif|webp|bmp|svg',
  type_audio: 'mp3|wav|ogg|flac|aac|m4a',
  type_video: 'mp4|mov|webm|flv|avi|mkv',
  green_check: 0,
  green_provider: '',
  green_ak: '',
  green_sk: '',
  green_region: 'cn-beijing',
  green_check_porn: 0,
  green_check_terrorism: 0,
  green_label_porn: 'porn,sexy',
  green_label_terrorism: 'bloody,terrorism',
  videoreview: 0,
  version: 1001,
  ip_type: 0,
  blackip: '',
  upload_max_filesize: '',
  r2_public_url: '',
  userlogin: 0,
  login_apiurl: '',
  login_appid: '',
  login_appkey: '',
  login_qq: 0,
  login_wx: 0,
  s3_endpoint: '',
  s3_region: '',
  s3_bucket: '',
  s3_ak: '',
  s3_sk: '',
  gh_owner: '',
  gh_repo: '',
  gh_token: '',
  gh_ref: '',
  gh_folder: '',
  gh_api_base: 'https://api.github.com',
  webdav_endpoint: '',
  webdav_user: '',
  webdav_pass: '',
  webdav_folder: 'file',
  upyun_bucket: '',
  upyun_operator: '',
  upyun_password: '',
  upyun_endpoint: 'https://v0.api.upyun.com',
  upyun_domain: '',
  upyun_folder: 'file',
  qiniu_ak: '',
  qiniu_sk: '',
  qiniu_bucket: '',
  qiniu_domain: '',
  qiniu_folder: 'file',
  installed: 0,
};

let cached: AppConfig | null = null;

/** 从 D1 加载配置 */
export async function loadConfig(db: D1Database, env?: { FILE_R2?: R2Bucket }): Promise<AppConfig> {
  // 不使用缓存，每次都从数据库加载最新配置（确保配置修改后立即生效）
  const { results } = await db.prepare('SELECT k, v FROM pre_config').all<D1Result>();
  const config = { ...defaults };
  for (const row of results) {
    const key = row.k as keyof AppConfig;
    if (key in defaults) {
      const v = row.v;
      // 数字类型转换
      if (typeof defaults[key] === 'number') {
        (config as Record<string, unknown>)[key] = parseInt(v) || 0;
      } else {
        (config as Record<string, unknown>)[key] = v;
      }
    }
  }
  // 智能回退：兼容从 PHP 备份恢复时 storage='local' 或未配置 R2 的情况
  // 检测其它已完整配置的后端（七牛云/S3/GitHub/WebDAV/又拍云），若有则临时切换
  // 不写回数据库，仅在内存中覆盖，让用户后续可在后台修改
  autoFallbackStorage(config, env);
  cached = config;
  return config;
}

/**
 * 智能回退存储类型：
 * - storage='r2' 但 FILE_R2 未绑定 → 查找其它完整配置的后端
 * - storage='local'（PHP 项目类型，本系统不支持）→ 查找其它完整配置的后端
 * - 查找顺序：qiniu > s3 > webdav > upyun > github
 */
function autoFallbackStorage(config: AppConfig, env?: { FILE_R2?: R2Bucket }): void {
  const current = config.storage;
  const needFallback =
    current === 'local' || // PHP 项目类型
    (current === 'r2' && !env?.FILE_R2); // R2 默认值但未绑定
  if (!needFallback) return;

  // 按使用频率/通用性优先级检测
  if (config.qiniu_ak && config.qiniu_sk && config.qiniu_bucket) {
    console.log('[loadConfig] storage fallback: local/r2 → qiniu (qiniu config detected)');
    config.storage = 'qiniu';
    return;
  }
  if (config.s3_endpoint && config.s3_bucket && config.s3_ak && config.s3_sk) {
    console.log('[loadConfig] storage fallback: local/r2 → s3 (s3 config detected)');
    config.storage = 's3';
    return;
  }
  if (config.webdav_endpoint && config.webdav_user && config.webdav_pass) {
    console.log('[loadConfig] storage fallback: local/r2 → webdav (webdav config detected)');
    config.storage = 'webdav';
    return;
  }
  if (config.upyun_bucket && config.upyun_operator && config.upyun_password) {
    console.log('[loadConfig] storage fallback: local/r2 → upyun (upyun config detected)');
    config.storage = 'upyun';
    return;
  }
  if (config.gh_owner && config.gh_repo && config.gh_token) {
    console.log('[loadConfig] storage fallback: local/r2 → github (github config detected)');
    config.storage = 'github';
    return;
  }
}

/** 更新单条配置 */
export async function updateConfig(db: D1Database, k: string, v: string): Promise<void> {
  await db.prepare(
    'INSERT INTO pre_config (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'
  ).bind(k, v).run();
  if (cached && k in cached) {
    const key = k as keyof AppConfig;
    if (typeof defaults[key] === 'number') {
      (cached as unknown as Record<string, unknown>)[key] = parseInt(v) || 0;
    } else {
      (cached as unknown as Record<string, unknown>)[key] = v;
    }
  }
}

/** 清除缓存 */
export function clearConfigCache(): void {
  cached = null;
}

/** 获取配置（必须已有缓存） */
export function getConfig(): AppConfig {
  if (!cached) throw new Error('Config not loaded yet');
  return cached;
}
