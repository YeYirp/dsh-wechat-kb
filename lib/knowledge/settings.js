import { homedir } from 'node:os';
import { join } from 'node:path';
import Schema from './schema.js';
// dsh 0.2.x 删除了 settingsNamespace 辅助函数：设置命名空间就是 profile 条目 id，
// 这里直接用插件条目 id，并让所有字段 volatile，以便设置页可就地修改而不重启插件。
export const KNOWLEDGE_SETTINGS_NAMESPACE = 'dsh-wechat-kb';
export const OCR_API_KEY_REF = 'DSH_KNOWLEDGE_OCR_API_KEY';
export const ASR_API_KEY_REF = 'DSH_KNOWLEDGE_ASR_API_KEY';
/** 知识库默认落在 DSH 家目录（DSH_HOME，缺省 ~/.dsh）下，与插件安装位置在同一目录树下。 */
export function defaultLocalStorePath() {
    const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
    return join(home, 'project-knowledge-review', 'knowledge.json');
}
export const KnowledgeSettingsSchema = Schema.object({
    enabled: Schema.boolean().default(true).volatile(),
    answerPolicy: Schema.union(['strict', 'reference']).default('reference').volatile(),
    localStorePath: Schema.string().default(defaultLocalStorePath()).volatile(),
    projectName: Schema.string().default('我的知识库').volatile(),
    evidenceCount: Schema.number().min(1).max(10).default(3).volatile(),
    evidenceMaxChars: Schema.number().min(80).max(1200).default(320).volatile(),
    requestTimeoutMs: Schema.number().min(1000).max(600000).default(120000).volatile(),
    ocrEnabled: Schema.boolean().default(true).volatile(),
    ocrBaseUrl: Schema.string().default('http://127.0.0.1:8326/v1').volatile(),
    ocrModel: Schema.string().default('deepseek-official/deepseek-flash').volatile(),
    ocrApiKeyEnv: Schema.string().role('credential-ref').default(OCR_API_KEY_REF).volatile(),
    ocrApiKey: Schema.string().role('secret').default('').volatile(),
    asrEnabled: Schema.boolean().default(false).volatile(),
    asrBaseUrl: Schema.string().default('https://api.openai.com/v1').volatile(),
    asrModel: Schema.string().default('whisper-1').volatile(),
    asrApiKeyEnv: Schema.string().role('credential-ref').default(ASR_API_KEY_REF).volatile(),
    asrApiKey: Schema.string().role('secret').default('').volatile(),
});
export function validateKnowledgeSettings(settings) {
    if (!settings.projectName.trim())
        throw new Error('知识库名称不能为空');
    if (!settings.localStorePath.trim())
        throw new Error('本地知识库路径不能为空');
    if (!Number.isSafeInteger(settings.evidenceCount) || settings.evidenceCount < 1 || settings.evidenceCount > 10)
        throw new Error('返回证据条数必须是 1 到 10 的整数');
    if (!Number.isSafeInteger(settings.evidenceMaxChars) || settings.evidenceMaxChars < 80 || settings.evidenceMaxChars > 1200)
        throw new Error('每条证据最多字数必须是 80 到 1200 的整数');
    if (settings.ocrEnabled) {
        if (!isHttpUrl(settings.ocrBaseUrl))
            throw new Error('OCR Base URL 必须使用无用户信息的 http 或 https 地址');
        if (!settings.ocrModel.trim())
            throw new Error('OCR 模型不能为空');
    }
    if (settings.asrEnabled) {
        if (!isHttpUrl(settings.asrBaseUrl))
            throw new Error('ASR Base URL 必须使用无用户信息的 http 或 https 地址');
        if (!settings.asrModel.trim())
            throw new Error('ASR 模型不能为空');
    }
}
function isHttpUrl(value) {
    try {
        const url = new URL(value);
        return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
    }
    catch {
        return false;
    }
}
