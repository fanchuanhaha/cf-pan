<?php
/**
 * 彩虹外链网盘远程恢复代理。
 * 将本文件放在原站点根目录，修改 REMOTE_RESTORE_SECRET。
 * Worker 通过 AES-256-GCM + HMAC 调用本文件；不要公开分享密钥。
 */

define('REMOTE_RESTORE_SECRET', '27da3de8ce92ad3b00ab1c374045de83a15d06b3b94b3b73f729a9bdbb474043');
define('REMOTE_RESTORE_TTL', 300);
define('REMOTE_RESTORE_LOG', '/home/fan/Downloads/remote_restore.log');

function remote_log($message, $context = array()) {
    $line = date('c') . ' ' . $message;
    if ($context) $line .= ' ' . json_encode($context, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    $written = @file_put_contents(REMOTE_RESTORE_LOG, $line . "\n", FILE_APPEND | LOCK_EX);
    if ($written === false) @file_put_contents(__DIR__ . '/remote_restore.log', $line . "\n", FILE_APPEND | LOCK_EX);
    error_log('[remote_restore] ' . $line);
}

function remote_recent_log($lines = 20) {
    $path = is_readable(REMOTE_RESTORE_LOG) ? REMOTE_RESTORE_LOG : __DIR__ . '/remote_restore.log';
    if (!is_readable($path)) return '';
    $rows = @file($path, FILE_IGNORE_NEW_LINES);
    if (!$rows) return '';
    return implode("\n", array_slice($rows, -$lines));
}

function remote_set_storage_prefix($stor, $prefix) {
    if (!is_object($stor) || !property_exists($stor, 'filepath')) return false;
    try {
        $property = new ReflectionProperty($stor, 'filepath');
        $property->setAccessible(true);
        $property->setValue($stor, $prefix === '' ? '' : trim($prefix, '/') . '/');
        return true;
    } catch (Exception $e) {
        remote_log('prefix override failed', array('prefix' => $prefix, 'error' => $e->getMessage()));
        return false;
    }
}

function remote_storage_candidates($settings) {
    $candidates = array();
    foreach (array($settings['qiniu_folder'] ?? '', $settings['upyun_folder'] ?? '', $settings['filepath'] ?? '', 'file', 'incloud', '') as $prefix) {
        $prefix = trim((string)$prefix, " /\\");
        if (!in_array($prefix, $candidates, true)) $candidates[] = $prefix;
    }
    return $candidates;
}

function remote_probe_url($url) {
    $ch = curl_init($url);
    curl_setopt_array($ch, array(
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => array('Range: bytes=0-0'),
        CURLOPT_TIMEOUT => 30,
        CURLOPT_CONNECTTIMEOUT => 10,
    ));
    curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $type = curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
    $length = curl_getinfo($ch, CURLINFO_CONTENT_LENGTH_DOWNLOAD);
    $error = curl_error($ch);
    curl_close($ch);
    return array('ok' => $status >= 200 && $status < 300, 'status' => $status, 'type' => $type, 'length' => $length, 'error' => $error);
}

function remote_stream_url($url, $fallbackType = 'application/octet-stream') {
    header('Content-Type: ' . ($fallbackType ?: 'application/octet-stream'));
    header('Cache-Control: no-store');
    $ch = curl_init($url);
    curl_setopt_array($ch, array(
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_RETURNTRANSFER => false,
        CURLOPT_TIMEOUT => 0,
        CURLOPT_CONNECTTIMEOUT => 30,
        CURLOPT_HEADERFUNCTION => function ($ch, $line) {
            $lower = strtolower($line);
            if (strpos($lower, 'content-length:') === 0 || strpos($lower, 'content-type:') === 0 || strpos($lower, 'content-range:') === 0) header(trim($line));
            return strlen($line);
        },
    ));
    $ok = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $error = curl_error($ch);
    curl_close($ch);
    return array('ok' => $ok !== false && $status >= 200 && $status < 300, 'status' => $status, 'error' => $error);
}

function remote_local_candidates($settings, $hash) {
    $roots = array();
    if (!empty($settings['filepath']) && is_dir($settings['filepath'])) $roots[] = rtrim($settings['filepath'], '/\\');
    $roots[] = __DIR__ . '/file';
    $roots[] = __DIR__ . '/incloud';
    $paths = array();
    foreach ($roots as $root) {
        foreach (array('', 'file', 'incloud') as $prefix) {
            $path = $root . ($prefix ? '/' . $prefix : '') . '/' . $hash;
            if (!in_array($path, $paths, true)) $paths[] = $path;
        }
    }
    return $paths;
}

function remote_progress($data) {
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n";
    if (ob_get_level() > 0) ob_end_flush();
    @flush();
}

function remote_qiniu_init($fields) {
    if (empty($fields['qiniu_ak']) || empty($fields['qiniu_sk']) || empty($fields['qiniu_bucket'])) {
        return array(null, '目标七牛配置不完整');
    }
    require_once __DIR__ . '/includes/autoloader.php';
    Autoloader::register();
    require_once __DIR__ . '/includes/vendor/autoload.php';
    $reqOpt = new \Qiniu\Http\RequestOptions(60, null, 600, null);
    $auth = new \Qiniu\Auth($fields['qiniu_ak'], $fields['qiniu_sk']);
    $token = $auth->uploadToken($fields['qiniu_bucket']);
    $config = new \Qiniu\Config();
    list($accessKey, $bucket, $err) = \Qiniu\explodeUpToken($token);
    if ($err) return array(null, 'token 解析失败: ' . $err->message());
    list($upHost, $err) = $config->getUpHostV2($accessKey, $bucket);
    if ($err) return array(null, '获取上传域名失败: ' . $err->message());
    $folder = trim((string)($fields['qiniu_folder'] ?? 'file'), '/');
    return array(array('token' => $token, 'upHost' => $upHost, 'reqOpt' => $reqOpt), null);
}

function remote_qiniu_mkblk($info, $data) {
    $crc = \Qiniu\crc32_data($data);
    $url = $info['upHost'] . '/mkblk/' . strlen($data);
    $headers = array('Authorization' => 'UpToken ' . $info['token']);
    $response = \Qiniu\Http\Client::post($url, $data, $headers, $info['reqOpt']);
    $ret = null;
    if ($response->ok() && $response->json() != null) $ret = $response->json();
    if ($response->needRetry() || !isset($ret['crc32']) || $crc != $ret['crc32']) {
        $response = \Qiniu\Http\Client::post($url, $data, $headers, $info['reqOpt']);
        $ret = $response->json();
    }
    if (!$response->ok() || !isset($ret['crc32']) || $crc != $ret['crc32']) {
        $errMsg = 'mkblk 失败: HTTP ' . $response->statusCode;
        if ($ret && isset($ret['error'])) $errMsg .= ' ' . $ret['error'];
        return array(null, $errMsg);
    }
    return array($ret['ctx'], null);
}

function remote_qiniu_mkfile($info, $key, $fileSize, $contexts) {
    $encodedKey = \Qiniu\base64_urlSafeEncode($key);
    $encodedMime = \Qiniu\base64_urlSafeEncode('application/octet-stream');
    $url = $info['upHost'] . '/mkfile/' . $fileSize . '/mimeType/' . $encodedMime . '/key/' . $encodedKey;
    $body = implode(',', $contexts);
    $response = \Qiniu\Http\Client::post($url, $body, array('Authorization' => 'UpToken ' . $info['token']), $info['reqOpt']);
    if (!$response->ok()) {
        $ret = $response->json();
        $errMsg = 'mkfile 失败: HTTP ' . $response->statusCode;
        if ($ret && isset($ret['error'])) $errMsg .= ' ' . $ret['error'];
        return array(null, $errMsg);
    }
    return array($response->json(), null);
}

function remote_upload_stat_file($data) {
    $db = remote_db();
    $settings = remote_settings($db);
    $user = (string)($data['admin_user'] ?? '');
    $pass = (string)($data['admin_password'] ?? '');
    if ($user === '' || !hash_equals((string)($settings['admin_user'] ?? ''), $user) || !hash_equals((string)($settings['admin_pwd'] ?? ''), $pass)) remote_fail('管理员验证失败', 403);
    $hash = preg_replace('/[^a-zA-Z0-9._-]/', '', (string)($data['hash'] ?? ''));
    $source = remote_upload_find_file($settings, $hash);
    if (!$source) return array('ok' => false, 'error' => '远程原站本地文件不存在');
    return array('ok' => true, 'hash' => $hash, 'size' => filesize($source), 'path' => $source);
}

function remote_upload_block($data) {
    $db = remote_db();
    $settings = remote_settings($db);
    $user = (string)($data['admin_user'] ?? '');
    $pass = (string)($data['admin_password'] ?? '');
    if ($user === '' || !hash_equals((string)($settings['admin_user'] ?? ''), $user) || !hash_equals((string)($settings['admin_pwd'] ?? ''), $pass)) remote_fail('管理员验证失败', 403);
    $hash = preg_replace('/[^a-zA-Z0-9._-]/', '', (string)($data['hash'] ?? ''));
    $offset = max(0, intval($data['offset'] ?? 0));
    $length = min(4 * 1024 * 1024, max(0, intval($data['length'] ?? (4 * 1024 * 1024))));
    $fields = is_array($data['target_fields'] ?? null) ? $data['target_fields'] : array();
    $source = remote_upload_find_file($settings, $hash);
    if (!$source) return array('ok' => false, 'error' => '远程原站本地文件不存在');
    list($info, $err) = remote_qiniu_init($fields);
    if ($err) return array('ok' => false, 'error' => $err);
    $fileSize = filesize($source);
    if ($offset >= $fileSize) return array('ok' => false, 'error' => 'offset 超出文件范围');
    $fp = fopen($source, 'rb');
    if (!$fp) return array('ok' => false, 'error' => '无法读取本地文件: ' . $source);
    if ($offset > 0) fseek($fp, $offset);
    $data = fread($fp, $length);
    $dataLen = strlen($data);
    fclose($fp);
    if ($data === false || $dataLen === 0) return array('ok' => false, 'error' => '文件读取失败 at offset ' . $offset);
    list($ctx, $err) = remote_qiniu_mkblk($info, $data);
    if ($err) return array('ok' => false, 'error' => $err);
    $uploaded = $offset + $dataLen;
    remote_log('block uploaded', array('hash' => $hash, 'offset' => $offset, 'len' => $dataLen, 'uploaded' => $uploaded, 'total' => $fileSize));
    return array('ok' => true, 'ctx' => $ctx, 'offset' => $offset, 'len' => $dataLen, 'uploaded' => $uploaded, 'total' => $fileSize);
}

function remote_upload_mkfile($data) {
    $db = remote_db();
    $settings = remote_settings($db);
    $user = (string)($data['admin_user'] ?? '');
    $pass = (string)($data['admin_password'] ?? '');
    if ($user === '' || !hash_equals((string)($settings['admin_user'] ?? ''), $user) || !hash_equals((string)($settings['admin_pwd'] ?? ''), $pass)) remote_fail('管理员验证失败', 403);
    $hash = preg_replace('/[^a-zA-Z0-9._-]/', '', (string)($data['hash'] ?? ''));
    $contexts = is_array($data['contexts'] ?? null) ? array_values($data['contexts']) : array();
    $fileSize = max(0, intval($data['size'] ?? 0));
    $fields = is_array($data['target_fields'] ?? null) ? $data['target_fields'] : array();
    if (!$contexts) return array('ok' => false, 'error' => '缺少分片上下文');
    list($info, $err) = remote_qiniu_init($fields);
    if ($err) return array('ok' => false, 'error' => $err);
    $folder = trim((string)($fields['qiniu_folder'] ?? 'file'), '/');
    $key = ($folder ? $folder . '/' : '') . $hash;
    list($ret, $err) = remote_qiniu_mkfile($info, $key, $fileSize, $contexts);
    if ($err) {
        remote_log('mkfile failed', array('hash' => $hash, 'error' => $err));
        return array('ok' => false, 'error' => $err);
    }
    remote_log('mkfile complete', array('hash' => $hash, 'key' => $key, 'size' => $fileSize));
    return array('ok' => true, 'key' => $key, 'size' => $fileSize, 'data' => $ret);
}

function remote_upload_find_file($settings, $hash) {
    foreach (remote_local_candidates($settings, $hash) as $path) {
        remote_log('local file try', array('hash' => $hash, 'path' => $path));
        if (is_file($path) && is_readable($path)) return $path;
    }
    return null;
}

function remote_upload($data) {
    $db = remote_db();
    $settings = remote_settings($db);
    $user = (string)($data['admin_user'] ?? '');
    $pass = (string)($data['admin_password'] ?? '');
    if ($user === '' || !hash_equals((string)($settings['admin_user'] ?? ''), $user) || !hash_equals((string)($settings['admin_pwd'] ?? ''), $pass)) remote_fail('管理员验证失败', 403);
    $hash = preg_replace('/[^a-zA-Z0-9._-]/', '', (string)($data['hash'] ?? ''));
    $storage = (string)($data['target_storage'] ?? '');
    $fields = is_array($data['target_fields'] ?? null) ? $data['target_fields'] : array();
    remote_log('direct upload start', array('hash' => $hash, 'target' => $storage));
    $source = remote_upload_find_file($settings, $hash);
    if (!$source) return array('ok' => false, 'error' => '远程原站本地文件不存在', 'log' => remote_recent_log());
    if ($storage === 'qiniu') {
        $result = array('ok' => false, 'error' => '请使用 upload-stream 接口');
    } else {
        $result = array('ok' => false, 'error' => 'PHP 直传暂时支持目标七牛云，当前目标: ' . $storage);
    }
    remote_log('direct upload result', array('hash' => $hash, 'target' => $storage, 'result' => $result));
    return $result;
}

function remote_fail($message, $status = 400) {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(array('ok' => false, 'error' => $message), JSON_UNESCAPED_UNICODE);
    exit;
}

function remote_key() {
    return hash('sha256', REMOTE_RESTORE_SECRET, true);
}

function remote_decrypt($value) {
    $raw = base64_decode($value, true);
    if ($raw === false || strlen($raw) < 29) remote_fail('加密请求格式无效');
    $iv = substr($raw, 0, 12);
    $parts = array(
        array(substr($raw, 12, -16), substr($raw, -16)),
        array(substr($raw, 28), substr($raw, 12, 16)),
    );
    foreach ($parts as $part) {
        $plain = openssl_decrypt($part[0], 'aes-256-gcm', remote_key(), OPENSSL_RAW_DATA, $iv, $part[1]);
        if ($plain !== false) return json_decode($plain, true);
    }
    remote_fail('加密请求校验失败', 403);
}

function remote_encrypt($data) {
    $iv = random_bytes(12);
    $tag = '';
    $plain = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    $cipher = openssl_encrypt($plain, 'aes-256-gcm', remote_key(), OPENSSL_RAW_DATA, $iv, $tag);
    if ($cipher === false) remote_fail('加密响应失败', 500);
    return base64_encode($iv . $cipher . $tag);
}

function remote_auth($body) {
    $ts = isset($body['timestamp']) ? intval($body['timestamp']) : 0;
    $nonce = isset($body['nonce']) ? (string)$body['nonce'] : '';
    $action = isset($body['action']) ? (string)$body['action'] : '';
    $payload = isset($body['payload']) ? (string)$body['payload'] : '';
    if (!$ts || abs(time() - $ts) > REMOTE_RESTORE_TTL || !$nonce || !$action || !$payload) {
        remote_fail('请求已过期或参数不完整', 403);
    }
    $expected = hash_hmac('sha256', $ts . "\n" . $nonce . "\n" . $action . "\n" . $payload, REMOTE_RESTORE_SECRET);
    if (!hash_equals($expected, (string)($body['signature'] ?? ''))) remote_fail('签名校验失败', 403);
    return remote_decrypt($payload);
}

function remote_db() {
    require __DIR__ . '/config.php';
    if (!$dbconfig['user'] || !$dbconfig['dbname']) remote_fail('原站数据库配置不完整', 500);
    try {
        $db = new PDO(
            'mysql:host=' . $dbconfig['host'] . ';dbname=' . $dbconfig['dbname'] . ';port=' . $dbconfig['port'] . ';charset=utf8mb4',
            $dbconfig['user'], $dbconfig['pwd'],
            array(PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC)
        );
        return $db;
    } catch (Exception $e) {
        remote_fail('连接原站数据库失败', 500);
    }
}

function remote_settings($db) {
    $rows = $db->query('SELECT k, v FROM pre_config')->fetchAll();
    $out = array();
    foreach ($rows as $row) $out[(string)$row['k']] = (string)$row['v'];
    return $out;
}

function remote_sql_value($value) {
    if ($value === null) return 'NULL';
    return "'" . str_replace(array('\\', "'", "\0", "\n", "\r", "\x1a"), array('\\\\', "\\'", '\\0', '\\n', '\\r', '\\Z'), (string)$value) . "'";
}

function remote_insert_sql($table, $rows, $columns) {
    if (!$rows) return '';
    $sql = "INSERT INTO `" . $table . "` (`" . implode('`,`', $columns) . "`) VALUES\n";
    $values = array();
    foreach ($rows as $row) {
        $line = array();
        foreach ($columns as $column) $line[] = remote_sql_value(array_key_exists($column, $row) ? $row[$column] : null);
        $values[] = '(' . implode(',', $line) . ')';
    }
    return $sql . implode(",\n", $values) . ";\n";
}

function remote_export($data) {
    $db = remote_db();
    $user = isset($data['admin_user']) ? (string)$data['admin_user'] : '';
    $pass = isset($data['admin_password']) ? (string)$data['admin_password'] : '';
    $settings = remote_settings($db);
    if ($user === '' || !hash_equals((string)($settings['admin_user'] ?? ''), $user) || !hash_equals((string)($settings['admin_pwd'] ?? ''), $pass)) {
        remote_fail('原站管理员账号或密码错误', 403);
    }
    $fileRows = $db->query('SELECT id,name,type,size,hash,addtime,lasttime,ip,hide,pwd,block,count,uid FROM pre_file ORDER BY id')->fetchAll();
    $userRows = $db->query('SELECT uid,type,openid,nickname,faceimg,level,enable,regip,loginip,addtime,lasttime FROM pre_user ORDER BY uid')->fetchAll();
    $sql = "-- remote restore export\n";
    $sql .= remote_insert_sql('pre_config', array_map(function ($k, $v) { return array('k' => $k, 'v' => $v); }, array_keys($settings), array_values($settings)), array('k', 'v'));
    $sql .= remote_insert_sql('pre_file', $fileRows, array('id','name','type','size','hash','addtime','lasttime','ip','hide','pwd','block','count','uid'));
    $sql .= remote_insert_sql('pre_user', $userRows, array('uid','type','openid','nickname','faceimg','level','enable','regip','loginip','addtime','lasttime'));
    return array('sql' => $sql, 'fileCount' => count($fileRows), 'settings' => $settings, 'serverTime' => time());
}

function remote_file($data) {
    $db = remote_db();
    $settings = remote_settings($db);
    $user = (string)($data['admin_user'] ?? '');
    $pass = (string)($data['admin_password'] ?? '');
    if ($user === '' || !hash_equals((string)($settings['admin_user'] ?? ''), $user) || !hash_equals((string)($settings['admin_pwd'] ?? ''), $pass)) remote_fail('管理员验证失败', 403);
    $hash = preg_replace('/[^a-zA-Z0-9._-]/', '', (string)($data['hash'] ?? ''));
    if ($hash === '') remote_fail('文件 hash 无效');
    remote_log('file start', array('hash' => $hash, 'storage' => $settings['storage'] ?? 'unknown'));
    require_once __DIR__ . '/includes/autoloader.php';
    Autoloader::register();
    require_once __DIR__ . '/includes/vendor/autoload.php';
    $conf = $settings;
    $GLOBALS['conf'] = $conf;
    $stor = \lib\StorHelper::getModel($settings['storage'] ?? '');
    if (!$stor) {
        remote_log('storage unavailable', array('hash' => $hash));
        remote_fail('原站存储模块不可用', 502);
    }
    $info = false;
    $selectedPrefix = null;
    $signedUrl = null;
    foreach (remote_storage_candidates($settings) as $prefix) {
        remote_set_storage_prefix($stor, $prefix);
        remote_log('file stat try', array('hash' => $hash, 'prefix' => $prefix, 'storage' => $settings['storage'] ?? 'unknown'));
        $info = $stor->getinfo($hash);
        if ($info) {
            $selectedPrefix = $prefix;
            remote_log('file stat success', array('hash' => $hash, 'prefix' => $prefix, 'size' => $info['length'] ?? null));
            break;
        }
        $candidateUrl = $stor->getDownUrl($hash);
        if ($candidateUrl) {
            $probe = remote_probe_url($candidateUrl);
            remote_log('signed url probe', array('hash' => $hash, 'prefix' => $prefix, 'status' => $probe['status'], 'error' => $probe['error']));
            if ($probe['ok']) {
                $selectedPrefix = $prefix;
                $signedUrl = $candidateUrl;
                $info = array('length' => $probe['length'], 'content_type' => $probe['type']);
                break;
            }
        }
    }
    if (!$info) {
        $error = $stor->errmsg() ?: 'unknown';
        remote_log('file stat failed', array('hash' => $hash, 'error' => $error, 'tried' => remote_storage_candidates($settings)));
        remote_fail('原站存储中找不到文件: ' . $error . "\n最近日志:\n" . remote_recent_log(), 404);
    }
    header('Content-Type: ' . ($info['content_type'] ?? 'application/octet-stream'));
    if (!empty($info['length'])) header('Content-Length: ' . intval($info['length']));
    header('Cache-Control: no-store');
    if ($signedUrl) {
        $stream = remote_stream_url($signedUrl, $info['content_type'] ?? 'application/octet-stream');
        $ok = $stream['ok'];
        if (!$ok) remote_log('signed stream failed', array('hash' => $hash, 'prefix' => $selectedPrefix, 'status' => $stream['status'], 'error' => $stream['error']));
    } else {
        remote_set_storage_prefix($stor, $selectedPrefix);
        $ok = $stor->downfile($hash, false);
    }
    if (!$ok) {
        remote_log('file stream failed', array('hash' => $hash, 'error' => $stor->errmsg()));
        exit;
    }
    remote_log('file complete', array('hash' => $hash, 'size' => $info['length'] ?? null));
    exit;
}

$raw = file_get_contents('php://input');
$body = json_decode($raw, true);
if (!is_array($body)) remote_fail('请求格式无效');
$data = remote_auth($body);
if ($body['action'] === 'export') {
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(array('ok' => true, 'payload' => remote_encrypt(remote_export($data))), JSON_UNESCAPED_UNICODE);
    exit;
}
if ($body['action'] === 'file') remote_file($data);
if ($body['action'] === 'upload') {
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(array('ok' => true, 'payload' => remote_encrypt(remote_upload($data))), JSON_UNESCAPED_UNICODE);
    exit;
}
if ($body['action'] === 'stat-file' || $body['action'] === 'upload-block' || $body['action'] === 'mkfile') {
    header('Content-Type: application/json; charset=utf-8');
    $result = array('ok' => false, 'error' => '未知操作');
    if ($body['action'] === 'stat-file') $result = remote_upload_stat_file($data);
    if ($body['action'] === 'upload-block') $result = remote_upload_block($data);
    if ($body['action'] === 'mkfile') $result = remote_upload_mkfile($data);
    echo json_encode(array('ok' => true, 'payload' => remote_encrypt($result)), JSON_UNESCAPED_UNICODE);
    exit;
}
remote_fail('不支持的操作');
