<?php
// 通信密钥：首次运行自动生成并持久化到 restore_secret.php，无需手工修改
function rec_secret_load() {
    $file = __DIR__ . '/restore_secret.php';
    if (is_file($file)) {
        $v = trim((string)file_get_contents($file));
        $v = preg_replace('/^<\?php exit;\?>\s*/', '', $v);
        if (strlen($v) >= 32) return $v;
    }
    $v = bin2hex(random_bytes(32));
    @file_put_contents($file, "<?php exit;?>\n" . $v, LOCK_EX);
    return $v;
}
define('REMOTE_RESTORE_SECRET', rec_secret_load());
define('REMOTE_RESTORE_TTL', 300);
define('REMOTE_RESTORE_LOG', '/home/fan/Downloads/remote_restore.log');

function rec_log($message, $context = array()) {
    $line = date('c') . ' ' . $message;
    if ($context) $line .= ' ' . json_encode($context, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    @file_put_contents(REMOTE_RESTORE_LOG, $line . "\n", FILE_APPEND | LOCK_EX);
    error_log('[rec] ' . $line);
}

function rec_config_path() { return __DIR__ . '/restore_config.php'; }
function rec_status_path() { return __DIR__ . '/restore_status.json'; }

function rec_fail($message, $status = 400) {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(array('ok' => false, 'error' => $message), JSON_UNESCAPED_UNICODE);
    exit;
}

function rec_status_write($status) {
    $status['updatedAt'] = time();
    @file_put_contents(rec_status_path(), json_encode($status, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
}

function rec_status_read() {
    if (!is_file(rec_status_path())) return null;
    $json = json_decode(@file_get_contents(rec_status_path()), true);
    return is_array($json) ? $json : null;
}

function rec_esc($v) { return htmlspecialchars((string)$v, ENT_QUOTES, 'UTF-8'); }
function rec_size($n) {
    $n = (int)$n;
    if ($n >= 1073741824) return number_format($n / 1073741824, 1) . ' GB';
    if ($n >= 1048576) return number_format($n / 1048576, 1) . ' MB';
    if ($n >= 1024) return number_format($n / 1024, 1) . ' KB';
    return $n . ' B';
}

function rec_sql($value) {
    if ($value === null) return 'NULL';
    return "'" . str_replace(array('\\', "'", "\0", "\n", "\r", "\x1a"), array('\\\\', "\\'", '\\0', '\\n', '\\r', '\\Z'), (string)$value) . "'";
}

function rec_key() { return hash('sha256', REMOTE_RESTORE_SECRET, true); }
function rec_encrypt($data) {
    $iv = random_bytes(12);
    $tag = '';
    $plain = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    $cipher = openssl_encrypt($plain, 'aes-256-gcm', rec_key(), OPENSSL_RAW_DATA, $iv, $tag);
    if ($cipher === false) rec_fail('加密响应失败', 500);
    return base64_encode($iv . $cipher . $tag);
}
function rec_decrypt($value) {
    $raw = base64_decode($value, true);
    if ($raw === false || strlen($raw) < 29) rec_fail('加密请求格式无效', 403);
    $iv = substr($raw, 0, 12);
    $parts = array(
        array(substr($raw, 12, -16), substr($raw, -16)),
        array(substr($raw, 28), substr($raw, 12, 16)),
    );
    foreach ($parts as $part) {
        $plain = openssl_decrypt($part[0], 'aes-256-gcm', rec_key(), OPENSSL_RAW_DATA, $iv, $part[1]);
        if ($plain !== false) return json_decode($plain, true);
    }
    rec_fail('加密请求校验失败', 403);
}
function rec_auth($body) {
    $ts = isset($body['timestamp']) ? intval($body['timestamp']) : 0;
    $nonce = isset($body['nonce']) ? (string)$body['nonce'] : '';
    $action = isset($body['action']) ? (string)$body['action'] : '';
    $payload = isset($body['payload']) ? (string)$body['payload'] : '';
    if (!$ts || abs(time() - $ts) > REMOTE_RESTORE_TTL || !$nonce || !$action || !$payload) rec_fail('请求已过期或参数不完整', 403);
    $expected = hash_hmac('sha256', $ts . "\n" . $nonce . "\n" . $action . "\n" . $payload, REMOTE_RESTORE_SECRET);
    if (!hash_equals($expected, (string)($body['signature'] ?? ''))) rec_fail('签名校验失败', 403);
    return rec_decrypt($payload);
}

function rec_require_curl() {
    if (!function_exists('curl_init')) throw new Exception('PHP 未安装 cURL 扩展，无法流式上传');
}

function rec_url_path($path) {
    $parts = explode('/', trim((string)$path, '/'));
    return '/' . implode('/', array_map('rawurlencode', $parts));
}

function rec_b64url($value) {
    return str_replace(array('+', '/'), array('-', '_'), base64_encode($value));
}

function rec_progress_callback(&$status, $baseBytes, $fileSize, $offset, $startedAt, &$lastWrite) {
    return function($curl, $downloadTotal, $downloaded, $uploadTotal, $uploaded) use (&$status, $baseBytes, $fileSize, $offset, $startedAt, &$lastWrite) {
        $current = min($fileSize, $offset + max(0, (int)$uploaded));
        $status['currentFileReceived'] = $current;
        $status['processedBytes'] = $baseBytes + $current;
        $status['currentFileSpeed'] = (int)round($current / max(0.001, microtime(true) - $startedAt));
        $now = microtime(true);
        if ($now - $lastWrite >= 0.2 || $current >= $fileSize) {
            $lastWrite = $now;
            rec_status_write($status);
        }
        return 0;
    };
}

function rec_stream_request($url, $method, $headers, $source, $size, &$status, $baseBytes, $offset, $startedAt, &$lastWrite) {
    rec_require_curl();
    $in = @fopen($source, 'rb');
    if (!$in) throw new Exception('无法打开源文件');
    $ch = curl_init($url);
    curl_setopt_array($ch, array(
        CURLOPT_UPLOAD => true,
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_INFILE => $in,
        CURLOPT_INFILESIZE => $size,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HEADER => false,
        CURLOPT_CONNECTTIMEOUT => 30,
        CURLOPT_TIMEOUT => 0,
        CURLOPT_LOW_SPEED_LIMIT => 1024,
        CURLOPT_LOW_SPEED_TIME => 120,
        CURLOPT_NOPROGRESS => false,
        CURLOPT_XFERINFOFUNCTION => rec_progress_callback($status, $baseBytes, $size, $offset, $startedAt, $lastWrite),
    ));
    $body = curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $error = curl_error($ch);
    curl_close($ch);
    fclose($in);
    if ($body === false || $code < 200 || $code >= 300) {
        throw new Exception('HTTP ' . $code . ($error ? ' ' . $error : '') . ($body ? ': ' . substr((string)$body, 0, 300) : ''));
    }
    return true;
}

function rec_simple_request($url, $method, $headers = array(), $body = '', $timeout = 120) {
    rec_require_curl();
    // GitHub API 强制要求 User-Agent 头，部分服务器环境下 curl 默认 UA 会被剥离，必须显式设置
    $hasUA = false;
    foreach ($headers as $h) { if (stripos($h, 'User-Agent:') === 0) { $hasUA = true; break; } }
    if (!$hasUA) $headers[] = 'User-Agent: cf-pan-rec';
    $ch = curl_init($url);
    $options = array(
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 30,
        CURLOPT_TIMEOUT => $timeout,
    );
    if ($body !== '' || $method !== 'GET') $options[CURLOPT_POSTFIELDS] = $body;
    curl_setopt_array($ch, $options);
    $response = curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $error = curl_error($ch);
    curl_close($ch);
    if ($response === false || $code < 200 || $code >= 300) {
        throw new Exception('HTTP ' . $code . ($error ? ' ' . $error : '') . ($response ? ': ' . substr((string)$response, 0, 300) : ''));
    }
    return (string)$response;
}

function rec_upload_webdav($source, $hash, $size, $contentType, $fields, &$status, $baseBytes) {
    $endpoint = rtrim((string)($fields['webdav_endpoint'] ?? ''), '/') . '/';
    $user = (string)($fields['webdav_user'] ?? '');
    $pass = (string)($fields['webdav_pass'] ?? '');
    $folder = trim((string)($fields['webdav_folder'] ?? 'file'), '/');
    if (!$endpoint || !$user || !$pass) throw new Exception('WebDAV 配置不完整');
    $auth = 'Authorization: Basic ' . base64_encode($user . ':' . $pass);
    $built = '';
    foreach (explode('/', $folder) as $part) {
        if ($part === '') continue;
        $built .= '/' . rawurlencode($part);
        try { rec_simple_request(rtrim($endpoint, '/') . $built, 'MKCOL', array($auth)); } catch (Exception $e) {}
    }
    $startedAt = microtime(true);
    $lastWrite = 0;
    return rec_stream_request($endpoint . ltrim(rec_url_path($folder . '/' . $hash), '/'), 'PUT', array($auth, 'Content-Type: ' . $contentType), $source, $size, $status, $baseBytes, 0, $startedAt, $lastWrite);
}

function rec_upload_upyun($source, $hash, $size, $contentType, $fields, &$status, $baseBytes) {
    $bucket = (string)($fields['upyun_bucket'] ?? '');
    $operator = (string)($fields['upyun_operator'] ?? '');
    $password = (string)($fields['upyun_password'] ?? '');
    $endpoint = rtrim((string)($fields['upyun_endpoint'] ?? 'https://v0.api.upyun.com'), '/');
    $folder = trim((string)($fields['upyun_folder'] ?? 'file'), '/');
    if (!$bucket || !$operator || !$password) throw new Exception('又拍云配置不完整');
    $uri = rec_url_path($bucket . '/' . $folder . '/' . $hash);
    $date = gmdate('D, d M Y H:i:s') . ' GMT';
    $signature = md5('PUT&' . $uri . '&' . $date . '&' . md5($password));
    $headers = array('Authorization: UPYUN ' . $operator . ':' . $signature, 'Date: ' . $date, 'Content-Type: ' . $contentType, 'Mkdir: true');
    $startedAt = microtime(true);
    $lastWrite = 0;
    return rec_stream_request($endpoint . $uri, 'PUT', $headers, $source, $size, $status, $baseBytes, 0, $startedAt, $lastWrite);
}

function rec_upload_s3($source, $hash, $size, $contentType, $fields, &$status, $baseBytes, $isR2) {
    if ($isR2) {
        $account = (string)($fields['r2_account_id'] ?? '');
        $endpoint = (string)($fields['r2_endpoint'] ?? ($account ? 'https://' . $account . '.r2.cloudflarestorage.com' : ''));
        $bucket = (string)($fields['r2_bucket'] ?? '');
        $accessKey = (string)($fields['r2_access_key_id'] ?? '');
        $secretKey = (string)($fields['r2_secret_access_key'] ?? '');
        $region = 'auto';
    } else {
        $endpoint = (string)($fields['s3_endpoint'] ?? '');
        $bucket = (string)($fields['s3_bucket'] ?? '');
        $accessKey = (string)($fields['s3_ak'] ?? '');
        $secretKey = (string)($fields['s3_sk'] ?? '');
        $region = (string)($fields['s3_region'] ?? 'us-east-1');
    }
    if (!$endpoint || !$bucket || !$accessKey || !$secretKey) throw new Exception(($isR2 ? 'R2' : 'S3') . ' 直传配置不完整，需要 API Endpoint、Bucket、AccessKey 和 SecretKey');
    $parts = parse_url(rtrim($endpoint, '/'));
    if (!$parts || empty($parts['scheme']) || empty($parts['host'])) throw new Exception('S3 Endpoint 格式无效');
    $host = $parts['host'] . (isset($parts['port']) ? ':' . $parts['port'] : '');
    $basePath = isset($parts['path']) ? trim($parts['path'], '/') . '/' : '';
    $canonicalUri = rec_url_path($basePath . $bucket . '/file/' . $hash);
    $url = $parts['scheme'] . '://' . $host . $canonicalUri;
    $amzDate = gmdate('Ymd\THis\Z');
    $date = substr($amzDate, 0, 8);
    $payloadHash = hash_file('sha256', $source);
    $canonicalHeaders = 'content-type:' . trim($contentType) . "\n" . 'host:' . $host . "\n" . 'x-amz-content-sha256:' . $payloadHash . "\n" . 'x-amz-date:' . $amzDate . "\n";
    $signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
    $canonicalRequest = "PUT\n" . $canonicalUri . "\n\n" . $canonicalHeaders . "\n" . $signedHeaders . "\n" . $payloadHash;
    $scope = $date . '/' . $region . '/s3/aws4_request';
    $stringToSign = "AWS4-HMAC-SHA256\n" . $amzDate . "\n" . $scope . "\n" . hash('sha256', $canonicalRequest);
    $dateKey = hash_hmac('sha256', $date, 'AWS4' . $secretKey, true);
    $regionKey = hash_hmac('sha256', $region, $dateKey, true);
    $serviceKey = hash_hmac('sha256', 's3', $regionKey, true);
    $signingKey = hash_hmac('sha256', 'aws4_request', $serviceKey, true);
    $signature = hash_hmac('sha256', $stringToSign, $signingKey);
    $authorization = 'AWS4-HMAC-SHA256 Credential=' . $accessKey . '/' . $scope . ', SignedHeaders=' . $signedHeaders . ', Signature=' . $signature;
    $headers = array('Host: ' . $host, 'Content-Type: ' . $contentType, 'x-amz-content-sha256: ' . $payloadHash, 'x-amz-date: ' . $amzDate, 'Authorization: ' . $authorization);
    $startedAt = microtime(true);
    $lastWrite = 0;
    return rec_stream_request($url, 'PUT', $headers, $source, $size, $status, $baseBytes, 0, $startedAt, $lastWrite);
}

function rec_upload_qiniu($source, $hash, $size, $contentType, $fields, &$status, $baseBytes) {
    $ak = (string)($fields['qiniu_ak'] ?? '');
    $sk = (string)($fields['qiniu_sk'] ?? '');
    $bucket = (string)($fields['qiniu_bucket'] ?? '');
    $folder = trim((string)($fields['qiniu_folder'] ?? 'file'), '/');
    if (!$ak || !$sk || !$bucket) throw new Exception('七牛云配置不完整');
    $regionJson = rec_simple_request('https://api.qiniu.com/v2/query?ak=' . rawurlencode($ak) . '&bucket=' . rawurlencode($bucket), 'GET');
    $region = json_decode($regionJson, true);
    $hosts = array();
    foreach (array('acc', 'src') as $kind) {
        if (!empty($region['up'][$kind]['main'])) $hosts = array_merge($hosts, (array)$region['up'][$kind]['main']);
        if (!empty($region['up'][$kind]['backup'])) $hosts = array_merge($hosts, (array)$region['up'][$kind]['backup']);
    }
    if (!$hosts) throw new Exception('七牛云未返回上传区域');
    $policy = rec_b64url(json_encode(array('scope' => $bucket, 'deadline' => time() + 3600), JSON_UNESCAPED_SLASHES));
    $token = $ak . ':' . rec_b64url(hash_hmac('sha1', $policy, $sk, true)) . ':' . $policy;
    $in = fopen($source, 'rb');
    if (!$in) throw new Exception('无法打开源文件');
    $contexts = array();
    $uploaded = 0;
    $startedAt = microtime(true);
    $lastWrite = 0;
    try {
        while (!feof($in)) {
            $block = fread($in, 4 * 1024 * 1024);
            if ($block === false) throw new Exception('读取源文件失败');
            if ($block === '') break;
            $response = null;
            $errors = array();
            foreach (array_unique($hosts) as $host) {
                $url = (preg_match('~^https?://~', $host) ? rtrim($host, '/') : 'https://' . $host) . '/mkblk/' . strlen($block);
                $ch = curl_init($url);
                $callback = rec_progress_callback($status, $baseBytes, $size, $uploaded, $startedAt, $lastWrite);
                curl_setopt_array($ch, array(
                    CURLOPT_POST => true,
                    CURLOPT_POSTFIELDS => $block,
                    CURLOPT_HTTPHEADER => array('Authorization: UpToken ' . $token, 'Content-Type: application/octet-stream'),
                    CURLOPT_RETURNTRANSFER => true,
                    CURLOPT_CONNECTTIMEOUT => 30,
                    CURLOPT_TIMEOUT => 180,
                    CURLOPT_NOPROGRESS => false,
                    CURLOPT_XFERINFOFUNCTION => $callback,
                ));
                $body = curl_exec($ch);
                $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
                $error = curl_error($ch);
                curl_close($ch);
                if ($body !== false && $code >= 200 && $code < 300) { $response = json_decode($body, true); break; }
                $errors[] = $host . ' HTTP ' . $code . ($error ? ' ' . $error : '');
            }
            if (!$response || empty($response['ctx'])) throw new Exception('七牛分片上传失败: ' . implode(' | ', $errors));
            $contexts[] = $response['ctx'];
            $uploaded += strlen($block);
            $status['currentFileReceived'] = $uploaded;
            $status['processedBytes'] = $baseBytes + $uploaded;
            rec_status_write($status);
        }
    } finally {
        fclose($in);
    }
    if (!$contexts && $size > 0) throw new Exception('七牛分片上传未读取到文件');
    $key = rec_b64url($folder . '/' . $hash);
    $mime = rec_b64url($contentType);
    $errors = array();
    foreach (array_unique($hosts) as $host) {
        $url = (preg_match('~^https?://~', $host) ? rtrim($host, '/') : 'https://' . $host) . '/mkfile/' . $uploaded . '/key/' . $key . '/mimeType/' . $mime;
        try {
            rec_simple_request($url, 'POST', array('Authorization: UpToken ' . $token, 'Content-Type: text/plain'), implode(',', $contexts));
            return true;
        } catch (Exception $e) { $errors[] = $e->getMessage(); }
    }
    throw new Exception('七牛合并文件失败: ' . implode(' | ', $errors));
}

function rec_upload_github($source, $hash, $size, $contentType, $fields, &$status, $baseBytes) {
    // 与 Worker GitHubApiStorage 一致：Git Database API（blob → tree → commit → ref）
    $owner = (string)($fields['gh_owner'] ?? '');
    $repo = (string)($fields['gh_repo'] ?? '');
    $token = (string)($fields['gh_token'] ?? '');
    $ref = trim((string)($fields['gh_ref'] ?? ''));
    $apiBase = rtrim((string)($fields['gh_api_base'] ?? 'https://api.github.com'), '/');
    if (!$owner || !$repo || !$token) throw new Exception('GitHub 配置不完整（需要 owner/repo/token）');
    if ($size > 50 * 1024 * 1024) throw new Exception('GitHub 单文件上限 50MB');
    rec_require_curl();
    $auth = 'Authorization: Bearer ' . $token;
    $repoUrl = $apiBase . '/repos/' . rawurlencode($owner) . '/' . rawurlencode($repo);

    // 分支：优先 gh_ref，否则取仓库默认分支
    if ($ref === '') {
        $meta = json_decode(rec_simple_request($repoUrl, 'GET', array($auth)), true);
        $ref = (string)($meta['default_branch'] ?? 'main');
    }
    $branch = preg_replace('/[^A-Za-z0-9._-]/', '', $ref);
    if ($branch === '') $branch = 'main';
    // 与 Worker hashToPath 保持一致：file/完整hash（扁平）
    $path = 'file/' . $hash;

    // 大文件 base64 需要较多内存，宽松上调
    $mem = (int)ini_get('memory_limit');
    if ($mem > 0 && $mem < $size * 3 + 128 * 1024 * 1024) {
        @ini_set('memory_limit', (string)round($size * 3 + 128 * 1024 * 1024));
    }

    $startedAt = microtime(true);
    $tmp = tempnam(sys_get_temp_dir(), 'ghb64');
    if ($tmp === false) throw new Exception('无法创建临时文件');
    try {
        // 1. 源文件 → base64 临时文件（顺带推进进度）
        $in = fopen($source, 'rb');
        if ($in === false) throw new Exception('无法打开源文件: ' . $source);
        $out = fopen($tmp, 'wb');
        if ($out === false) { fclose($in); throw new Exception('无法创建临时文件'); }
        stream_filter_append($out, 'convert.base64-encode');
        // 本地 base64 转换是磁盘操作（可达数百 MB/s），不计入上传进度/速度，避免显示假速度
        while (!feof($in)) {
            $chunk = fread($in, 8 * 1024 * 1024);
            if ($chunk === false || $chunk === '') break;
            if (fwrite($out, $chunk) === false) throw new Exception('写入临时文件失败');
        }
        fclose($out);
        fclose($in);

        // 2. 组装 blob JSON 到临时文件（避免 100MB+ base64 字符串常驻内存）
        $jsonTmp = tempnam(sys_get_temp_dir(), 'ghjson');
        if ($jsonTmp === false) throw new Exception('无法创建临时文件');
        $w = fopen($jsonTmp, 'wb');
        fwrite($w, '{"content":"');
        $r = fopen($tmp, 'rb');
        while (!feof($r)) {
            $chunk = fread($r, 8 * 1024 * 1024);
            if ($chunk === false || $chunk === '') break;
            fwrite($w, $chunk);
        }
        fclose($r);
        fwrite($w, '","encoding":"base64"}');
        fclose($w);
        unlink($tmp);
        $jsonTotal = filesize($jsonTmp);

        // 3. POST /git/blobs（流式上传，带进度；JSON 字节按比例映射回源文件字节）
        $ch = curl_init($repoUrl . '/git/blobs');
        $in = fopen($jsonTmp, 'rb');
        $lastWrite = 0.0;
        curl_setopt_array($ch, array(
            CURLOPT_CUSTOMREQUEST => 'POST',
            CURLOPT_HTTPHEADER => array($auth, 'Content-Type: application/json', 'User-Agent: cf-pan-rec'),
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 30,
            CURLOPT_TIMEOUT => 600,
            CURLOPT_UPLOAD => true,
            CURLOPT_INFILE => $in,
            CURLOPT_INFILESIZE => $jsonTotal,
            CURLOPT_NOPROGRESS => false,
            CURLOPT_XFERINFOFUNCTION => function($ch, $dlTotal, $dlNow, $ulTotal, $ulNow) use (&$status, &$baseBytes, &$size, &$startedAt, $jsonTotal, &$lastWrite) {
                $srcDone = $jsonTotal > 0 ? (int)min($size, (int)floor($ulNow / $jsonTotal * $size)) : 0;
                $status['currentFileReceived'] = $srcDone;
                $status['processedBytes'] = $baseBytes + $srcDone;
                $elapsed = microtime(true) - $startedAt;
                $status['currentFileSpeed'] = $elapsed > 0 ? (int)($srcDone / $elapsed) : 0;
                $now = microtime(true);
                if ($now - $lastWrite >= 0.2 || $srcDone >= $size) {
                    $lastWrite = $now;
                    rec_status_write($status);
                }
                return 0;
            },
        ));
        $body = curl_exec($ch);
        $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $error = curl_error($ch);
        curl_close($ch);
        fclose($in);
        @unlink($jsonTmp);
        if ($body === false || $code < 200 || $code >= 300) {
            throw new Exception('GitHub blob 上传失败 HTTP ' . $code . ($error ? ' ' . $error : '') . ($body ? ': ' . substr((string)$body, 0, 300) : ''));
        }
        $blobRes = json_decode((string)$body, true);
        $blobSha = (string)($blobRes['sha'] ?? '');
        if ($blobSha === '') throw new Exception('GitHub blob 创建失败');

        // 4. 取当前分支指向的 commit/tree（空仓库则跳过）
        $parentSha = '';
        $baseTreeSha = '';
        try {
            $refRes = json_decode(rec_simple_request($repoUrl . '/git/refs/heads/' . $branch, 'GET', array($auth)), true);
            $parentSha = (string)($refRes['object']['sha'] ?? '');
            if ($parentSha !== '') {
                $commitRes = json_decode(rec_simple_request($repoUrl . '/git/commits/' . $parentSha, 'GET', array($auth)), true);
                $baseTreeSha = (string)($commitRes['tree']['sha'] ?? '');
            }
        } catch (Exception $e) {}

        // 5. 创建 tree（挂载新文件）
        $treeBody = array('tree' => array(array('path' => $path, 'mode' => '100644', 'type' => 'blob', 'sha' => $blobSha)));
        if ($baseTreeSha !== '') $treeBody['base_tree'] = $baseTreeSha;
        $treeRes = json_decode(rec_simple_request($repoUrl . '/git/trees', 'POST', array($auth, 'Content-Type: application/json'), json_encode($treeBody)), true);
        $newTreeSha = (string)($treeRes['sha'] ?? '');
        if ($newTreeSha === '') throw new Exception('GitHub tree 创建失败');

        // 6. 创建 commit
        $commitBody = array('message' => 'upload ' . $hash, 'tree' => $newTreeSha);
        if ($parentSha !== '') $commitBody['parents'] = array($parentSha);
        $commitRes = json_decode(rec_simple_request($repoUrl . '/git/commits', 'POST', array($auth, 'Content-Type: application/json'), json_encode($commitBody)), true);
        $newCommitSha = (string)($commitRes['sha'] ?? '');
        if ($newCommitSha === '') throw new Exception('GitHub commit 创建失败');

        // 7. 更新分支引用（空仓库先用文档端点 POST /git/refs 创建 ref）
        if ($parentSha === '') {
            $refRes = json_decode(rec_simple_request($repoUrl . '/git/refs', 'POST', array($auth, 'Content-Type: application/json'), json_encode(array('ref' => 'refs/heads/' . $branch, 'sha' => $newCommitSha))), true);
            if (($refRes['ref'] ?? '') === '') throw new Exception('GitHub ref 创建失败');
        } else {
            rec_simple_request($repoUrl . '/git/refs/heads/' . $branch, 'PATCH', array($auth, 'Content-Type: application/json'), json_encode(array('sha' => $newCommitSha, 'force' => false)));
        }
        $status['currentFileReceived'] = $size;
        $status['processedBytes'] = $baseBytes + $size;
        rec_status_write($status);
        return true;
    } catch (Exception $e) {
        if (isset($tmp) && is_file($tmp)) @unlink($tmp);
        throw $e;
    }
}

function rec_upload_direct($config, $source, $hash, $size, $contentType, &$status, $baseBytes) {
    $type = strtolower((string)($config['storage_type'] ?? ''));
    $fields = is_array($config['storage_fields'] ?? null) ? $config['storage_fields'] : array();
    if ($type === 'qiniu') return rec_upload_qiniu($source, $hash, $size, $contentType, $fields, $status, $baseBytes);
    if ($type === 'webdav') return rec_upload_webdav($source, $hash, $size, $contentType, $fields, $status, $baseBytes);
    if ($type === 'upyun') return rec_upload_upyun($source, $hash, $size, $contentType, $fields, $status, $baseBytes);
    if ($type === 's3') return rec_upload_s3($source, $hash, $size, $contentType, $fields, $status, $baseBytes, false);
    if ($type === 'r2') return rec_upload_s3($source, $hash, $size, $contentType, $fields, $status, $baseBytes, true);
    if ($type === 'github') return rec_upload_github($source, $hash, $size, $contentType, $fields, $status, $baseBytes);
    throw new Exception('暂不支持目标存储直传: ' . $type);
}

function rec_find_local_file($settings, $hash) {
    $roots = array();
    if (!empty($settings['filepath']) && is_dir($settings['filepath'])) $roots[] = rtrim($settings['filepath'], '/\\');
    $roots[] = __DIR__ . '/file';
    $roots[] = __DIR__ . '/incloud';
    foreach ($roots as $root) {
        foreach (array('', 'file', 'incloud') as $prefix) {
            $path = $root . ($prefix ? '/' . $prefix : '') . '/' . $hash;
            if (is_file($path) && is_readable($path)) return $path;
        }
    }
    return null;
}

function rec_export_config() {
    $file = rec_config_path();
    if (!is_file($file)) return null;
    if (!defined('REC_ALLOW_RESTORE_CONFIG')) define('REC_ALLOW_RESTORE_CONFIG', 1);
    $cfg = @include $file;
    return is_array($cfg) ? $cfg : null;
}

function rec_session_ok($config) {
    if (!is_array($config) || empty($config['auth_token'])) return false;
    $cookie = (string)($_COOKIE['rec_session'] ?? '');
    return $cookie !== '' && hash_equals(hash('sha256', (string)$config['auth_token']), $cookie);
}

function rec_browser_status() {
    header('Content-Type: application/json; charset=utf-8');
    $cfg = rec_export_config();
    if (is_array($cfg)) {
        // 敏感字段不通过公开 JSON 返回（页面/Worker 轮询只需要状态部分）
        unset($cfg['admin_user'], $cfg['admin_password'], $cfg['storage_fields'], $cfg['auth_token']);
    }
    echo json_encode(array('ok' => true, 'config' => $cfg, 'status' => rec_status_read()), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function rec_browser_set_config() {
    $input = json_decode(file_get_contents('php://input'), true);
    if (!is_array($input)) rec_fail('请求格式无效');
    $adminUser = (string)($input['admin_user'] ?? '');
    $adminPass = (string)($input['admin_password'] ?? '');
    $storageType = preg_replace('/[^a-z0-9_-]/', '', (string)($input['storage_type'] ?? ''));
    $storageFields = is_array($input['storage_fields'] ?? null) ? $input['storage_fields'] : array();
    $authToken = (string)($input['auth_token'] ?? '');
    if ($authToken === '') {
        // 未提供新令牌时保留已有令牌，避免旧版 Worker 覆盖后降级为密码模式
        $existing = rec_export_config();
        if (is_array($existing) && !empty($existing['auth_token'])) $authToken = (string)$existing['auth_token'];
    }
    $workerUrl = (string)($input['worker_url'] ?? '');
    if ($workerUrl !== '' && !preg_match('~^https?://~i', $workerUrl)) $workerUrl = '';
    if (!$storageType || !$adminUser || !$adminPass) rec_fail('缺少参数');

    $db = rec_db();
    $settings = rec_settings($db);
    if ($adminUser !== (string)($settings['admin_user'] ?? '') || !hash_equals((string)($settings['admin_pwd'] ?? ''), $adminPass)) {
        rec_fail('管理员密码错误');
    }

    $fileRows = $db->query('SELECT id, name, type, size, hash FROM pre_file ORDER BY id')->fetchAll();
    $config = array(
        'storage_type' => $storageType,
        'storage_fields' => $storageFields,
        'admin_user' => $adminUser,
        'admin_password' => $adminPass,
        'auth_token' => $authToken,
        'worker_url' => $workerUrl,
        'file_count' => count($fileRows),
        'total_size' => array_sum(array_map(function($r){ return (int)$r['size']; }, $fileRows)),
        'files' => array(),
    );
    foreach ($fileRows as $row) {
        $config['files'][] = array('id' => (int)$row['id'], 'name' => $row['name'], 'type' => $row['type'], 'size' => (int)$row['size'], 'hash' => $row['hash']);
    }
    // 配置包含存储密钥和管理员密码，写入 .php 文件而非 .json，避免被直接访问泄露。
    $phpConfig = "<?php\n"
        . "// 由 rec.php 自动生成，包含敏感信息，禁止直接访问或下载。\n"
        . "if (!defined('REC_ALLOW_RESTORE_CONFIG')) { http_response_code(403); exit; }\n"
        . "return " . var_export($config, true) . ";\n";
    if (@file_put_contents(rec_config_path(), $phpConfig) === false) rec_fail('无法写入恢复配置文件，请检查目录权限');
    @unlink(__DIR__ . '/restore_config.json');
    rec_status_write(array('status' => 'ready', 'total' => count($fileRows), 'processed' => 0, 'success' => 0, 'failed' => 0, 'skipped' => 0, 'current' => '', 'errors' => array(), 'logs' => array(), 'totalBytes' => $config['total_size'], 'processedBytes' => 0, 'currentFileReceived' => 0, 'currentFileTotal' => 0, 'currentFileSpeed' => 0));
    echo json_encode(array('ok' => true, 'file_count' => count($fileRows), 'total_size' => $config['total_size']), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function rec_worker_export($data, $plaintext = false) {
    $db = rec_db();
    $settings = rec_settings($db);
    $user = (string)($data['admin_user'] ?? '');
    $pass = (string)($data['admin_password'] ?? '');
    if ($user === '' || !hash_equals((string)($settings['admin_user'] ?? ''), $user) || !hash_equals((string)($settings['admin_pwd'] ?? ''), $pass)) {
        rec_fail('原站管理员账号或密码错误', 403);
    }
    $fileRows = $db->query('SELECT id,name,type,size,hash,addtime,lasttime,ip,hide,pwd,block,count,uid FROM pre_file ORDER BY id')->fetchAll();
    $sql = "-- remote restore export\n";
    $sql .= "INSERT INTO `pre_config` (`k`,`v`) VALUES\n";
    $vals = array();
    foreach ($settings as $k => $v) {
        $vals[] = '(' . rec_sql($k) . ',' . rec_sql($v) . ')';
    }
    $sql .= implode(",\n", $vals) . ";\n";
    $sql .= "INSERT INTO `pre_file` (`id`,`name`,`type`,`size`,`hash`,`addtime`,`lasttime`,`ip`,`hide`,`pwd`,`block`,`count`,`uid`) VALUES\n";
    $vals = array();
    foreach ($fileRows as $row) {
        $vals[] = '(' . implode(',', array_map('rec_sql', array($row['id'], $row['name'], $row['type'], $row['size'], $row['hash'], $row['addtime'], $row['lasttime'], $row['ip'], $row['hide'], $row['pwd'], $row['block'], $row['count'], $row['uid']))) . ')';
    }
    $sql .= implode(",\n", $vals) . ";\n";
    $payload = array('sql' => $sql, 'fileCount' => count($fileRows), 'settings' => $settings, 'serverTime' => time());
    header('Content-Type: application/json; charset=utf-8');
    if ($plaintext) {
        echo json_encode(array('ok' => true, 'data' => $payload), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }
    echo json_encode(array('ok' => true, 'payload' => rec_encrypt($payload)), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function rec_browser_restore_exec() {
    // 网关/nginx 超时（504）会断开连接，但 PHP 应继续执行完当前文件，
    // 并持续写 restore_status.json，供前端轮询后自动续传。
    @ignore_user_abort(true);
    @set_time_limit(0);
    $input = json_decode(file_get_contents('php://input'), true);
    if (!is_array($input)) rec_fail('请求格式无效');
    $startFrom = max(0, (int)($input['start'] ?? 0));
    // 恢复配置由 set-config 写入（写入前已校验原站管理员凭据）。
    // 访问认证：会话 Cookie（Worker 向导令牌授权）或原站管理员账号密码二选一。
    $config = rec_export_config();
    if (!$config) rec_fail('配置不存在');
    $authOK = rec_session_ok($config);
    if (!$authOK) {
        $adminUser = (string)($input['admin_user'] ?? '');
        $adminPass = (string)($input['admin_password'] ?? '');
        $authOK = $adminUser !== ''
            && $adminUser === (string)($config['admin_user'] ?? '')
            && hash_equals((string)($config['admin_password'] ?? ''), $adminPass);
    }
    if (!$authOK) rec_fail('未授权：请使用 Worker 安装向导提供的恢复链接访问，或输入原站管理员账号密码');

    // 并发保护：同一时间只允许一个 restore-exec 在执行。
    // 网关超时后前端会重发请求，若原 PHP 进程还活着（flock 仍被持有）则直接返回当前状态；
    // 若原进程已死，flock 自动释放，新请求可重新处理。
    $lockFp = @fopen(rec_status_path() . '.lock', 'c');
    $locked = is_resource($lockFp) && @flock($lockFp, LOCK_EX | LOCK_NB);
    if (!$locked) {
        $st = rec_status_read();
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(array(
            'ok' => true,
            'processed' => (int)($st['processed'] ?? 0),
            'total' => (int)($st['total'] ?? 0),
            'status' => (is_array($st) && !empty($st['status'])) ? $st['status'] : 'running',
        ), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if (is_resource($lockFp)) fclose($lockFp);
        exit;
    }

    $db = rec_db();
    $settings = rec_settings($db);

    $files = $config['files'];
    $total = count($files);
    // 状态延续：读取已有状态，累计 success/failed/processedBytes；重跑时若 processed 落后于传入 start 则重置。
    $status = rec_status_read();
    if (!is_array($status)) $status = array();

    // 幂等续传：上一次请求已处理完 startFrom（响应可能因 504 丢失），直接返回进度，避免重复上传。
    if ((int)($status['processed'] ?? 0) > $startFrom && ($status['status'] ?? '') === 'idle') {
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(array(
            'ok' => true,
            'processed' => (int)$status['processed'],
            'total' => $total,
            'status' => 'idle',
        ), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }
    // 已整体完成：直接返回完成状态（前端会刷新页面）。
    if (($status['status'] ?? '') === 'completed') {
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(array('ok' => true, 'processed' => (int)($status['processed'] ?? $total), 'total' => $total, 'status' => 'completed'), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }

    $status['status'] = 'running';
    $status['total'] = $total;
    $status['totalBytes'] = 0;
    foreach ($files as $f) $status['totalBytes'] += (int)$f['size'];
    if ((int)($status['processed'] ?? 0) === 0) {
        $status['processed'] = $startFrom;
        $status['success'] = 0;
        $status['failed'] = 0;
        $status['skipped'] = 0;
        $status['processedBytes'] = 0;
        $status['errors'] = array();
    } elseif ((int)$status['processed'] < $startFrom) {
        // 前端重试超限跳过了失败文件：只前进 processed，保留已累计统计，不重置。
        if (isset($files[(int)$status['processed']])) {
            $status['logs'][] = date('c') . ' 跳过: ' . $files[(int)$status['processed']]['name'] . ' (重试超限)';
        }
        $status['processed'] = $startFrom;
    }

    if ($startFrom >= $total) {
        $status['status'] = 'completed';
        rec_status_write($status);
        echo json_encode(array('ok' => true, 'processed' => $total, 'total' => $total, 'status' => 'completed'), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }

    // 每次只处理一个文件。
    $file = $files[$startFrom];
    $hash = (string)$file['hash'];
    $name = (string)$file['name'];
    $size = (int)$file['size'];
    $status['current'] = $name;
    $status['currentFileTotal'] = $size;
    // 扣除上次异常中断遗留的当前文件字节，避免重试后已上传大小被重复累计。
    $status['processedBytes'] = max(0, (int)$status['processedBytes'] - (int)$status['currentFileReceived']);
    $status['currentFileReceived'] = 0;
    $status['currentFileSpeed'] = 0;
    $status['logs'][] = date('c') . ' 开始: ' . $name . ' (' . $size . ' bytes)';
    if (count($status['logs']) > 200) array_shift($status['logs']);
    rec_status_write($status);

    // 立即返回响应并在后台继续执行，避免网关 60s 超时把正在上传的进程杀掉。
    header('Content-Type: application/json; charset=utf-8');
    if (!function_exists('fastcgi_finish_request')) header('Connection: close');
    echo json_encode(array('ok' => true, 'processed' => $startFrom, 'total' => $total, 'status' => 'running'), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if (function_exists('fastcgi_finish_request')) {
        @fastcgi_finish_request();
    } else {
        while (ob_get_level()) @ob_end_flush();
        @ob_implicit_flush(true);
        flush();
    }

    $source = rec_find_local_file($settings, $hash);
    $fileBaseBytes = (int)$status['processedBytes'];
    $targetType = strtolower((string)($config['storage_type'] ?? ''));
    if (!$source) {
        $status['processedBytes'] = $fileBaseBytes;
        $status['failed']++;
        $status['errors'][] = $name . ': 文件不存在';
        $status['logs'][] = date('c') . ' 失败: ' . $name . ' 文件不存在';
    } elseif ($targetType === 'github' && $size > 50 * 1024 * 1024) {
        // GitHub API 单文件上限 50MB，直接跳过不上传。
        $status['processedBytes'] = $fileBaseBytes;
        $status['skipped'] = (int)($status['skipped'] ?? 0) + 1;
        $status['errors'][] = $name . ': 超过 50MB，GitHub 存储跳过';
        $status['logs'][] = date('c') . ' 跳过: ' . $name . ' (>50MB, GitHub)';
    } else {
        $contentType = $file['type'] ? 'application/' . $file['type'] : 'application/octet-stream';
        try {
            // 直接把源文件流式发送到目标存储，进度回调统计真实网络上传字节。
            $ok = rec_upload_direct($config, $source, $hash, $size, $contentType, $status, $fileBaseBytes);
        } catch (Exception $e) {
            $ok = false;
            $status['logs'][] = date('c') . ' 异常: ' . $name . ' ' . $e->getMessage();
        }

        if (!$ok) {
            $status['processedBytes'] = $fileBaseBytes;
            $status['failed']++;
            $status['errors'][] = $name . ': 上传失败';
            $status['logs'][] = date('c') . ' 失败: ' . $name . ' 上传失败';
        } else {
            $status['currentFileReceived'] = $size;
            $status['processedBytes'] = min((int)$status['totalBytes'], $fileBaseBytes + $size);
            $status['success']++;
            $status['logs'][] = date('c') . ' 成功: ' . $name;
        }
    }
    $status['processed'] = $startFrom + 1;
    $status['current'] = '';
    $status['currentFileTotal'] = 0;
    $status['currentFileReceived'] = 0;
    $status['currentFileSpeed'] = 0;
    $status['status'] = 'idle';
    rec_status_write($status);
    exit;
}

function rec_db() {
    require __DIR__ . '/config.php';
    try {
        return new PDO('mysql:host=' . $dbconfig['host'] . ';dbname=' . $dbconfig['dbname'] . ';port=' . $dbconfig['port'] . ';charset=utf8mb4', $dbconfig['user'], $dbconfig['pwd'], array(PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC));
    } catch (Exception $e) {
        rec_fail('连接数据库失败: ' . $e->getMessage(), 500);
    }
}

function rec_settings($db) {
    $rows = $db->query('SELECT k, v FROM pre_config')->fetchAll();
    $out = array();
    foreach ($rows as $row) $out[(string)$row['k']] = (string)$row['v'];
    return $out;
}

function rec_page() {
    $status = rec_status_read();
    $config = rec_export_config();
    $hasConfig = is_array($config) && !empty($config['files']);
    $isCompleted = is_array($status) && ($status['status'] ?? '') === 'completed';
    // 会话认证：带令牌链接（Worker 向导下发）可免密码，陌生设备仍需原站管理员密码。
    $sessionOK = rec_session_ok($config);
    $tokenParam = isset($_GET['t']) ? trim((string)$_GET['t']) : '';
    if (!$sessionOK && $tokenParam !== '' && is_array($config) && !empty($config['auth_token']) && hash_equals((string)$config['auth_token'], $tokenParam)) {
        setcookie('rec_session', hash('sha256', (string)$config['auth_token']), time() + 604800, '/', '', !empty($_SERVER['HTTPS']), true);
        $sessionOK = true;
    }
    $workerUrl = isset($_GET['worker_url']) ? trim((string)$_GET['worker_url']) : '';
    if ($workerUrl !== '' && !preg_match('~^https?://~i', $workerUrl)) $workerUrl = '';
    if ($workerUrl === '' && is_array($config) && isset($config['worker_url'])) {
        $workerUrl = trim((string)$config['worker_url']);
        if ($workerUrl !== '' && !preg_match('~^https?://~i', $workerUrl)) $workerUrl = '';
    }
    $backUrl = $workerUrl;
    if ($backUrl !== '') $backUrl .= (strpos($backUrl, '?') !== false ? '&' : '?') . 'restore_done=1';
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-store');
    ?>
<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>原站文件恢复</title>
<style>
body{font-family:Arial,"Microsoft YaHei",sans-serif;background:#f5f5f5;color:#333;padding:20px}
.box{max-width:980px;margin:0 auto;background:#fff;border:1px solid #ddd;border-radius:6px;padding:20px}
.progress-wrap{background:#e9ecef;border-radius:4px;height:20px;overflow:hidden}
.progress-bar{background:#3c78a8;height:100%;color:#fff;font-size:12px;line-height:20px;text-align:center;white-space:nowrap}
.btn{display:inline-block;padding:8px 18px;border:0;border-radius:4px;background:#3c78a8;color:#fff;text-decoration:none;cursor:pointer}
.muted{color:#777;font-size:13px}
#logs{max-height:280px;overflow:auto;background:#f8f9fa;border:1px solid #eee;padding:8px;font-size:12px;font-family:monospace}
.row{margin:10px 0}
input{padding:6px 10px;border:1px solid #ccc;border-radius:4px;font-size:14px;background:#fff;color:#333}
@media (prefers-color-scheme: dark){
  body{background:#111;color:#ddd}
  .box{background:#1d1d1d;border-color:#333}
  .progress-wrap{background:#2c2c2c}
  .progress-bar{background:#2e6da4}
  .muted{color:#999}
  #logs{background:#161616;border-color:#333;color:#bbb}
  input{background:#252525;border:1px solid #444;color:#ddd}
}
</style></head><body><div class="box">
<h1>原站文件恢复</h1>
<?php if ($isCompleted): ?>
<div style="text-align:center;padding:30px">
  <h2 style="color:#2e8b57">恢复已完成</h2>
  <p class="muted">全部文件已恢复并上传完成</p>
  <?php if ($backUrl !== ''): ?>
  <div class="row"><a class="btn" href="<?php echo rec_esc($backUrl); ?>">返回 Worker 站点 <span style="font-size:12px">&#8611;</span></a></div>
  <?php else: ?>
  <div class="row muted">未提供 Worker 地址，请关闭此页面</div>
  <?php endif; ?>
</div>
<?php elseif ($hasConfig): ?>
<div id="step-config">
  <div class="row">检测到待恢复文件 <b><?php echo (int)$config['file_count']; ?></b> 个，总大小 <b><?php echo rec_size($config['total_size']); ?></b></div>
  <div class="row"><label>目标存储</label><input id="cfgStorageType" value="<?php echo rec_esc($config['storage_type'] ?? ''); ?>" readonly></div>
  <?php if ($sessionOK): ?>
  <div class="row muted">已通过 Worker 安装向导授权，无需输入密码。恢复完成后在原站页面点击"返回 Worker 站点"即可。</div>
  <?php else: ?>
  <div class="row"><label>管理员账号</label><input id="cfgAdminUser" placeholder="请输入原站管理员账号"></div>
  <div class="row"><label>管理员密码</label><input id="cfgAdminPass" type="password" placeholder="请输入原站管理员密码"></div>
  <div class="row muted">此页面访问未授权，需要原站管理员账号密码认证后才能开始恢复。</div>
  <?php endif; ?>
  <div class="row"><button class="btn" id="btnStart" onclick="startRestore()">开始恢复</button> <span id="cfgError" style="color:#c00"></span></div>
</div>
<div id="restore-progress" style="display:none;margin-top:18px">
  <h2>恢复进度</h2>
  <div class="muted">总进度</div>
  <div class="progress-wrap"><div class="progress-bar" id="barTotal" style="width:0%">0%</div></div>
  <div class="row muted">已处理文件: <span id="doneCount">0</span> / <span id="totalCount">0</span> | 已上传大小: <span id="doneBytes">0</span> / <span id="totalBytes">0</span> | 成功: <span id="okCount">0</span> | 失败: <span id="failCount">0</span> | 跳过: <span id="skipCount">0</span></div>
  <div class="muted">当前文件</div>
  <div class="progress-wrap"><div class="progress-bar" id="barCurrent" style="width:0%">0%</div></div>
  <div class="row muted">当前: <span id="curFile">-</span> | 文件大小: <span id="curBytes">0</span> | 速度: <span id="curSpeed">0</span>/s</div>
  <div id="logs"></div>
</div>
<div id="restore-done" style="display:none;margin-top:18px;text-align:center">
  <h2 style="color:#2e8b57">恢复完成</h2>
  <p id="doneSummary" class="muted"></p>
  <div id="doneFailList" style="display:none;margin-top:14px;text-align:left;max-width:640px;margin-left:auto;margin-right:auto"></div>
  <?php if ($backUrl !== ''): ?>
  <div class="row"><a class="btn" id="btnBackWorker" href="<?php echo rec_esc($backUrl); ?>">返回 Worker 站点 <span style="font-size:12px">&#8611;</span></a></div>
  <div class="muted" style="margin-top:10px">点击返回后在 Worker 端确认恢复结果</div>
  <?php else: ?>
  <div class="row muted">未提供 Worker 地址，无法返回</div>
  <?php endif; ?>
</div>
<script>
function esc(s){var d=document.createElement('div');d.appendChild(document.createTextNode(s));return d.innerHTML;}
function formatSize(n){n=Number(n)||0; if(n>=1073741824)return (n/1073741824).toFixed(1)+' GB'; if(n>=1048576)return (n/1048576).toFixed(1)+' MB'; if(n>=1024)return (n/1024).toFixed(1)+' KB'; return n+' B';}
function renderStatus(s){if(!s)return;var totalB=s.totalBytes||0;var pct=totalB>0?Math.floor((s.processedBytes||0)*100/totalB):(s.total>0?Math.floor(s.processed*100/s.total):0);document.getElementById('barTotal').style.width=pct+'%';document.getElementById('barTotal').innerText=pct+'%';document.getElementById('doneCount').innerText=s.processed||0;document.getElementById('totalCount').innerText=s.total||0;document.getElementById('doneBytes').innerText=formatSize(s.processedBytes||0);document.getElementById('totalBytes').innerText=formatSize(s.totalBytes||0);document.getElementById('okCount').innerText=s.success||0;document.getElementById('failCount').innerText=s.failed||0;document.getElementById('skipCount').innerText=s.skipped||0;var cpct=s.currentFileTotal>0?Math.floor((s.currentFileReceived||0)*100/s.currentFileTotal):0;document.getElementById('barCurrent').style.width=cpct+'%';document.getElementById('barCurrent').innerText=cpct+'%';document.getElementById('curFile').innerText=s.current||'-';document.getElementById('curBytes').innerText=formatSize(s.currentFileReceived||0)+' / '+formatSize(s.currentFileTotal||0);document.getElementById('curSpeed').innerText=formatSize(s.currentFileSpeed||0);var html='';if(s.logs){for(var i=s.logs.length-1;i>=0&&i>=s.logs.length-80;i--)html+='<div>'+esc(s.logs[i])+'</div>';}document.getElementById('logs').innerHTML=html;}
function startRestore(){var user=document.getElementById('cfgAdminUser')?document.getElementById('cfgAdminUser').value:'';var pass=document.getElementById('cfgAdminPass')?document.getElementById('cfgAdminPass').value:'';var needAuth=!!document.getElementById('cfgAdminUser');if(needAuth&&!user){document.getElementById('cfgError').innerText='请输入管理员账号';return;}if(needAuth&&!pass){document.getElementById('cfgError').innerText='请输入管理员密码';return;}document.getElementById('cfgError').innerText='';document.getElementById('step-config').style.display='none';document.getElementById('restore-progress').style.display='block';document.getElementById('btnStart').disabled=true;document.getElementById('btnStart').innerText='恢复中...';var cfg={};if(user&&pass){cfg.admin_user=user;cfg.admin_password=pass;}var running=false,stopped=false;
function finish(){stopped=true;document.getElementById('restore-progress').style.display='none';document.getElementById('restore-done').style.display='block';fetch('?action=status').then(function(r){return r.json()}).then(function(j){var s=j&&j.status;if(s){document.getElementById('doneSummary').innerText='共 '+s.total+' 个文件，成功 '+s.success+' 个，失败 '+(s.failed||0)+' 个，跳过 '+(s.skipped||0)+' 个，已上传 '+formatSize(s.processedBytes||0);var box=document.getElementById('doneFailList');var items=[];if(s.errors){for(var i=0;i<s.errors.length;i++){var line=s.errors[i];var isSkip=line.indexOf('跳过')>=0||line.indexOf('>50MB')>=0;items.push('<div style="padding:4px 8px;border-bottom:1px solid #eee">'+(isSkip?'<span style="color:#d1900b">&#8678; 跳过</span>':'<span style="color:#c00">&#10008; 失败</span>')+'&nbsp; '+esc(line)+'</div>');}}if(items.length){box.innerHTML='<div style="background:#f8f9fa;border:1px solid #eee;border-radius:4px;padding:8px"><h4 style="margin:4px 0 8px 0;text-align:center">失败 / 跳过 明细</h4>'+items.join('')+'</div>';box.style.display='block';}}}).catch(function(){});}
function fail(msg){stopped=true;running=false;document.getElementById('cfgError').innerText='请求失败: '+msg;document.getElementById('btnStart').disabled=false;document.getElementById('btnStart').innerText='继续恢复';}
function sendExec(start,cb){cfg.start=start||0;fetch('?action=restore-exec',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(cfg)}).then(function(r){return r.text();}).then(function(text){var j=null;try{j=JSON.parse(text);}catch(e){}cb(j);}).catch(function(e){cb(null);});}
function resumeOnStatus(start,failCount){if(stopped)return;fetch('?action=status').then(function(r){return r.json()}).then(function(j){var s=j&&j.status?j.status:null;if(!s){retryWait(start,failCount);return;}if(s.status==='completed'||(s.processed||0)>=(s.total||0)){finish();return;}if((s.processed||0)>start){setTimeout(function(){next(s.processed);},300);return;}if(s.status==='running'&&s.current){var stale=s.updatedAt?(Math.floor(Date.now()/1000)-s.updatedAt):-1;if(stale<0||stale<120){setTimeout(function(){resumeOnStatus(start,failCount);},1500);return;}setTimeout(function(){next(start);},300);return;}if(failCount>30){fail('多次重试无进展，请检查服务器日志');return;}setTimeout(function(){next(start);},1500);}).catch(function(){retryWait(start,failCount);});}
function retryWait(start,failCount){if(stopped)return;if(failCount>30){fail('状态查询失败，请刷新后重试');return;}setTimeout(function(){resumeOnStatus(start,failCount+1);},2000);}
var lastStart=-1,fileRetries=0;
function next(start){if(stopped||running)return;start=start||0;if(start!==lastStart){lastStart=start;fileRetries=0;}if(fileRetries>=3){document.getElementById('curFile').innerText='重试超限，跳过当前文件';fileRetries=0;next(start+1);return;}fileRetries++;running=true;sendExec(start,function(j){running=false;if(stopped)return;if(!j||!j.ok){if(j&&j.error){fail(j.error);return;}resumeOnStatus(start||0,0);return;}if(j.status==='completed'||(j.processed||0)>=(j.total||0)){finish();return;}if(j.status==='running'){setTimeout(function(){resumeOnStatus(start||0,0);},500);return;}setTimeout(function(){next(j.processed);},200);});}
next();}
setInterval(function(){fetch('?action=status').then(function(r){return r.json()}).then(function(j){if(j&&j.status)renderStatus(j.status);});},1000);
</script>
<?php else: ?>
<div style="text-align:center;padding:30px">
  <h2>暂无恢复任务</h2>
  <p>请先通过 Worker 安装向导保存恢复配置，然后刷新此页面。</p>
</div>
<?php endif; ?>
</div></body></html>
<?php
    exit;
}

$action = isset($_GET['action']) ? $_GET['action'] : '';
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $body = json_decode(file_get_contents('php://input'), true);
    if (is_array($body) && (($body['action'] ?? '') === 'export')) {
        if (isset($body['signature'])) {
            rec_worker_export(rec_auth($body));
        } else {
            // 明文模式：管理员账号密码鉴权（rec_worker_export 内部校验），无需共享密钥
            $user = (string)($body['admin_user'] ?? '');
            $pass = (string)($body['admin_password'] ?? '');
            if ($user === '' || $pass === '') rec_fail('缺少管理员账号密码', 403);
            rec_worker_export(array('admin_user' => $user, 'admin_password' => $pass), true);
        }
    }
}
if ($action === 'set-config') rec_browser_set_config();
if ($action === 'status') rec_browser_status();
if ($action === 'restore-exec') rec_browser_restore_exec();
if ($_SERVER['REQUEST_METHOD'] === 'GET') rec_page();
rec_log('不支持的操作', array('action' => $action, 'method' => $_SERVER['REQUEST_METHOD']));
rec_fail('不支持的操作');
