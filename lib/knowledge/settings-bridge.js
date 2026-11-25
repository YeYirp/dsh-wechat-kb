import { createLocalUserCategory, getLocalDocument, listLocalDocuments, listLocalSummaries, localKnowledgeOverview, resolveLocalStorePath, updateLocalDocumentMetadata, } from './local-store.js';
import { describeImportResult, importUploadedFiles } from './file-import.js';
import { KNOWLEDGE_SETTINGS_NAMESPACE } from './settings.js';
const SETTINGS_PATH = '/api/project-knowledge-review/settings';
const KNOWLEDGE_PREFIX = '/api/project-knowledge-review/knowledge';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
/** 注册独立插件的本机设置、资料浏览、摘要和分类桥接。 */
export function registerSettingsBridge(ctx, current, mediaOptions = () => ({})) {
    ctx.inject(['webServer', 'settings'], (bridgeCtx) => {
        bridgeCtx.effect(() => bridgeCtx.webServer.register({ kind: 'exact', path: SETTINGS_PATH, handler: (req, res) => handleSettings(bridgeCtx, req, res) }), 'project-knowledge-review: settings bridge');
        bridgeCtx.effect(() => bridgeCtx.webServer.register({ kind: 'prefix', path: KNOWLEDGE_PREFIX, handler: (req, res) => handleKnowledge(current, mediaOptions, req, res) }), 'project-knowledge-review: local knowledge bridge');
    });
}
async function handleSettings(ctx, req, res) {
    if (!isTrustedLocalRequest(req))
        return send(res, 403, { ok: false, message: '设置接口仅允许当前 DSH 页面在本机访问' });
    try {
        if (req.method === 'GET') {
            const descriptor = ctx.settings.describe({ redactSecrets: true }).find((item) => item.ns === KNOWLEDGE_SETTINGS_NAMESPACE);
            if (!descriptor)
                return send(res, 404, { ok: false, message: '知识复习设置尚未注册' });
            return send(res, 200, { ok: true, value: descriptor.value, revision: descriptor.revision, writable: ctx.settings.writable });
        }
        if (req.method === 'POST') {
            requireJsonContentType(req);
            const body = await readJson(req);
            if (typeof body.field !== 'string' || !ALLOWED_FIELDS.has(body.field))
                return send(res, 400, { ok: false, message: '不允许修改该字段' });
            await ctx.settings.update(KNOWLEDGE_SETTINGS_NAMESPACE, { [body.field]: body.value }, typeof body.expectedRevision === 'number' ? body.expectedRevision : undefined);
            const descriptor = ctx.settings.describe({ redactSecrets: true }).find((item) => item.ns === KNOWLEDGE_SETTINGS_NAMESPACE);
            return send(res, 200, { ok: true, value: descriptor?.value, revision: descriptor?.revision, writable: ctx.settings.writable });
        }
        return send(res, 405, { ok: false, message: '请求方法不支持' });
    }
    catch (error) {
        return send(res, 400, { ok: false, message: messageOf(error) });
    }
}
/** 只访问插件自己的 v2 本地资料库，不代理或识别任何外部项目。 */
async function handleKnowledge(current, mediaOptions, req, res) {
    if (!isTrustedLocalRequest(req))
        return send(res, 403, { ok: false, message: '知识库接口仅允许当前 DSH 页面在本机访问' });
    const settings = current();
    const path = resolveLocalStorePath(settings.localStorePath);
    try {
        const url = new URL(req.url ?? KNOWLEDGE_PREFIX, 'http://127.0.0.1');
        const suffix = url.pathname.slice(KNOWLEDGE_PREFIX.length);
        if (req.method === 'POST' && suffix === '/import') {
            if (!settings.enabled)
                return send(res, 403, { ok: false, message: '知识复习服务当前已关闭，不能写入资料' });
            const fileName = decodeOptionalHeader(req.headers['x-dsh-knowledge-file-name']);
            if (!fileName)
                return send(res, 400, { ok: false, message: '缺少文件名' });
            const title = decodeOptionalHeader(req.headers['x-dsh-knowledge-title']);
            const source = decodeOptionalHeader(req.headers['x-dsh-knowledge-source']);
            const bytes = await readBody(req, MAX_UPLOAD_BYTES);
            if (!bytes.byteLength)
                return send(res, 400, { ok: false, message: '上传文件为空' });
            const result = await importUploadedFiles([{ fileName, bytes }], {
                storePath: path,
                ...(title ? { title } : {}),
                ...(source ? { source } : {}),
                ...mediaOptions(settings),
            });
            const rendered = describeImportResult(result);
            const first = result.imported[0];
            return send(res, first ? 201 : 422, { ok: Boolean(first), ...rendered, ...(first ? { item: first } : {}) });
        }
        if (req.method === 'GET' && suffix === '/overview') {
            const overview = await localKnowledgeOverview(path);
            return send(res, 200, { ok: true, mode: 'local', ...overview, sharedWithCurrentProject: false });
        }
        if (req.method === 'GET' && suffix === '/materials') {
            const page = await listLocalDocuments(path, url.searchParams.get('cursor') || undefined, Number(url.searchParams.get('limit') || 30), url.searchParams.get('query') || '');
            return send(res, 200, { ok: true, mode: 'local', ...page });
        }
        if (req.method === 'GET' && suffix === '/summaries') {
            const userCategoryParam = url.searchParams.has('userCategory') ? url.searchParams.get('userCategory') ?? '' : undefined;
            const page = await listLocalSummaries(path, url.searchParams.get('cursor') || undefined, Number(url.searchParams.get('limit') || 30), url.searchParams.get('query') || '', url.searchParams.get('systemCategory') || '', userCategoryParam);
            return send(res, 200, { ok: true, ...page });
        }
        if (req.method === 'POST' && suffix === '/categories') {
            requireJsonContentType(req);
            const body = await readJson(req);
            const categories = await createLocalUserCategory(path, typeof body.name === 'string' ? body.name : '');
            return send(res, 201, { ok: true, categories });
        }
        const contentMatch = /^\/materials\/([^/]+)\/content$/.exec(suffix);
        if (req.method === 'GET' && contentMatch) {
            const id = decodeURIComponent(contentMatch[1]);
            const document = await getLocalDocument(path, id);
            if (!document)
                return send(res, 404, { ok: false, message: '资料不存在' });
            return send(res, 200, { ok: true, id: document.id, title: document.title, source: document.source, contentType: 'text/plain; charset=UTF-8', ...previewText(document.content) });
        }
        const metadataMatch = /^\/materials\/([^/]+)\/metadata$/.exec(suffix);
        if (req.method === 'PUT' && metadataMatch) {
            requireJsonContentType(req);
            const body = await readJson(req);
            const patch = {};
            if (typeof body.summary === 'string')
                patch.summary = body.summary;
            if (body.summarySource === 'extractive' || body.summarySource === 'model')
                patch.summarySource = body.summarySource;
            if (typeof body.systemCategory === 'string')
                patch.systemCategory = body.systemCategory;
            if (typeof body.userCategory === 'string' || body.userCategory === null)
                patch.userCategory = body.userCategory;
            if (!Object.keys(patch).length)
                return send(res, 400, { ok: false, message: '没有可更新的资料元数据' });
            const document = await updateLocalDocumentMetadata(path, decodeURIComponent(metadataMatch[1]), patch);
            return send(res, 200, { ok: true, item: publicSummary(document) });
        }
        return send(res, 404, { ok: false, message: '知识库路径不存在' });
    }
    catch (error) {
        return send(res, req.method === 'GET' ? 502 : 400, { ok: false, message: `知识库操作失败：${messageOf(error)}` });
    }
}
const ALLOWED_FIELDS = new Set([
    'enabled', 'answerPolicy', 'localStorePath', 'projectName', 'evidenceCount', 'evidenceMaxChars', 'requestTimeoutMs',
    'ocrEnabled', 'ocrBaseUrl', 'ocrModel', 'ocrApiKeyEnv', 'ocrApiKey',
    'asrEnabled', 'asrBaseUrl', 'asrModel', 'asrApiKeyEnv', 'asrApiKey',
]);
function publicSummary(document) {
    return { id: document.id, title: document.title, source: document.source, createdAt: document.createdAt, updatedAt: document.updatedAt, contentLength: document.content.length, summary: document.summary, summarySource: document.summarySource, systemCategory: document.systemCategory, userCategory: document.userCategory };
}
function previewText(content) {
    const maxCharacters = 2_000_000;
    return { content: content.slice(0, maxCharacters), contentLength: content.length, truncated: content.length > maxCharacters };
}
function requireJsonContentType(req) {
    const value = req.headers['content-type'] ?? '';
    if (!/^application\/json(?:\s*;|$)/i.test(value))
        throw new Error('写入接口只接受 application/json');
}
async function readJson(req) {
    const bytes = await readBody(req, MAX_BODY_BYTES);
    return JSON.parse(bytes.toString('utf8') || '{}');
}
async function readBody(req, maxBytes) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.byteLength;
        if (size > maxBytes)
            throw new Error(maxBytes > MAX_BODY_BYTES ? '上传文件超过大小限制' : '知识库请求体过大');
        chunks.push(bytes);
    }
    return Buffer.concat(chunks);
}
function decodeOptionalHeader(value) {
    if (typeof value !== 'string' || !value.trim())
        return '';
    try {
        return decodeURIComponent(value).trim();
    }
    catch {
        return value.trim();
    }
}
/**
 * dsh 0.2.x 适配：设置页的 POST 可能不带 Origin（经本机转发）、带 `Origin: null`，或 Origin 的本地主机名与
 * Host 不一致（localhost 与 127.0.0.1 互换）。原逻辑要求 origin.host 与 Host 逐字相同，且缺失 Origin 的
 * POST 一律拒绝，导致设置页保存返回 403。
 * 现在只保留两道真正有效的边界：连接必须来自本机回环地址、且不是跨站请求。
 * 跨站写请求由浏览器的 CORS 预检与本接口不返回 CORS 头来拦截，因此无需再比较主机名。
 */
export function isTrustedLocalRequest(req) {
    const address = req.socket.remoteAddress;
    if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1')
        return false;
    const fetchSite = req.headers['sec-fetch-site'];
    if (fetchSite === 'cross-site')
        return false;
    return true;
}
function send(res, status, payload) {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(payload));
}
function messageOf(error) { return error instanceof Error ? error.message : '未知错误'; }
