const got = require('got');
const MessageService = require('./MessageService');
const { logTaskEvent } = require('../../utils/logUtils');
const ProxyUtil = require('../../utils/ProxyUtil'); // ProxyUtil 仍然可能被 ConfigService.getProxyAgent 内部使用或直接使用

class CustomPushService extends MessageService {
    constructor(config) {
        super(config); 
        // 确保 this.customPushConfigs 总是一个数组
        this.customPushConfigs = Array.isArray(config) ? config : (config ? [config] : []);
        this.initialize(); // 调用父类的 initialize，它会调用下面的 checkEnabled
        this.pendingQueue = new Map(); // 待发送队列：Map<父路径, { message, timeoutId }>
    }

    checkEnabled() {
        // 检查配置数组中是否至少有一个启用的推送
        return this.customPushConfigs && this.customPushConfigs.some(c => c && c.enabled === true);
    }

// 提取路径并替换 {{strm}}
    _extractAndReplaceStrm(message, task = null) {
        // 先尝试从 [STRM:xxx] 中提取路径
        const folderPaths = [];
        const cleaned = message.replace(/\[STRM:([^\]]+)\]/g, (match, path) => {
            folderPaths.push(path);
            return '';
        });
        
        // 如果没有 [STRM:xxx] 但有 task，则从 task 中提取
        if (folderPaths.length === 0 && task && task.realFolderName) {
            const parts = task.realFolderName.split('/').filter(p => p);
            if (parts.length > 0) {
                folderPaths.push('/' + parts[0]);
            }
        }
        
        // 替换 {{strm}} 为第一个路径
        const firstPath = folderPaths.length > 0 ? folderPaths[0] : '/';
        const result = cleaned.replace(/{{strm}}/g, firstPath);
        
