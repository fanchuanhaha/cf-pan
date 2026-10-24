new Vue({
    el: '#app',
    data: {
        uploadTitle: '选择文件/Ctrl+V粘贴/拖拽到此上传',
        background: '#fff',
        showtype: 0,
        isBlock: false,
        alert: {
            type: 'success',
            msg: ''
        },
        beginTime: 0,
        uploadStartTime: 0,
        completedBytes: 0,
        chunkLoaded: {},
        _speedLastTime: 0,
        _speedLastBytes: 0,
        _speedValue: 0,
        progress: 0,
        progress_tip: '',
        filename: '',
        uploadspeed: '',
        input: {
            csrf_token:'',
            show: true,
            ispwd: false,
            pwd: '',
            hash: '',
            name: '',
            size: 0
        },
    },
    mounted() {
        $(".colorful_loading_frame").hide();
        this.input.csrf_token = $("#csrf_token").val();

        var that = this;
        var fileInput = $("#fileInput");
        var elemetnNode="";
        //拖拽外部文件，进入目标元素触发
        fileInput.on("dragenter",function(e){
            elemetnNode=e.originalEvent.target;
            that.uploadTitle = '释放鼠标立即上传';
            that.background = '#ccc';
        });
        //拖拽外部文件，离开目标元素触发
        fileInput.on("dragleave",function(e){
            if(elemetnNode===e.originalEvent.target){
                that.uploadTitle = '选择文件/Ctrl+V粘贴/拖拽到此上传';
                that.background = '#fff';
            }
        });
        //拖拽外部文件，在目标元素上释放鼠标触发
        fileInput.on('dragover', false).on("drop",function(e){
            that.uploadTitle = '选择文件/Ctrl+V粘贴/拖拽到此上传';
            that.background = '#fff';
            var fs = e.originalEvent.dataTransfer.files;
            if(fs.length>0){
                that.uploadFile(fs[0])
            }
            return false;
        });

        document.addEventListener('paste', function(e) {
            var items = ((e.clipboardData || window.clipboardData).items) || [];
            var file = null;

            if (items && items.length) {
                for (var i = 0; i < items.length; i++) {
                    if (items[i].type.indexOf('text/') === -1) {
                        file = items[i].getAsFile();
                        break;
                    }
                }
            }

            if (!file) {
                return;
            }
            that.uploadFile(file)
        });
    },
    methods: {
        show_msg(msg, type){
            type = type || 'success';
            this.alert.type = type;
            this.alert.msg = msg;
            this.showtype = 2;
            this.isBlock=false;
            $("#file").val('');
        },
        resetUploadProgress(){
            this.progress = 0;
            this.progress_tip = '';
            this.uploadspeed = '';
            this.completedBytes = 0;
            this.chunkLoaded = {};
            this._speedLastTime = 0;
            this._speedLastBytes = 0;
            this._speedValue = 0;
        },
        beginTransfer(){
            this.uploadStartTime = new Date().getTime();
            this.resetUploadProgress();
        },
        refreshProgress(){
            var total = this.completedBytes;
            for(var k in this.chunkLoaded){
                total += this.chunkLoaded[k];
            }
            var totalSize = this.input.size > 0 ? this.input.size : 1;
            if(total > this.input.size) total = this.input.size;
            this.progress = this.input.size > 0 ? Math.min(100, Math.round(total / totalSize * 100)) : 100;
            if(this.progress >= 100){
                this.progress_tip = '正在保存中，请稍候';
                this.uploadspeed = '';
                return;
            }

            var now = new Date().getTime();
            var elapsed = (now - this.uploadStartTime) / 1000;
            if(this._speedLastTime === 0){
                this._speedLastTime = now;
                this._speedLastBytes = total;
            }
            var dt = (now - this._speedLastTime) / 1000;
            if(dt >= 0.5){
                var instantaneous = (total - this._speedLastBytes) / dt;
                if(instantaneous < 0) instantaneous = 0;
                // 平滑一下，避免单个分片完成时速度数字乱跳
                this._speedValue = this._speedValue > 0 ? this._speedValue * 0.6 + instantaneous * 0.4 : instantaneous;
                this._speedLastTime = now;
                this._speedLastBytes = total;
            }
            var speed = this._speedValue;
            if(speed <= 0 && elapsed > 0.3) speed = total / elapsed;
            if(speed > 0 && isFinite(speed)) this.uploadspeed = this.size_format(speed) + '/s';
        },
        onChunkProgress(chunk, loaded){
            this.chunkLoaded[chunk] = loaded;
            this.refreshProgress();
        },
        onChunkDone(chunk, size){
            delete this.chunkLoaded[chunk];
            this.completedBytes += size;
            if(this.completedBytes > this.input.size) this.completedBytes = this.input.size;
            this.refreshProgress();
        },
        clickUpload(){
            if(this.isBlock) return;
            $("#file").trigger("click");
        },
        async selectFile(e){
            var total = e.target.files.length;
            if(total == 0) return;
            var fileObj = e.target.files[0];
            await this.uploadFile(fileObj)
        },
        async uploadFile(file){
            var that = this;
            if(this.isBlock) return;
            if(typeof forbid!=='undefined' && forbid){
                layer.alert('登录后才能上传文件！',{icon:0},function(){window.location.href='./login.php'});
                return;
            }
            if(upload_max_filesize != '' && parseInt(upload_max_filesize) > 0){
                if(file.size > parseInt(upload_max_filesize) * 1024 * 1024){
                    layer.alert('上传文件大小限制'+upload_max_filesize+'MB！');return;
                }
            }
            this.input.name = file.name;
            this.input.size = file.size;
            this.resetUploadProgress();
            this.showtype = 1;
            this.beginTime = new Date().getTime();

            let loading = layer.msg('正在准备上传...', {icon: 16,shade: 0.1,time: 0});
            await this.getFileHash(file).then(res =>{
                that.input.hash = res;
            })
            var result = {}
            await this.preUpload().then(res =>{
                result = res
            }, res => {
                layer.close(loading);
                that.show_msg(res, 'danger');
                throw Error();
            })
            layer.close(loading);

            this.filename = file.name + ' （'+this.size_format(file.size)+'）';
            this.isBlock = true;
            if(result.code == 1){
                this.progress = 100;
                this.uploadSuccess(result.hash);
                return;
            }

            if(result.third){
                var directOk = true;
                this.beginTransfer();
                try {
                    if(result.method == 'PUT'){
                        await this.uploadThirdPut(result.url, file, result.headers);
                    }else{
                        await this.uploadThird(result.url, result.post, result.headers, file);
                    }
                } catch (e) {
                    // 直传失败（常见原因：R2/S3 桶未配置 CORS、Endpoint/Bucket/AK/SK 不对）
                    // 自动回退到网站中转分片上传，大于 100MB 的文件也能继续传
                    directOk = false;
                    console.warn('直传失败，回退到网站中转分片上传:', e);
                    layer.msg('直传失败，已自动改用网站中转分片上传');
                    this.beginTransfer();
                }

                if(directOk){
                    await this.completeUpload().then(res =>{
                        result = res
                    }, res => {
                        that.show_msg(res, 'danger');
                        throw Error();
                    });
                }else{
                    try {
                        var session = await this.prepareMultipart();
                        if(session.code == 1){
                            this.uploadSuccess(session.hash);
                            return;
                        }
                        if(session.uploadId){
                            await this.uploadChunks(file, session);
                            result = await this.completeUpload(session.uploadId, session.parts);
                        }else{
                            result = await this.uploadPart(file, 1);
                        }
                    } catch (err) {
                        that.show_msg(err, 'danger');
                        throw Error();
                    }
                }
            }else if(result.multipart && result.uploadId){
                try {
                    this.beginTransfer();
                    await this.uploadChunks(file, result);
                    result = await this.completeUpload(result.uploadId, result.parts);
                } catch (err) {
                    that.show_msg(err, 'danger');
                    throw Error();
                }
            }else{
                this.beginTransfer();
                await this.uploadPart(file, 1).then(res =>{
                    result = res
                }, res => {
                    that.show_msg(res, 'danger');
                    throw Error();
                });
            }
            this.uploadSuccess(result.hash);
        },
        async uploadChunks(file, session){ //分片并发上传（服务端决定并发数，25MB 一片，减少请求次数）
            var that = this;
            var chunkSize = session.chunksize;
            var chunks = session.chunks;
            var parts = new Array(chunks);
            var next = 1;
            var failure = null;
            var concurrency = Math.min(session.concurrency || 2, chunks);
            async function worker(){
                while(true){
                    if(failure) return;
                    var chunk = next++;
                    if(chunk > chunks) return;
                    var start = (chunk - 1) * chunkSize;
                    var end = Math.min(start + chunkSize, file.size);
                    var blob = file.slice(start, end);
                    try {
                        var part = await that.uploadPart(blob, chunk, session.uploadId);
                        parts[chunk - 1] = { partNumber: chunk, etag: part.etag };
                    } catch (e) {
                        failure = e;
                        throw e;
                    }
                }
            }
            var workers = [];
            for (var i = 0; i < concurrency; i++) {
                workers.push(worker().then(function(){ return null; }, function(e){ return e; }));
            }
            var workerErrors = await Promise.all(workers);
            for (var j = 0; j < workerErrors.length; j++) {
                if (workerErrors[j] && !failure) failure = workerErrors[j];
            }
            if (failure) {
                // 失败时尽量取消存储端未完成的分片任务，避免留下垃圾分片
                if (session.uploadId) {
                    try { await this.abortMultipart(session.uploadId); } catch (_) {}
                }
                throw failure;
            }
            parts = parts.filter(function(p){ return !!p; });
            session.parts = parts;
            return parts;
        },
        async prepareMultipart(){ //直传失败后，创建网站中转分片任务
            var that = this;
            return new Promise((resolve, reject) => {
                $.ajax({
                    type: 'POST',
                    url: 'ajax.php?act=prepare_multipart',
                    data: {
                        csrf_token: that.input.csrf_token,
                        name: that.input.name,
                        hash: that.input.hash,
                        size: that.input.size,
                        show: that.input.show?'1':'0',
                        ispwd: that.input.ispwd?'1':'0',
                        pwd: that.input.pwd,
                    },
                    dataType: 'json',
                    success: function(data) {
                        if(data.code == 0 || data.code == 1){
                            resolve(data);
                        }else{
                            reject(data.msg || '初始化分片上传失败');
                        }
                    },
                    error: function(){
                        reject('初始化分片上传失败，请稍后再试');
                    }
                });
            })
        },
        async abortMultipart(uploadId){ //清理未完成的分片任务
            var that = this;
            return new Promise((resolve) => {
                $.ajax({
                    type: 'POST',
                    url: 'ajax.php?act=abort_multipart',
                    data: {
                        csrf_token: that.input.csrf_token,
                        hash: that.input.hash,
                        uploadId: uploadId,
                    },
                    dataType: 'json',
                    success: function(){ resolve(); },
                    error: function(){ resolve(); }
                });
            })
        },
        async preUpload(){ //文件预上传，极速秒传查询
            var postData = {
                csrf_token: this.input.csrf_token,
                name: this.input.name,
                hash: this.input.hash,
                size: this.input.size,
                show: this.input.show?'1':'0',
                ispwd: this.input.ispwd?'1':'0',
                pwd: this.input.pwd,
            };
            var that = this;
            return new Promise((resolve, reject) => {
                $.ajax({
                    type: 'POST',
                    url: 'ajax.php?act=pre_upload',
                    data: postData,
                    dataType: 'json',
                    success: function(data) {
                        if(data.code == 0 || data.code == 1){
                            resolve(data);
                        }else{
                            reject(data.msg);
                        }
                    },
                    error:function(){
                        layer.msg('服务器错误');
                        reject('上传失败，请稍后再试或联系站长');
                    }
                });
            })
        },
        async completeUpload(uploadId, parts){ //直传或分片上传完成后入库
            var that = this;
            var postData = {
                hash: that.input.hash,
                csrf_token: that.input.csrf_token,
                name: that.input.name,
                size: that.input.size,
                show: that.input.show?'1':'0',
                ispwd: that.input.ispwd?'1':'0',
                pwd: that.input.pwd,
            };
            if(uploadId) postData.uploadId = uploadId;
            if(parts) postData.parts = JSON.stringify(parts);
            return new Promise((resolve, reject) => {
                $.ajax({
                    type: 'POST',
                    url: 'ajax.php?act=complete_upload',
                    data: postData,
                    dataType: 'json',
                    success: function(data) {
                        if(data.code == 0 || data.code == 1){
                            resolve(data);
                        }else{
                            reject(data.msg);
                        }
                    },
                    error:function(){
                        layer.msg('服务器错误');
                        reject('上传失败，请稍后再试或联系站长');
                    }
                });
            })
        },
        async uploadPart(file, chunk, uploadId){ //上传文件分片
            var that = this;
            return new Promise((resolve, reject) => {
                var data = new FormData();
                data.append('file', file);
                data.append('hash', that.input.hash);
                data.append('chunk', chunk);
                if(uploadId) data.append('uploadId', uploadId);
                data.append('name', that.input.name);
                data.append('size', that.input.size);
                data.append('csrf_token', that.input.csrf_token);
                $.ajax({
                    type : "POST",
                    url : "ajax.php?act=upload_part",
                    data : data,
                    processData: false,
                    contentType: false,
                    dataType : 'json',
                    success : function(data) {
                        if(data.code == 0 || data.code == 1){
                            that.onChunkDone(chunk, file.size);
                            resolve(data);
                        }else{
                            reject(data.msg);
                        }
                    },
                    error : function(){
                        reject('上传失败，请稍后再试或联系站长');
                    },
                    xhr: function() {
                        var xhr = new XMLHttpRequest();
                        xhr.upload.addEventListener('progress', function (e) {
                            if(e.lengthComputable) that.onChunkProgress(chunk, e.loaded);
                        })
                        return xhr;
                    }
                });
            })
        },
        async uploadThird(url, postdata, headers, file){ //第三方POST直传（七牛/又拍表单上传）
            var that = this;
            return new Promise((resolve, reject) => {
                var data = new FormData();
                for(key in postdata){
                    data.append(key, postdata[key]);
                }
                data.append('file', file);
                $.ajax({
                    type : "POST",
                    url : url,
                    data : data,
                    headers: headers || {},
                    processData: false,
                    contentType: false,
                    dataType : 'html',
                    success : function(data) {
                        that.onChunkDone(1, file.size);
                        resolve();
                    },
                    error : function(){
                        reject('上传失败，请稍后再试或联系站长');
                    },
                    xhr: function() {
                        var xhr = new XMLHttpRequest();
                        xhr.upload.addEventListener('progress', function (e) {
                            if(e.lengthComputable) that.onChunkProgress(1, e.loaded);
                        })
                        return xhr;
                    }
                });
            })
        },
        async uploadThirdPut(url, file, headers){ //第三方PUT直传（S3/R2 预签名）
            var that = this;
            return new Promise((resolve, reject) => {
                var xhr = new XMLHttpRequest();
                xhr.open('PUT', url, true);
                if(headers){
                    for(var hk in headers){ xhr.setRequestHeader(hk, headers[hk]); }
                }
                xhr.onload = function(){
                    if(xhr.status >= 200 && xhr.status < 300){
                        that.onChunkDone(1, file.size);
                        resolve();
                    }else{
                        var detail = (xhr.responseText || '').slice(0, 300);
                        reject('直传失败(HTTP ' + xhr.status + ')' + (detail ? '：' + detail : '') + '。请检查存储桶 CORS、Endpoint、Bucket 和 AK/SK');
                    }
                };
                xhr.onerror = function(){
                    reject('直传失败：网络错误或被 CORS 拦截。请检查存储桶 CORS 是否允许 PUT 和 Content-Type');
                };
                xhr.upload.addEventListener('progress', function (e) {
                    if(e.lengthComputable) that.onChunkProgress(1, e.loaded);
                });
                xhr.send(file);
            })
        },
        async getFileHash(file){ //获取文件MD5
            var that = this;
            this.filename = '正在读取文件(0%)'

            return new Promise((resolve) => {
                var fileReader = new FileReader(),
                    blobSlice = File.prototype.mozSlice || File.prototype.webkitSlice || File.prototype.slice,
                    chunkSize = 2097152,
                    chunks = Math.ceil(file.size / chunkSize),
                    currentChunk = 0,
                    spark = new SparkMD5();

                loadNext();

                fileReader.onload = function(e) {
                    spark.appendBinary(e.target.result);
                    currentChunk++;
                    var progressRate = Math.round(currentChunk / chunks * 100);
                    that.filename = '正在读取文件('+progressRate+'%)'
                    if (currentChunk < chunks) {
                        loadNext();
                    }
                    else {
                        resolve(spark.end());
                    }
                };

                function loadNext() {
                    var start = currentChunk * chunkSize,
                        end = start + chunkSize >= file.size ? file.size : start + chunkSize;
                    fileReader.readAsBinaryString(blobSlice.call(file, start, end));
                };
            })
        },
        uploadSuccess(hash){
            var lastTime = (new Date().getTime() - this.beginTime) / 1000;
            var jumpurl = "file.php?hash="+hash;
            if(this.input.ispwd && this.input.pwd!=''){
                jumpurl+='&pwd='+this.input.pwd;
            }
            this.show_msg('上传成功！总用时：'+lastTime.toFixed(2)+'秒。正在跳转到文件查看页面...');
            setTimeout(function(){ window.location.href=jumpurl; }, 800);
        },
        size_format(size){
            if(!isFinite(size) || size <= 0) return '0.00B';
            var units = 'B';
            if(size/1024>1){
                size = size/1024;
                units = 'KB';
            }
            if(size/1024>1){
                size = size/1024;
                units = 'MB';
            }
            if(size/1024>1){
                size = size/1024;
                units = 'GB';
            }
            return size.toFixed(2)+units;
        }
    }
})