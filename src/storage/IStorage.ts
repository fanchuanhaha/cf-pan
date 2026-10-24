// 彩虹外链网盘 - 存储抽象接口 (TypeScript 版)

/** 存储中的对象（用于后台差异检查） */
export interface StorageObject {
  key: string;
  size: number;
  uploaded?: string;
}

/** 分片上传完成时提交给存储的单个分片信息 */
export interface MultipartPart {
  partNumber: number;
  etag: string;
}

export interface IStorage {
  /** 检查文件是否存在 */
  exists(name: string): Promise<boolean>;

  /** 获取文件内容 (Buffer | Readable) */
  get(name: string): Promise<R2ObjectBody | null>;

  /** 流式下载文件 (支持 Range) */
  downfile(name: string, range?: [number, number]): Promise<Response | null>;

  /** 从临时文件上传 */
  upload(name: string, body: ArrayBuffer | ReadableStream, contentType?: string): Promise<boolean>;

  /** 保存本地临时文件到存储 */
  savefile(name: string, tmpfile: string, contentType?: string): Promise<boolean>;

  /** 获取文件元信息 */
  getinfo(name: string): Promise<{ length: number; content_type: string } | null>;

  /** 删除文件 */
  delete(name: string): Promise<boolean>;

  /** 列出存储对象（可选，后台差异检查用） */
  list?(): Promise<StorageObject[]>;

  /** 获取前端直传参数 (云存储用) */
  getUploadParam?(name: string, filename: string, maxFileSize?: number): Promise<{
    url: string; post: Record<string, string>;
    method?: 'POST' | 'PUT'; headers?: Record<string, string>;
  } | null>;

  /** 获取直链下载 URL */
  getDownUrl?(name: string, filename: string, contentType?: string): Promise<string | null>;

  // ===== 分片上传（R2/S3 等对象存储） =====
  // 浏览器每次只把 8MB 分片发给 Worker，Worker 再调用存储的 UploadPart，
  // 这样单个请求不会触发 Cloudflare 100MB 请求体限制，大文件也能上传。

  /** 初始化分片上传，返回存储端的 uploadId */
  createMultipartUpload?(name: string, contentType?: string): Promise<string | null>;

  /** 上传一个分片，返回存储端 ETag */
  uploadPart?(name: string, uploadId: string, partNumber: number, body: ArrayBuffer): Promise<string | null>;

  /** 合并分片 */
  completeMultipartUpload?(name: string, uploadId: string, parts: MultipartPart[]): Promise<boolean>;

  /** 取消分片上传（失败清理用） */
  abortMultipartUpload?(name: string, uploadId: string): Promise<boolean>;
}
