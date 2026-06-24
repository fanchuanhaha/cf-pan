// 彩虹外链网盘 - 存储抽象接口 (TypeScript 版)

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

  /** 获取前端直传参数 (云存储用) */
  getUploadParam?(name: string, filename: string, maxFileSize?: number): Promise<{
    url: string; post: Record<string, string>;
  } | null>;

  /** 获取直链下载 URL */
  getDownUrl?(name: string, filename: string, contentType?: string): Promise<string | null>;
}
