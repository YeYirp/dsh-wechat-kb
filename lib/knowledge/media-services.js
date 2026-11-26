import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
const IMAGE_MAX_BYTES = 15 * 1024 * 1024;
const AUDIO_MAX_BYTES = 100 * 1024 * 1024;
/** 推理型视觉模型会先把输出预算用在推理上，给足输出上限才能拿到最终文字。 */
const OCR_MAX_OUTPUT_TOKENS = 16384;
const OCR_PROMPT = '请完整识别图片中的文字，保留标题、段落、列表和表格语义。只输出识别文本，不要解释。如果图片里没有任何文字，只回复固定标记 NO_TEXT，不要描述画面，不要编内容。';
/**
 * 识别图片文字。默认走 OpenAI 兼容的 chat/completions（DeepSeek 官方接口即为该协议）；
 * base URL 以 /anthropic 结尾时改走 Anthropic Messages（DeepSeek 的 multimodal 端点），
 * 用于只想用 DeepSeek 模型、或端点仅提供 Messages 的情况。
 */
export async function recognizeImageUrl(config, imageUrl) {
    const media = await downloadPublicMedia(imageUrl, IMAGE_MAX_BYTES, config.timeoutMs);
    if (!media.contentType.startsWith('image/'))
        throw new Error('URL 返回的内容不是图片');
    return recognizeImageBytes(config, media.bytes, media.contentType);
}
/** 直接识别本地图片字节，供本地文件导入和设置页上传复用。 */
export async function recognizeImageBytes(config, bytes, contentType = 'image/png') {
    if (!contentType.startsWith('image/'))
        throw new Error('文件不是可识别的图片');
    if (bytes.byteLength > IMAGE_MAX_BYTES)
        throw new Error(`图片超过大小限制 ${Math.floor(IMAGE_MAX_BYTES / 1024 / 1024)}MB`);
    const media = { bytes, contentType };
    const baseUrl = config.baseUrl.replace(/\/+$/, '');
    if (isAnthropicEndpoint(baseUrl))
        return recognizeWithAnthropic(config, baseUrl, media);
    return recognizeWithOpenAiCompatible(config, baseUrl, media);
}
function isAnthropicEndpoint(baseUrl) {
    return /\/anthropic(?:\/v1)?$/i.test(baseUrl);
}
function anthropicMessagesUrl(baseUrl) {
    return /\/v1$/i.test(baseUrl) ? `${baseUrl}/messages` : `${baseUrl}/v1/messages`;
}
async function recognizeWithOpenAiCompatible(config, baseUrl, media) {
    const response = await fetch(joinApiPath(baseUrl, 'chat/completions'), {
        method: 'POST',
        headers: apiHeaders(config.apiKey),
        signal: AbortSignal.timeout(config.timeoutMs),
        body: JSON.stringify({
            model: config.model,
            temperature: 0,
            max_tokens: OCR_MAX_OUTPUT_TOKENS,
            messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: OCR_PROMPT },
                        { type: 'image_url', image_url: { url: `data:${media.contentType};base64,${media.bytes.toString('base64')}` } },
                    ],
                }],
        }),
    });
    const payload = await jsonResponse(response);
    const message = payload?.choices?.[0]?.message;
    const text = typeof message?.content === 'string' ? message.content.trim() : '';
    if (text)
        return text;
    if (typeof message?.reasoning_content === 'string' && message.reasoning_content.trim())
        throw new Error('OCR 模型只返回了推理过程，没有输出最终文字；请换用非推理视觉模型或重试');
    throw new Error('OCR 服务没有返回可用文字');
}
async function recognizeWithAnthropic(config, baseUrl, media) {
    const apiKey = config.apiKey?.trim();
    const response = await fetch(anthropicMessagesUrl(baseUrl), {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'anthropic-version': '2023-06-01',
            ...(apiKey ? { 'x-api-key': apiKey, authorization: `Bearer ${apiKey}` } : {}),
        },
        signal: AbortSignal.timeout(config.timeoutMs),
        body: JSON.stringify({
            model: config.model,
            max_tokens: OCR_MAX_OUTPUT_TOKENS,
            temperature: 0,
            messages: [{
                    role: 'user',
                    content: [
                        { type: 'image', source: { type: 'base64', media_type: media.contentType, data: media.bytes.toString('base64') } },
                        { type: 'text', text: OCR_PROMPT },
                    ],
                }],
        }),
    });
    const payload = await jsonResponse(response);
    const blocks = Array.isArray(payload?.content) ? payload.content : [];
    const text = blocks
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
        .trim();
    if (text)
        return text;
    if (blocks.some((block) => block?.type === 'thinking' || block?.type === 'reasoning'))
        throw new Error('OCR 模型只返回了推理过程，没有输出最终文字；请换用非推理视觉模型或重试');
    throw new Error('OCR 服务没有返回可用文字');
}
/** 使用 OpenAI 兼容 audio/transcriptions 接口转写可直接下载的音频 URL。 */
export async function transcribeAudioUrl(config, audioUrl) {
    const media = await downloadPublicMedia(audioUrl, AUDIO_MAX_BYTES, config.timeoutMs);
    return transcribeAudioBytes(config, media.bytes, media.contentType, media.filename);
}
/** 直接转写本地音频字节，供本地文件导入和设置页上传复用。 */
export async function transcribeAudioBytes(config, bytes, contentType = 'application/octet-stream', filename = 'audio.bin') {
    if (bytes.byteLength > AUDIO_MAX_BYTES)
        throw new Error(`音频超过大小限制 ${Math.floor(AUDIO_MAX_BYTES / 1024 / 1024)}MB`);
    const form = new FormData();
    form.set('model', config.model);
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    form.set('file', new Blob([arrayBuffer], { type: contentType }), filename);
    const headers = {};
    if (config.apiKey?.trim())
        headers.authorization = `Bearer ${config.apiKey.trim()}`;
    const response = await fetch(joinApiPath(config.baseUrl, 'audio/transcriptions'), {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(config.timeoutMs),
        body: form,
    });
    const payload = await jsonResponse(response);
    const text = payload?.text;
    if (typeof text !== 'string' || !text.trim())
        throw new Error('ASR 服务没有返回可用转写文本');
    return text.trim();
}
function apiHeaders(apiKey) {
    return {
        'content-type': 'application/json',
        ...(apiKey?.trim() ? { authorization: `Bearer ${apiKey.trim()}` } : {}),
    };
}
function joinApiPath(baseUrl, path) {
    return `${baseUrl.replace(/\/$/, '')}/${path}`;
}
async function jsonResponse(response) {
    const text = await response.text();
    let payload;
    try {
        payload = JSON.parse(text);
    }
    catch {
        throw new Error(`模型服务返回了非 JSON 响应（HTTP ${response.status}）`);
    }
    if (!response.ok) {
        const message = payload?.error?.message ?? payload?.message ?? `HTTP ${response.status}`;
        throw new Error(`模型服务请求失败：${String(message)}`);
    }
    return payload;
}
async function downloadPublicMedia(rawUrl, maxBytes, timeoutMs) {
    let current = new URL(rawUrl);
    for (let redirect = 0; redirect < 5; redirect += 1) {
        await assertPublicHttpUrl(current);
        const response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            if (!location)
                throw new Error('媒体 URL 重定向缺少 Location');
            current = new URL(location, current);
            continue;
        }
        if (!response.ok)
            throw new Error(`媒体下载失败（HTTP ${response.status}）`);
        const declared = Number(response.headers.get('content-length') ?? 0);
        if (declared > maxBytes)
            throw new Error(`媒体文件超过大小限制 ${Math.floor(maxBytes / 1024 / 1024)}MB`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.byteLength > maxBytes)
            throw new Error(`媒体文件超过大小限制 ${Math.floor(maxBytes / 1024 / 1024)}MB`);
        const contentType = (response.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim();
        const filename = decodeURIComponent(current.pathname.split('/').pop() || 'media.bin');
        return { bytes, contentType, filename };
    }
    throw new Error('媒体 URL 重定向次数过多');
}
async function assertPublicHttpUrl(url) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
        throw new Error('媒体 URL 只允许 http 或 https');
    if (url.username || url.password)
        throw new Error('媒体 URL 不允许携带用户名或密码');
    const addresses = isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true });
    if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address)))
        throw new Error('媒体 URL 不能指向本机或私有网络地址');
}
function isPrivateAddress(address) {
    const normalized = address.toLowerCase();
    if (normalized === '::1' || normalized === '0.0.0.0' || normalized === '127.0.0.1')
        return true;
    if (normalized.startsWith('10.') || normalized.startsWith('127.') || normalized.startsWith('169.254.') || normalized.startsWith('192.168.'))
        return true;
    const match = /^172\.(\d+)\./.exec(normalized);
    if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31)
        return true;
    return normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:') || normalized === '::';
}
