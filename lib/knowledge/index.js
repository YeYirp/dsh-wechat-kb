import { defineTool } from '@deepseek-ai/dsh-tools';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { addLocalDocument, localKnowledgeOverview, resolveLocalStorePath, searchLocalKnowledge, updateLocalDocumentMetadata, listLocalDocuments, detectLanguage } from './local-store.js';
import { describeImportResult, importLocalPaths, usableOcrText } from './file-import.js';
import { classifyKnowledgeIntent } from './intent.js';
import { recognizeImageBytes, recognizeImageUrl, transcribeAudioBytes, transcribeAudioUrl } from './media-services.js';
import { buildProjectKnowledgeReviewPrompt, PROJECT_KNOWLEDGE_REVIEW_PROMPT_ORDER } from './prompt.js';
import { registerSettingsBridge } from './settings-bridge.js';
import { KnowledgeSettingsSchema, KNOWLEDGE_SETTINGS_NAMESPACE, validateKnowledgeSettings } from './settings.js';
export const name = 'project-knowledge-review';
export const inject = ['tools', 'systemPrompt'];
export const Config = KnowledgeSettingsSchema;
function refused(message, refusalReason) {
    return JSON.stringify({ answerStatus: 'REFUSED', message, refusalReason, evidences: [] });
}
function disabled() {
    return refused('知识复习服务当前已在 DSH 设置中关闭，不能检索或写入资料。', '服务已关闭');
}
export function apply(ctx, config) {
    let current = () => config;
    installSettingsSection(ctx, KNOWLEDGE_SETTINGS_NAMESPACE, KnowledgeSettingsSchema, config, {
        setSource: (source) => { current = source; },
        onChange: () => ctx.emit('system-prompt/change'),
        validate: validateKnowledgeSettings,
    });
    registerSettingsBridge(ctx, () => current(), (settings) => importMediaOptions(ctx, settings));
    ctx.systemPrompt.section({
        name: 'project-knowledge-review',
        order: PROJECT_KNOWLEDGE_REVIEW_PROMPT_ORDER,
        text: () => current().enabled ? buildProjectKnowledgeReviewPrompt(current()) : '',
    });
    ctx.tools.register(defineTool({
        name: 'project_knowledge_overview',
        description: '查询知识库自身信息：已有资料数量/标题/来源、存储位置、作用域、是否与当前项目共用。此类问题不要调用 project_knowledge_search。',
        parameters: {
            question: { type: 'string', required: true, description: '用户关于知识库状态、清单、位置或共享范围的问题。' },
            limit: { type: 'integer', description: '随概览返回的最近资料标题数，默认 10，最大 50。' },
        },
        output: jsonOutput(),
        async execute(args) {
            const settings = current();
            if (!settings.enabled)
                return disabled();
            const intent = classifyKnowledgeIntent(args.question);
            const limit = Math.max(1, Math.min(args.limit ?? 10, 50));
            try {
                const path = resolveLocalStorePath(settings.localStorePath);
                const [overview, page] = await Promise.all([localKnowledgeOverview(path), listLocalDocuments(path, undefined, limit)]);
                return JSON.stringify({
                    intent,
                    mode: 'local',
                    answerPolicy: settings.answerPolicy,
                    documentCount: overview.documentCount,
                    storePath: overview.storePath,
                    scope: 'DSH 插件用户级本地库',
                    sharedWithCurrentProject: false,
                    sharingExplanation: '公开插件独立保存资料，不连接任何外部项目。其他应用如需个人同步，应自行读取或导入插件的本地资料格式。',
                    recentMaterials: page.items,
                });
            }
            catch (error) {
                return JSON.stringify({ status: 'UNAVAILABLE', intent, mode: 'local', message: '知识库状态接口当前不可用。', error: messageOf(error), knownConfiguration: { storePath: resolveLocalStorePath(settings.localStorePath), scope: 'DSH 插件用户级本地库' } });
            }
        },
    }));
    ctx.tools.register(defineTool({
        name: 'project_knowledge_search',
        description: '检索知识复习插件自己的本地知识库。必须先检索、有 evidence 才能回答；服务关闭或证据不足时返回 REFUSED。',
        parameters: {
            question: { type: 'string', required: true, description: '用户希望学习或复习的具体知识问题。' },
            topK: { type: 'integer', description: '返回证据数，默认 5，范围 1 到 10。' },
        },
        output: jsonOutput(),
        async execute(args) {
            const settings = current();
            if (!settings.enabled)
                return disabled();
            const intent = classifyKnowledgeIntent(args.question);
            if (intent === 'knowledge-inventory')
                return JSON.stringify({ answerStatus: 'ROUTE_TO_OVERVIEW', intent, message: '这是知识库状态/清单问题，请改调 project_knowledge_overview。', evidences: [] });
            try {
                const evidenceCount = Math.max(1, Math.min(args.topK ?? settings.evidenceCount, settings.evidenceCount, 10));
                const evidences = await searchLocalKnowledge(resolveLocalStorePath(settings.localStorePath), args.question, evidenceCount, { evidenceCount, maxSnippetChars: settings.evidenceMaxChars });
                if (!evidences.length) {
                    if (settings.answerPolicy === 'reference')
                        return JSON.stringify({ answerStatus: 'REFERENCE_MISS', intent, answerPolicy: settings.answerPolicy, knowledgeBaseMatched: false, modelSupplementAllowed: true, requiredSections: ['知识库内容', '模型补充'], message: '知识库未命中。“知识库内容”必须明确写未命中；通用知识只能放在“模型补充”小节。', evidences: [] });
                    return refused('当前知识库中没有足够证据，不能回答。请让用户粘贴学习资料文本，或在设置中启用 OCR/ASR。', '本地资料未命中');
                }
                return JSON.stringify({ answerStatus: 'ANSWERED', intent, answerPolicy: settings.answerPolicy, knowledgeBaseMatched: true, modelSupplementAllowed: settings.answerPolicy === 'reference', requiredSections: settings.answerPolicy === 'reference' ? ['知识库内容', '模型补充'] : ['知识库内容'], answer: settings.answerPolicy === 'strict' ? 'evidences 是规定，提问是对方的具体情形。能完整回答就完整回答；只能回答一部分时，先给能确定的部分，再用一句自然的话说明哪部分资料里没有或需要确认，不要因为答不全就只回拒答。回答尽量全面：相关的条件、例外、后果都要覆盖；拿不准某一条是否适用时，用一句自然的补充说明，不要直接省略。把情形逐条对到规定上，先给结论，再把相关条件和结果说全；不要写“依据：”“根据：”这类小标题，不要单独列计算过程。允许做规定里已经给定的计数与换算，禁止出现规定里没有的数字、期限、部门或条件；不要连续照抄资料原文超过 20 个字，不要写“根据资料/依据资料”或资料标题、来源。' : '请优先依据 evidences 回答；能完整回答就完整回答，只能答一部分时说明哪部分资料没有。相关的条件、例外、后果尽量覆盖，拿不准是否适用就补充说明。先给结论再讲清楚计算，不要写“根据资料/依据资料《标题》”这类来源说明；额外模型知识必须单独放入“模型补充”小节。', answerLanguage: detectLanguage(args.question), confidence: evidences[0].score, evidences });
            }
            catch (error) {
                return refused('知识库当前不可用，不能依据资料回答。请检查设置与文件权限。', messageOf(error));
            }
        },
    }));
    ctx.tools.register(defineTool({
        name: 'project_knowledge_add_text',
        description: '把用户提供或确认有权使用的纯文本资料写入插件自己的本地知识库，并返回自动提要与初次分类。无需数据库、向量模型或 API Key。',
        parameters: {
            title: { type: 'string', required: true, description: '资料标题，例如“React Hooks 笔记”。' },
            content: { type: 'string', required: true, description: '要保存的学习资料正文。' },
            source: { type: 'string', description: '资料来源，例如课程讲义或用户粘贴笔记。' },
        },
        output: jsonOutput(),
        async execute(args) {
            const settings = current();
            if (!settings.enabled)
                return disabled();
            try {
                const document = await addLocalDocument(resolveLocalStorePath(settings.localStorePath), args.title, args.content, args.source);
                return renderImported(document, '资料已写入插件本地知识库。');
            }
            catch (error) {
                return JSON.stringify({ status: 'FAILED', message: '资料未能写入本地知识库。', error: messageOf(error) });
            }
        },
    }));
    ctx.tools.register(defineTool({
        name: 'project_knowledge_import_file',
        description: '把一个或多个本地文件（Word、Excel、PowerPoint、PDF、图片、音频、文本）直接解析并写入插件本地知识库，返回自动提要与初次分类。用户给出文件路径或目录时优先用这个工具，不要先把整份文件内容读进对话。',
        parameters: {
            filePath: { type: 'string', required: true, description: '本地文件或目录路径；多个路径用换行分隔。目录会递归导入其中所有支持的文件。支持 .docx/.xlsx/.pptx/.pdf/.txt/.md/.csv/.html/常见图片和音频。' },
            title: { type: 'string', description: '单份资料的标题；默认使用文件名。多份资料时不使用。' },
            source: { type: 'string', description: '资料来源说明；默认记录本地文件路径。' },
        },
        output: jsonOutput(),
        async execute(args) {
            const settings = current();
            if (!settings.enabled)
                return disabled();
            try {
                const result = await importLocalPaths(args.filePath, {
                    storePath: resolveLocalStorePath(settings.localStorePath),
                    title: args.title,
                    source: args.source,
                    ...importMediaOptions(ctx, settings),
                });
                const rendered = describeImportResult(result);
                return JSON.stringify({
                    ...rendered,
                    message: `${rendered.message} 当前模型如需优化摘要，可调用 project_knowledge_update_summary。`,
                });
            }
            catch (error) {
                return JSON.stringify({ status: 'FAILED', message: '文件导入失败。', error: messageOf(error) });
            }
        },
    }));
    ctx.tools.register(defineTool({
        name: 'project_knowledge_update_summary',
        description: '在用户要求或当前模型已依据资料生成更准确摘要时，回写一条本地资料的知识点摘要或初次分类。不得写入资料没有支持的结论。',
        parameters: {
            documentId: { type: 'string', required: true, description: 'project_knowledge_add_text 返回的资料 ID。' },
            summary: { type: 'string', required: true, description: '仅依据资料正文生成的知识点摘要。' },
            systemCategory: { type: 'string', description: '可选的系统初次分类。' },
        },
        output: jsonOutput(),
        async execute(args) {
            const settings = current();
            if (!settings.enabled)
                return disabled();
            try {
                const document = await updateLocalDocumentMetadata(resolveLocalStorePath(settings.localStorePath), args.documentId, { summary: args.summary, summarySource: 'model', ...(args.systemCategory ? { systemCategory: args.systemCategory } : {}) });
                return JSON.stringify({ status: 'UPDATED', documentId: document.id, summary: document.summary, summarySource: document.summarySource, systemCategory: document.systemCategory });
            }
            catch (error) {
                return JSON.stringify({ status: 'FAILED', message: '知识点摘要未能更新。', error: messageOf(error) });
            }
        },
    }));
    ctx.tools.register(defineTool({
        name: 'project_knowledge_import_image_ocr',
        description: '使用 DSH 设置中配置的 OCR 模型识别公开图片 URL，写入插件本地知识库，并返回自动提要与初次分类。仅在 OCR 已开启时使用。',
        parameters: {
            title: { type: 'string', required: true, description: '资料标题。' },
            imageUrl: { type: 'string', required: true, description: '公开可下载的图片 URL，不允许本机或私有网络地址。' },
            source: { type: 'string', description: '资料来源说明。' },
        },
        output: jsonOutput(),
        async execute(args) {
            const settings = current();
            if (!settings.enabled)
                return disabled();
            if (!settings.ocrEnabled)
                return JSON.stringify({ status: 'DISABLED', message: 'OCR 服务未开启，请在 DSH 设置 → 知识复习中配置并启用。' });
            try {
                const text = usableOcrText(await recognizeImageUrl({ baseUrl: settings.ocrBaseUrl, model: settings.ocrModel, apiKey: await resolveMediaApiKey(ctx, settings, 'ocr'), timeoutMs: settings.requestTimeoutMs }, args.imageUrl));
                if (!text)
                    return JSON.stringify({ status: 'EMPTY', message: '图片里没有可识别的文字，未写入知识库。' });
                const document = await addLocalDocument(resolveLocalStorePath(settings.localStorePath), args.title, text, args.source || args.imageUrl);
                return renderImported(document, '图片文字已识别并写入插件本地知识库。', { recognizedCharacters: text.length });
            }
            catch (error) {
                return JSON.stringify({ status: 'FAILED', message: 'OCR 识别或资料写入失败。', error: messageOf(error) });
            }
        },
    }));
    ctx.tools.register(defineTool({
        name: 'project_knowledge_import_audio_asr',
        description: '使用 DSH 设置中配置的 ASR 模型转写公开可下载音频 URL，写入插件本地知识库，并返回自动提要与初次分类。仅在 ASR 已开启时使用。',
        parameters: {
            title: { type: 'string', required: true, description: '资料标题。' },
            audioUrl: { type: 'string', required: true, description: '公开可直接下载的音频 URL，不是视频网页分享页。' },
            source: { type: 'string', description: '资料来源说明。' },
        },
        output: jsonOutput(),
        async execute(args) {
            const settings = current();
            if (!settings.enabled)
                return disabled();
            if (!settings.asrEnabled)
                return JSON.stringify({ status: 'DISABLED', message: 'ASR 服务未开启，请在 DSH 设置 → 知识复习中配置并启用。' });
            try {
                const text = await transcribeAudioUrl({ baseUrl: settings.asrBaseUrl, model: settings.asrModel, apiKey: await resolveMediaApiKey(ctx, settings, 'asr'), timeoutMs: settings.requestTimeoutMs }, args.audioUrl);
                const document = await addLocalDocument(resolveLocalStorePath(settings.localStorePath), args.title, text, args.source || args.audioUrl);
                return renderImported(document, '音频已转写并写入插件本地知识库。', { transcribedCharacters: text.length });
            }
            catch (error) {
                return JSON.stringify({ status: 'FAILED', message: 'ASR 转写或资料写入失败。', error: messageOf(error) });
            }
        },
    }));
    console.log('[project-knowledge-review] 已加载独立本地知识复习服务');
}
function renderImported(document, message, extra = {}) {
    return JSON.stringify({ status: 'READY', documentId: document.id, title: document.title, summary: document.summary, summarySource: document.summarySource, systemCategory: document.systemCategory, userCategory: document.userCategory, sharedWithCurrentProject: false, ...extra, message: `${message} 已生成自动提要和初次分类；当前模型如需优化摘要，可调用 project_knowledge_update_summary。` });
}
function jsonOutput() {
    return { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: String(value) }] };
}
/** 文件导入复用设置里的 OCR / ASR；只有真正遇到图片或音频时才解析 Key。 */
function importMediaOptions(ctx, settings) {
    return {
        ...(settings.ocrEnabled ? {
            recognizeImage: async (bytes, contentType) => recognizeImageBytes({ baseUrl: settings.ocrBaseUrl, model: settings.ocrModel, apiKey: await resolveMediaApiKey(ctx, settings, 'ocr'), timeoutMs: settings.requestTimeoutMs }, bytes, contentType),
        } : {}),
        ...(settings.asrEnabled ? {
            transcribeAudio: async (bytes, contentType, fileName) => transcribeAudioBytes({ baseUrl: settings.asrBaseUrl, model: settings.asrModel, apiKey: await resolveMediaApiKey(ctx, settings, 'asr'), timeoutMs: settings.requestTimeoutMs }, bytes, contentType, fileName),
        } : {}),
    };
}
async function resolveMediaApiKey(ctx, settings, kind) {
    const literal = String(kind === 'ocr' ? settings.ocrApiKey ?? '' : settings.asrApiKey ?? '').trim();
    if (literal)
        return literal;
    return resolveCredential(ctx, kind === 'ocr' ? settings.ocrApiKeyEnv : settings.asrApiKeyEnv);
}
async function resolveCredential(ctx, rawRef) {
    const ref = rawRef.trim();
    if (!ref)
        return undefined;
    const value = await ctx.get('credentials')?.resolve(credentialRef(ref));
    if (!value)
        throw new Error(`未配置凭据 ${ref}，请在 DSH 设置 → 知识复习中填写 API Key`);
    return value.value;
}
function messageOf(error) {
    return error instanceof Error ? error.message : '未知错误';
}
/**
 * dsh 0.2.x 删除了 @deepseek-ai/dsh-settings 的 installSettingsSection 与 settingsNamespace：
 * 设置命名空间现在就是 profile 条目 id，Config 中用 .volatile() 声明的字段可就地读写。
 * 这里内联等价行为：把 volatile 字段解包成普通设置对象，配置变化时通知 system-prompt 重建。
 */
function installSettingsSection(ctx, ns, _schema, initial, options) {
    const unwrap = (source) => Object.fromEntries(Object.entries(source).map(([key, entry]) => [key, entry !== null && typeof entry === 'object' && typeof entry.get === 'function' ? entry.get() : entry]));
    options?.setSource?.(() => unwrap(initial));
    try {
        options?.validate?.(unwrap(initial));
    }
    catch (error) {
        warn(ctx, `配置校验失败：${messageOf(error)}`);
    }
    try {
        ctx.on('settings/document-updated', (updated) => {
            if (updated === ns)
                options?.onChange?.();
        });
    }
    catch (error) {
        warn(ctx, `无法监听设置变化：${messageOf(error)}`);
    }
}
function warn(ctx, text) {
    try {
        (ctx.logger?.('project-knowledge-review') ?? console).warn(`[project-knowledge-review] ${text}`);
    }
    catch {
        /* 日志只是辅助 */
    }
}
