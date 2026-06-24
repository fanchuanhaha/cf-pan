// 彩虹外链网盘 - MIME 类型判断工具

/** 根据扩展名获取 MIME type */
export function getMimeType(ext: string): string {
  const mime: Record<string, string> = {
    'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png',
    'gif': 'image/gif', 'webp': 'image/webp', 'bmp': 'image/bmp',
    'svg': 'image/svg+xml', 'ico': 'image/x-icon',
    'mp3': 'audio/mpeg', 'wav': 'audio/wav', 'ogg': 'audio/ogg',
    'flac': 'audio/flac', 'aac': 'audio/aac', 'm4a': 'audio/mp4',
    'mp4': 'video/mp4', 'webm': 'video/webm', 'mov': 'video/quicktime',
    'flv': 'video/x-flv', 'avi': 'video/x-msvideo', 'mkv': 'video/x-matroska',
    'pdf': 'application/pdf', 'doc': 'application/msword',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xls': 'application/vnd.ms-excel',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'ppt': 'application/vnd.ms-powerpoint',
    'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'zip': 'application/zip', 'rar': 'application/x-rar-compressed',
    '7z': 'application/x-7z-compressed', 'gz': 'application/gzip',
    'txt': 'text/plain', 'html': 'text/html', 'css': 'text/css',
    'js': 'application/javascript', 'json': 'application/json',
    'xml': 'application/xml', 'md': 'text/markdown',
  };
  const extLower = ext.toLowerCase();
  return mime[extLower] || 'application/octet-stream';
}

/** 判断文件类型是否可预览 */
export function getViewType(ext: string): 'image' | 'audio' | 'video' | 'office' | 'other' {
  const extLower = ext.toLowerCase();
  const images = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico'];
  const audios = ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'];
  const videos = ['mp4', 'webm', 'mov', 'flv', 'avi', 'mkv'];
  const offices = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'];
  if (images.includes(extLower)) return 'image';
  if (audios.includes(extLower)) return 'audio';
  if (videos.includes(extLower)) return 'video';
  if (offices.includes(extLower)) return 'office';
  return 'other';
}

/** 判断是否可直接内联展示 */
export function isView(ext: string): boolean {
  const v = getViewType(ext);
  return v === 'image' || v === 'audio' || v === 'video';
}

/** 返回 Font Awesome 图标类名 */
export function typeToIcon(ext: string): string {
  const iconMap: Record<string, string> = {
    'jpg': 'fa-file-image-o', 'jpeg': 'fa-file-image-o', 'png': 'fa-file-image-o',
    'gif': 'fa-file-image-o', 'webp': 'fa-file-image-o', 'bmp': 'fa-file-image-o',
    'svg': 'fa-file-image-o',
    'mp3': 'fa-file-audio-o', 'wav': 'fa-file-audio-o', 'ogg': 'fa-file-audio-o',
    'flac': 'fa-file-audio-o', 'm4a': 'fa-file-audio-o', 'aac': 'fa-file-audio-o',
    'mp4': 'fa-file-video-o', 'webm': 'fa-file-video-o', 'mov': 'fa-file-video-o',
    'flv': 'fa-file-video-o', 'avi': 'fa-file-video-o', 'mkv': 'fa-file-video-o',
    'pdf': 'fa-file-pdf-o',
    'doc': 'fa-file-word-o', 'docx': 'fa-file-word-o',
    'xls': 'fa-file-excel-o', 'xlsx': 'fa-file-excel-o',
    'ppt': 'fa-file-powerpoint-o', 'pptx': 'fa-file-powerpoint-o',
    'zip': 'fa-file-archive-o', 'rar': 'fa-file-archive-o',
    '7z': 'fa-file-archive-o', 'gz': 'fa-file-archive-o',
    'txt': 'fa-file-text-o', 'html': 'fa-file-code-o',
    'css': 'fa-file-code-o', 'js': 'fa-file-code-o',
    'md': 'fa-file-text-o',
  };
  return iconMap[ext.toLowerCase()] || 'fa-file-o';
}

/** 文件大小格式化 */
export function sizeFormat(bytes: number | string): string {
  const size = typeof bytes === 'string' ? parseInt(bytes) : bytes;
  if (isNaN(size)) return '0 B';
  if (size >= 1073741824) return (size / 1073741824).toFixed(2) + ' GB';
  if (size >= 1048576) return (size / 1048576).toFixed(2) + ' MB';
  if (size >= 1024) return (size / 1024).toFixed(2) + ' KB';
  return size + ' B';
}

/** 获取文件扩展名 */
export function getFileExt(name: string): string {
  const pos = name.lastIndexOf('.');
  if (pos === -1) return '';
  return name.substring(pos + 1);
}
