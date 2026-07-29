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
  const e = ext.toLowerCase();
  const image = ['png','jpg','jpeg','gif','bmp','webp','ico','svg','svgz','tif','tiff','heic','psd','exif','pcx','tga','fpx','cdr','pcd','eps','ai','wmf','raw','ufo','jpc','jp2','jpx','xbm','wbmp','avif'];
  const audio = ['mp3','wav','wma','ogg','m4a','flac','ape','aac','ra','cda','midi','mid','aif','au','voc'];
  const video = ['mp4','webm','flv','f4v','mov','3gp','3gpp','avi','mpg','mpeg','wmv','mkv','ts','dat','asf','rm','rmvb','ram','divx','vob','qt','fli','flc','mod','m2t','swf','mts','m2ts','mpe','div','lavf','m3u8','m4v','ogm','ogv'];
  const text = ['txt','text','log','md','yaml','yml','conf','config','ini'];
  const code = ['c','cpp','cxx','rc','php','py','cs','h','htm','html','css','less','js','hdml','dtd','wml','xml','vbs','vb','rtx','xsd','dpr','sql','java','go','jsp','asp','aspx','asa','asax','pl','bat','cmd','rb','reg','sh','json','lua','r','mm','mak','swift','tpl'];
  const archive = ['zip','7z','rar','tgz','gz','xz','tar','jar','iso','z','zipx','cab','bz2','arj','lz','lzh'];
  const word = ['doc','docx','xps','rtf','wps','odt'];
  const excel = ['xls','xlsx','ods'];
  const pdf = ['pdf'];
  const powerpoint = ['ppt','pptx','pptm'];
  const android = ['apk'];
  const apple = ['ipa','dmg'];
  const windows = ['exe','appx','msi'];
  const linux = ['deb','rpm'];
  if (image.includes(e)) return 'fa-file-image-o';
  if (audio.includes(e)) return 'fa-file-audio-o';
  if (video.includes(e)) return 'fa-file-video-o';
  if (text.includes(e)) return 'fa-file-text-o';
  if (code.includes(e)) return 'fa-file-code-o';
  if (archive.includes(e)) return 'fa-file-archive-o';
  if (word.includes(e)) return 'fa-file-word-o';
  if (excel.includes(e)) return 'fa-file-excel-o';
  if (pdf.includes(e)) return 'fa-file-pdf-o';
  if (powerpoint.includes(e)) return 'fa-file-powerpoint-o';
  if (android.includes(e)) return 'fa-android';
  if (apple.includes(e)) return 'fa-apple';
  if (windows.includes(e)) return 'fa-windows';
  if (linux.includes(e)) return 'fa-linux';
  return 'fa-file-o';
}

/** 文件大小格式化 */
export function sizeFormat(bytes: number | string): string {
  let size = typeof bytes === 'string' ? parseInt(bytes) : bytes;
  if (isNaN(size)) return '0 B';
  if (size < 1024) {
    return size + ' B';
  }
  size /= 1024;
  if (size < 1024) {
    return Math.round(size * 100) / 100 + ' KB';
  }
  size /= 1024;
  if (size < 1024) {
    return Math.round(size * 100) / 100 + ' MB';
  }
  size /= 1024;
  return Math.round(size * 100) / 100 + ' GB';
}

/** 获取文件扩展名 */
export function getFileExt(name: string): string {
  const pos = name.lastIndexOf('.');
  if (pos === -1) return '';
  return name.substring(pos + 1);
}