        return { processedMessage: result, folderPaths: folderPaths };
    }

    // 判断是否电影类型（路径含电影/Movie/Movies）
    _isMovieType(paths) {
        if (!paths || paths.length === 0) return false;
        const keywords = ['电影', 'movie', 'movies'];
        return paths.some(path => 
            keywords.some(keyword => path.toLowerCase().includes(keyword))
        );
    }

    // 队列管理：新增或更新现有队列
    async _enqueueOrUpdate(path, newMessage, delay, folderPaths = []) {
        const existing = this.pendingQueue.get(path);
        
        if (existing) {
            // 已有队列 → 更新消息，重新计时
            clearTimeout(existing.timeoutId);
            logTaskEvent(`[CustomPushService] 路径${path}在${delay}秒内收到新任务，更新内容并重新计时`);
            
            const timeoutId = setTimeout(() => {
                this._flushQueue(path);
            }, delay * 1000);
            
            existing.message = newMessage;
            existing.folderPaths = folderPaths;
            existing.timeoutId = timeoutId;
        } else {
            // 新队列 → 延迟发送
            logTaskEvent(`[CustomPushService] 路径${path}延迟${delay}秒后发送`);
            
            const timeoutId = setTimeout(() => {
                this._flushQueue(path);
            }, delay * 1000);
            
            this.pendingQueue.set(path, {
                message: newMessage,
                folderPaths: folderPaths,
                timeoutId: timeoutId
            });
        }
    }

    // 实际发送
    async _flushQueue(path) {
        const item = this.pendingQueue.get(path);
        if (!item) return;
        
        // 从队列中获取原始 folderPaths，然后用 path（父路径）作为 strm
        const strmPath = path; // path 已经是父路径（如 /电影）
        
        let allSuccess = true;
        for (const config of this.customPushConfigs) {
            if (config && config.enabled) {
                const success = await this._sendSingleRequest(strmPath, item.message, config);
                if (!success) allSuccess = false;
            }
        }
        
        logTaskEvent(`[CustomPushService] 路径${path}推送完成`);
        this.pendingQueue.delete(path);
    }

    _jsonEscape(str) {
        if (typeof str !== 'string') return str;
        return str.replace(/\\/g, '\\\\') // 必须先替换反斜杠
                  .replace(/"/g, '\\"')
                  .replace(/\n/g, '\\n')
                  .replace(/\r/g, '\\r')
                  .replace(/\t/g, '\\t')
                  .replace(/\f/g, '\\f')
                  .replace(/\b/g, '\\b');
    }

    _replacePlaceholders(template, title, content, escapeValuesForJson = false) {
        if (typeof template !== 'string') return template;

        const safeTitle = escapeValuesForJson ? this._jsonEscape(title) : title;
        const safeContent = escapeValuesForJson ? this._jsonEscape(content) : content;

        return template.replace(/{{title}}/g, safeTitle)
                      .replace(/{{content}}/g, safeContent)
                      .replace(/{{strm}}/g, title); // 用 title 参数传递 strm 路径
    }

    _replacePlaceholdersInObject(obj, title, content) {
        if (typeof obj !== 'object' || obj === null) return obj;
        const newObj = JSON.parse(JSON.stringify(obj)); // Deep clone
        for (const key in newObj) {
            if (Object.prototype.hasOwnProperty.call(newObj, key)) {
                if (typeof newObj[key] === 'string') {
                    newObj[key] = this._replacePlaceholders(newObj[key], title, content);
                } else if (typeof newObj[key] === 'object') {
                    newObj[key] = this._replacePlaceholdersInObject(newObj[key], title, content);
                }
            }
        }
        return newObj;
    }

    async _sendSingleRequest(title, content, singlePushConfig) {
        if (!singlePushConfig || !singlePushConfig.enabled) {
            return false;
        }

        // 解构新的配置字段
        const { url, method, contentType, fields  } = singlePushConfig;

        if (!url || !method) {
            logTaskEvent(`[CustomPushService] URL 或请求方法未在配置中提供: ${JSON.stringify(singlePushConfig)}`, 'error');
            return false;
        }

        let processedUrl = this._replacePlaceholders(url, title, content);
        let requestHeaders = {};
        let requestBodyFields = {};

        // 处理 fields 数组
        if (Array.isArray(fields)) {
            for (const field of fields) {
                if (!field || !field.key) continue;

            
                if (field.type === 'header') {
                    requestHeaders[field.key] = this._replacePlaceholders(field.value, title, content);
                } else if (field.type === 'string') {
                    requestBodyFields[field.key] = this._replacePlaceholders(field.value, title, content);
                } else if (field.type === 'json') {
                    try {
                        let parsedJsonValue = JSON.parse(field.value);
                        parsedJsonValue = this._replacePlaceholdersInObject(parsedJsonValue, title, content);
                        requestBodyFields = parsedJsonValue;
                    } catch (e) {
                        logTaskEvent(`[CustomPushService] 解析字段 "${field.key}" 的JSON值失败: ${e.message}. 原始值 (替换前): ${field.value}, 替换后尝试解析的字符串: ${this._replacePlaceholders(field.value, title, content, true)}`, 'error');
                        requestBodyFields = this._replacePlaceholders(field.value, title, content); 
                    }
                } else {
                    // 其他类型或未指定类型的字段，默认作为字符串处理放入body
                    requestBodyFields[field.key] = this._replacePlaceholders(field.value, title, content);
                }
            }
        }
        
        const agent = ProxyUtil.getProxyAgent("customPush")

        const options = {
            method: method.toUpperCase(),
            headers: requestHeaders, // 从 fields 中提取的请求头
            timeout: { request: 5000 }, // 使用配置的timeout或默认值
            retry: { limit: 1 },     // 使用配置的retries或默认值
            throwHttpErrors: false,
            agent // 应用代理
        };

        // 根据 contentType 设置请求体和 Content-Type 请求头
        if (contentType && contentType.toLowerCase().includes('application/json')) {
            options.json = requestBodyFields; 
            options.headers['Content-Type'] = 'application/json; charset=utf-8';
        } else if (contentType && contentType.toLowerCase().includes('application/x-www-form-urlencoded')) {
            options.form = requestBodyFields;
            options.headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=utf-8';
        } else if (contentType && contentType.toLowerCase().includes('text/plain')) {
            options.body = Object.values(requestBodyFields).join('\n');
            options.headers['Content-Type'] = contentType.startsWith('text/plain') ? contentType : 'text/plain; charset=utf-8';
        } else if (Object.keys(requestBodyFields).length > 0) {
            if (method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'HEAD') {
                 options.json = requestBodyFields;
                 options.headers['Content-Type'] = options.headers['Content-Type'] || 'application/json; charset=utf-8';
            }
        }
        try {
            logTaskEvent(`[CustomPushService] 发送自定义推送: ${options.method} ${processedUrl} | Headers: ${JSON.stringify(options.headers)} | Body: ${options.json ? JSON.stringify(options.json) : (options.form ? JSON.stringify(options.form) : options.body || 'N/A')}`);
            const response = await got(processedUrl, options);
            if (response.statusCode >= 200 && response.statusCode < 300) {
                logTaskEvent(`[CustomPushService] 推送成功 (${processedUrl}). 状态码: ${response.statusCode}`);
                return true;
            } else {
                logTaskEvent(`[CustomPushService] 推送失败 (${processedUrl}). 状态码: ${response.statusCode}, 响应体: ${response.body}`, 'error');
                return false;
            }
        } catch (error) {
            logTaskEvent(`[CustomPushService] 推送请求错误 (${processedUrl}): ${error.message}`, 'error');
            return false;
        }
    }

    async _send(message, task = null, title = '应用通知') {
        if (!this.enabled) {
            return;
        }
        
        // 提取路径并替换 {{strm}}
        const { processedMessage, folderPaths } = this._extractAndReplaceStrm(message, task);
        
        // 计算延迟（电影30秒，其他120秒）
        const delay = folderPaths.length > 0 && this._isMovieType(folderPaths) ? 30 : 120;
        
        // 逐个路径处理队列（folderPaths 已经是 realFolderName - resourceName 的结果）
        for (const path of folderPaths) {
            await this._enqueueOrUpdate(path, processedMessage, delay, folderPaths);
        }
        
        // 如果没有路径，仍然直接发送
        if (folderPaths.length === 0) {
            let allSuccess = true;
            for (const config of this.customPushConfigs) {
                if (config && config.enabled) {
                    const success = await this._sendSingleRequest(title, message, config);
                    if (!success) allSuccess = false;
                }
            }
            return allSuccess;
        }
        
        return true;
    }

    async _sendScrapeMessage(scrapeMessage) {
        if (!this.enabled) {
            return;
        }
        const baseTitle = scrapeMessage.title || '刮削通知';
        let content = scrapeMessage.content || '';
        if(scrapeMessage.posterUrl) {
            content += `\n海报: ${scrapeMessage.posterUrl}`;
        }

        let allSuccess = true;
        for (const config of this.customPushConfigs) {
            if (config && config.enabled) {
                // 你可能需要根据新的配置结构调整标题的生成方式，或者在配置中添加类似字段
                const pushTitle = config.scrapeTitleTemplate ? this._replacePlaceholders(config.scrapeTitleTemplate, baseTitle, content) : baseTitle;
                const success = await this._sendSingleRequest(pushTitle, content, config);
                if (!success) {
                    allSuccess = false;
                }
            }
        }
        return allSuccess;
    }

    // 测试推送
    async testPush(config) {
        config.enabled = true;
        return await this._sendSingleRequest('测试标题', '测试内容', config);
    }
}

module.exports = CustomPushService;
