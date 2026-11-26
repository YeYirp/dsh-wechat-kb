import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { inflateRawSync } from 'node:zlib';
import { addLocalDocument } from './local-store.js';

const execFileAsync = promisify(execFile);

/** 单个本地文件读取上限，避免误传巨大文件拖垮主进程。 */
const MAX_FILE_BYTES = 64 * 1024 * 1024;
/** 入库正文字符上限；超过时保留前部并标注截断。 */
const MAX_TEXT_CHARS = 2_000_000;
/** 目录导入的文件数量上限。 */
const MAX_DIRECTORY_FILES = 200;
const MAX_SPREADSHEET_ROWS = 5000;
const MAX_SPREADSHEET_COLUMNS = 120;

/** 图内 OCR 并发数：OCR 是网络请求，串行跑太慢；4 路兼顾网关限流。 */
const OCR_CONCURRENCY = 4;
const IMAGE_MAX_EDGE = 1024;
const IMAGE_JPEG_QUALITY = 75;
const IMAGE_DIR = 'uploads/images';
/** 视觉模型对没有文字的图常回一句说明，别把它当正文写进资料。 */
const NO_TEXT_OCR = /^[（(【\[]*(?:(?:这张|该|这)?\s*(?:图|图片|图像|照片)(?:中|里|上)?\s*)?(?:未识别到|未发现|未检测到|未包含|没有|不含|不存在|无|没有任何)\s*(?:任何)?\s*(?:(?:清晰|可读|可识别|可辨认|有效)(?:的)?)*\s*文字(?:内容)?\s*(?:[（(][^）)]*[）)])?[）)】\]]*[。.!！,，;；:：\s]*$/;
const NO_TEXT_HINT = /未识别到|未发现|未检测到|未包含|没有任何|无可识别|无文字/;
/** 模型对无字图片的说明句：既有固定短句，也有「（图片中未识别到任何文字、标题、段落…）」这类长句。 */
function isNoTextClaim(line) {
    if (NO_TEXT_OCR.test(line))
        return true;
    return line.length <= 80 && NO_TEXT_HINT.test(line) && /(?:图片|图像|照片|图中|这张)/.test(line);
}
export function usableOcrText(text) {
    const trimmed = String(text ?? '').trim();
    if (!trimmed)
        return '';
    if (trimmed.length <= 24 && isNoTextClaim(trimmed))
        return '';
    // 长文本里常夹着「图片中未识别到文字」这类拒识话术，逐行剔掉。
    const kept = trimmed
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !isNoTextClaim(line));
    return kept.join('\n').trim();
}
/** 推理型视觉模型偶尔只回推理过程，重试一次通常就好。 */
async function recognizeWithRetry(recognizeImage, bytes, mime, name) {
    try {
        return await recognizeImage(bytes, mime, name);
    }
    catch (error) {
        if (!/只返回了推理过程/.test(String(error instanceof Error ? error.message : error)))
            throw error;
        await new Promise((resolve) => setTimeout(resolve, 800));
        return recognizeImage(bytes, mime, name);
    }
}
/** 小并发池，结果按输入顺序返回，避免 OCR 串行拖到十几分钟。 */
async function mapWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) {
            const index = cursor;
            cursor += 1;
            results[index] = await worker(items[index], index);
        }
    });
    await Promise.all(runners);
    return results;
}
const IMAGE_MEDIA_BY_EXTENSION = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
};

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.xml', '.yaml', '.yml', '.ini', '.html', '.htm']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.wav', '.webm', '.ogg', '.flac', '.aac']);
const WORD_EXTENSIONS = new Set(['.docx', '.docm']);
const EXCEL_EXTENSIONS = new Set(['.xlsx', '.xlsm']);
const SLIDE_EXTENSIONS = new Set(['.pptx', '.pptm']);
const LEGACY_OFFICE_EXTENSIONS = new Set(['.doc', '.xls', '.ppt']);
const IMAGE_MIME = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
};
const AUDIO_MIME = {
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.wav': 'audio/wav',
    '.webm': 'audio/webm',
    '.ogg': 'audio/ogg',
    '.flac': 'audio/flac',
    '.aac': 'audio/aac',
};

export function supportedExtensions() {
    return [...TEXT_EXTENSIONS, ...WORD_EXTENSIONS, ...EXCEL_EXTENSIONS, ...SLIDE_EXTENSIONS, '.pdf', ...IMAGE_EXTENSIONS, ...AUDIO_EXTENSIONS];
}

/** 判断路径是否属于可直接导入的格式；旧版二进制 Office 格式明确给出替代建议。 */
export function classifyFile(fileName) {
    const extension = extname(String(fileName)).toLowerCase();
    if (WORD_EXTENSIONS.has(extension))
        return { kind: 'word', extension };
    if (EXCEL_EXTENSIONS.has(extension))
        return { kind: 'excel', extension };
    if (SLIDE_EXTENSIONS.has(extension))
        return { kind: 'slides', extension };
    if (extension === '.pdf')
        return { kind: 'pdf', extension };
    if (TEXT_EXTENSIONS.has(extension))
        return { kind: 'text', extension };
    if (IMAGE_EXTENSIONS.has(extension))
        return { kind: 'image', extension, mime: IMAGE_MIME[extension] };
    if (AUDIO_EXTENSIONS.has(extension))
        return { kind: 'audio', extension, mime: AUDIO_MIME[extension] };
    if (LEGACY_OFFICE_EXTENSIONS.has(extension))
        return { kind: 'legacy', extension };
    return { kind: 'unsupported', extension };
}

export function titleFromFileName(fileName) {
    const base = basename(String(fileName));
    const extension = extname(base);
    return (extension ? base.slice(0, -extension.length) : base).trim();
}

function limitText(text) {
    if (text.length <= MAX_TEXT_CHARS)
        return { text, truncated: false };
    return { text: `${text.slice(0, MAX_TEXT_CHARS)}\n\n（内容过长，已截断；原文件约 ${text.length} 个字符）`, truncated: true };
}

function normalizeText(text) {
    return String(text)
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function decodeXmlEntities(value) {
    return value
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex) => safeCodePoint(Number.parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_match, dec) => safeCodePoint(Number.parseInt(dec, 10)))
        .replace(/&amp;/g, '&');
}

function safeCodePoint(value) {
    try {
        return String.fromCodePoint(value);
    }
    catch {
        return '';
    }
}

function stripTags(value) {
    return value.replace(/<[^>]*>/g, '');
}

/** 极简 UTF-8/GB18030 文本解码；无法按 UTF-8 解释时再尝试中文常见编码。 */
function decodeTextFile(buffer) {
    const utf8 = buffer.toString('utf8');
    if (!utf8.includes('\uFFFD'))
        return utf8.replace(/^\uFEFF/, '');
    try {
        const decoded = new TextDecoder('gb18030').decode(buffer);
        if (decoded && !decoded.includes('\uFFFD'))
            return decoded.replace(/^\uFEFF/, '');
    }
    catch {
        /* 当前运行时缺少该解码器时保留 UTF-8 结果。 */
    }
    return utf8.replace(/^\uFEFF/, '');
}

/** 读取 ZIP 中央目录，返回文件名到解压后内容的映射；兼容存储与 deflate 两种方式。 */
export function unzip(buffer) {
    const files = new Map();
    const endSignatures = [];
    const scanStart = Math.max(0, buffer.length - 66 * 1024);
    for (let index = buffer.length - 22; index >= scanStart; index -= 1) {
        if (buffer.readUInt32LE(index) === 0x06054b50) {
            endSignatures.push(index);
            break;
        }
    }
    if (!endSignatures.length)
        throw new Error('文件不是有效的 Office/压缩包格式');
    const end = endSignatures[0];
    const entryCount = buffer.readUInt16LE(end + 10);
    let offset = buffer.readUInt32LE(end + 16);
    for (let entry = 0; entry < entryCount; entry += 1) {
        if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50)
            break;
        const method = buffer.readUInt16LE(offset + 10);
        const compressedSize = buffer.readUInt32LE(offset + 20);
        const uncompressedSize = buffer.readUInt32LE(offset + 24);
        const nameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        const localOffset = buffer.readUInt32LE(offset + 42);
        const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
        offset += 46 + nameLength + extraLength + commentLength;
        if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50)
            continue;
        const localNameLength = buffer.readUInt16LE(localOffset + 26);
        const localExtraLength = buffer.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + localNameLength + localExtraLength;
        if (dataStart + compressedSize > buffer.length)
            continue;
        const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
        try {
            if (method === 0)
                files.set(name, Buffer.from(compressed));
            else if (method === 8)
                files.set(name, inflateRawSync(compressed));
            else if (uncompressedSize === 0)
                files.set(name, Buffer.alloc(0));
        }
        catch {
            /* 损坏的单个条目不应让整份文档失败。 */
        }
    }
    return files;
}

function zipText(files, name) {
    const entry = files.get(name);
    return entry ? entry.toString('utf8') : '';
}

/** Word：按段落、表格单元格、换行和制表符还原为可检索的纯文本。 */
export function docxToText(buffer) {
    const files = unzip(buffer);
    const xml = zipText(files, 'word/document.xml');
    if (!xml)
        throw new Error('Word 文档缺少正文（word/document.xml）');
    const lines = [];
    let current = '';
    let inTable = false;
    let tableCells = [];
    const pattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>|<w:tbl>|<\/w:tbl>|<\/w:p>|<\/w:tc>|<\/w:tr>/g;
    let match;
    while ((match = pattern.exec(xml))) {
        if (match[1] !== undefined)
            current += decodeXmlEntities(stripTags(match[1]));
        else if (match[0].startsWith('<w:tab'))
            current += '\t';
        else if (match[0].startsWith('<w:br'))
            current += inTable ? ' ' : '\n';
        else if (match[0] === '<w:tbl>') {
            inTable = true;
            tableCells = [];
        }
        else if (match[0] === '</w:tbl>') {
            inTable = false;
        }
        else if (match[0] === '</w:tc>') {
            tableCells.push(current.trim());
            current = '';
        }
        else if (match[0] === '</w:tr>') {
            if (tableCells.some((cell) => cell.length))
                lines.push(tableCells.join('\t'));
            tableCells = [];
        }
        else if (inTable) {
            if (current.trim())
                current += ' ';
        }
        else {
            lines.push(current);
            current = '';
        }
    }
    if (current.trim())
        lines.push(current);
    return normalizeText(lines.map((line) => line.replace(/[ \t]+$/g, '')).join('\n'));
}

function sharedStringsOf(files) {
    const xml = zipText(files, 'xl/sharedStrings.xml');
    if (!xml)
        return [];
    const strings = [];
    const pattern = /<si>([\s\S]*?)<\/si>/g;
    let match;
    while ((match = pattern.exec(xml))) {
        const texts = [];
        const textPattern = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
        let textMatch;
        while ((textMatch = textPattern.exec(match[1])))
            texts.push(decodeXmlEntities(stripTags(textMatch[1])));
        strings.push(texts.join(''));
    }
    return strings;
}

function workbookSheets(files) {
    const workbook = zipText(files, 'xl/workbook.xml');
    const relationships = new Map();
    const relXml = zipText(files, 'xl/_rels/workbook.xml.rels');
    const relPattern = /<Relationship\b([^>]*)\/?>/g;
    let relMatch;
    while ((relMatch = relPattern.exec(relXml))) {
        const attrs = attributesOf(relMatch[1]);
        if (attrs.Id && attrs.Target)
            relationships.set(attrs.Id, attrs.Target);
    }
    const resolveTarget = (target) => posix.normalize(target.startsWith('/') ? target.slice(1) : posix.join('xl', target));
    const sheets = [];
    const sheetPattern = /<sheet\b([^>]*)\/?>/g;
    let sheetMatch;
    while ((sheetMatch = sheetPattern.exec(workbook))) {
        const attrs = attributesOf(sheetMatch[1]);
        const relation = attrs['r:id'];
        const target = relation ? relationships.get(relation) : undefined;
        const fallback = `worksheets/sheet${sheets.length + 1}.xml`;
        const path = target ? resolveTarget(target) : `xl/${fallback}`;
        sheets.push({ name: attrs.name || `工作表 ${sheets.length + 1}`, path });
    }
    return sheets;
}

/** 从 xlsx 的 styles.xml 推导日期格式单元格，避免把日期显示成序列号。 */
function dateStyleIndexes(files) {
    const xml = zipText(files, 'xl/styles.xml');
    if (!xml)
        return new Set();
    const customDateFormats = new Set();
    const formatPattern = /<numFmt\b([^>]*)\/?>/g;
    let formatMatch;
    while ((formatMatch = formatPattern.exec(xml))) {
        const attrs = attributesOf(formatMatch[1]);
        const code = attrs.formatCode || '';
        if (attrs.numFmtId && /[ymdhs]/i.test(code) && !/^[#0.,%\s-]+$/.test(code))
            customDateFormats.add(Number(attrs.numFmtId));
    }
    const builtinDateIds = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
    const cellXfsMatch = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
    const result = new Set();
    if (cellXfsMatch) {
        const xfPattern = /<xf\b([^>]*?)(?:\/>|>)/g;
        let xfMatch;
        let index = 0;
        while ((xfMatch = xfPattern.exec(cellXfsMatch[1]))) {
            const attrs = attributesOf(xfMatch[1]);
            const numFmtId = Number(attrs.numFmtId ?? 0);
            if (builtinDateIds.has(numFmtId) || customDateFormats.has(numFmtId))
                result.add(index);
            index += 1;
        }
    }
    return result;
}

function attributesOf(raw) {
    const attrs = {};
    const pattern = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
    let match;
    while ((match = pattern.exec(raw)))
        attrs[match[1]] = decodeXmlEntities(match[2]);
    return attrs;
}

function columnIndex(reference) {
    const letters = /^[A-Za-z]+/.exec(reference)?.[0];
    if (!letters)
        return 0;
    let value = 0;
    for (const letter of letters.toUpperCase())
        value = value * 26 + (letter.charCodeAt(0) - 64);
    return Math.max(0, value - 1);
}

function excelSerialToText(serial) {
    if (!Number.isFinite(serial))
        return String(serial);
    const base = Date.UTC(1899, 11, 30);
    const date = new Date(base + Math.round(serial * 86400000));
    if (Number.isNaN(date.getTime()) || serial <= 0)
        return String(serial);
    const iso = date.toISOString();
    const datePart = iso.slice(0, 10);
    const timePart = iso.slice(11, 16);
    if (timePart === '00:00')
        return datePart;
    return `${datePart} ${timePart}`;
}

function cellText(attrs, inner, sharedStrings, dateStyles) {
    const type = attrs.t || 'n';
    if (type === 's') {
        const index = Number((/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1]);
        return Number.isSafeInteger(index) ? sharedStrings[index] ?? '' : '';
    }
    if (type === 'inlineStr') {
        const texts = [];
        const pattern = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
        let match;
        while ((match = pattern.exec(inner)))
            texts.push(decodeXmlEntities(stripTags(match[1])));
        return texts.join('');
    }
    if (type === 'b')
        return /<v>1<\/v>/.test(inner) ? 'TRUE' : 'FALSE';
    if (type === 'str' || type === 'e')
        return decodeXmlEntities(stripTags((/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1] ?? ''));
    const raw = decodeXmlEntities(stripTags((/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1] ?? ''));
    if (!raw)
        return '';
    if (dateStyles.has(Number(attrs.s ?? -1)))
        return excelSerialToText(Number(raw));
    return raw;
}

/** Excel：逐工作表还原为 TSV 文本，保留空单元格位置，尽量保留日期语义。 */
export function xlsxToText(buffer) {
    const files = unzip(buffer);
    const sharedStrings = sharedStringsOf(files);
    const dateStyles = dateStyleIndexes(files);
    const sheets = workbookSheets(files);
    if (!sheets.length)
        throw new Error('Excel 文件缺少工作表');
    const sections = [];
    for (const sheet of sheets) {
        const xml = zipText(files, sheet.path);
        if (!xml) {
            sections.push(`## 工作表：${sheet.name}\n（工作表内容为空或无法读取）`);
            continue;
        }
        const rows = [];
        const rowPattern = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
        let rowMatch;
        while ((rowMatch = rowPattern.exec(xml)) && rows.length < MAX_SPREADSHEET_ROWS) {
            const cells = [];
            const cellPattern = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
            let cellMatch;
            while ((cellMatch = cellPattern.exec(rowMatch[1]))) {
                const attrs = attributesOf(cellMatch[1]);
                const index = attrs.r ? columnIndex(attrs.r) : cells.length;
                if (index >= MAX_SPREADSHEET_COLUMNS)
                    continue;
                while (cells.length < index)
                    cells.push('');
                cells[index] = cellText(attrs, cellMatch[2] ?? '', sharedStrings, dateStyles).replace(/[\t\n]+/g, ' ');
            }
            const line = cells.join('\t').replace(/\t+$/g, '');
            if (line.trim())
                rows.push(line);
        }
        sections.push(`## 工作表：${sheet.name}\n${rows.join('\n') || '（空工作表）'}`);
    }
    return normalizeText(sections.join('\n\n'));
}

/** PowerPoint：按幻灯片顺序提取标题与正文。 */
export function pptxToText(buffer) {
    const files = unzip(buffer);
    const slides = [...files.keys()]
        .map((name) => ({ name, match: /^ppt\/slides\/slide(\d+)\.xml$/.exec(name) }))
        .filter((item) => item.match)
        .sort((left, right) => Number(left.match[1]) - Number(right.match[1]));
    if (!slides.length)
        throw new Error('PowerPoint 文件缺少幻灯片内容');
    return normalizeText(slides.map((slide, index) => {
        const xml = zipText(files, slide.name);
        const lines = [];
        let current = '';
        const pattern = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<\/a:p>/g;
        let match;
        while ((match = pattern.exec(xml))) {
            if (match[1] !== undefined)
                current += decodeXmlEntities(stripTags(match[1]));
            else {
                lines.push(current);
                current = '';
            }
        }
        if (current.trim())
            lines.push(current);
        const body = lines.map((line) => line.trim()).filter(Boolean).join('\n');
        return `## 幻灯片 ${index + 1}\n${body}`;
    }).join('\n\n'));
}

function htmlToText(html) {
    return decodeXmlEntities(stripTags(html
        .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
        .replace(/<\/(?:p|div|li|tr|h[1-6]|section|article)>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(?:td|th)>/gi, '\t')))
        .replace(/[ \t]+/g, ' ');
}

/** PDF：文字层 + 内嵌图片 OCR；扫描件（文字层为空）仍然报错。 */
async function pdfToText(buffer, options = {}) {
    let getDocumentProxy;
    let extractText;
    let extractImages;
    let renderPageAsImage;
    try {
        ({ getDocumentProxy, extractText, extractImages, renderPageAsImage } = await import('unpdf'));
    }
    catch (error) {
        throw new Error(`PDF 解析组件不可用：${error instanceof Error ? error.message : '加载失败'}`);
    }
    let proxy;
    let result;
    try {
        proxy = await getDocumentProxy(new Uint8Array(buffer), { verbosity: 0 });
        result = await extractText(proxy, { mergePages: false });
    }
    catch (error) {
        throw new Error(`PDF 文本提取失败：${error instanceof Error ? error.message : '文件可能已加密或损坏'}`);
    }
    const pages = Array.isArray(result.text) ? result.text : [result.text];
    const pageTexts = Array.from({ length: result.totalPages }, (_, index) => String(pages[index] ?? '').replace(/[ \t]+$/gm, '').trim());
    // 不再一上来就拒绝扫描件：先抠每页图做 OCR，OCR 出字就按图内文字入库。
    // 单文件里的图片数量不设上限：先把所有页的图收齐，再统一并发识别，最后按页汇总。
    const images = [];
    const 任务 = [];
    for (let page = 1; page <= result.totalPages; page += 1) {
        try {
            const pageImages = await extractImages(proxy, page, { format: 'png' });
            for (const [index, image] of pageImages.entries()) {
                const name = `第${page}页-${index + 1}.png`;
                const bytes = Buffer.from(image.data);
                images.push({ bytes, mediaType: 'image/png', page, name });
                if (!options.recognizeImage)
                    continue;
                // 装饰条/小图标不 OCR，免得几十次无效请求。只按面积判断，避免整行文字（如 1024×58 的说明条）被单边阈值漏掉。
                const imageWidth = image.width ?? 0;
                const imageHeight = image.height ?? 0;
                if ((imageWidth < 120 && imageHeight < 80) || imageWidth < 40 || imageHeight < 24)
                    continue;
                任务.push({ page, name, bytes, mediaType: 'image/png', kind: 'image' });
            }
            // 整页渲染再 OCR：矢量表格、流程图、扫描页这时才拿得到。
            const 页文字 = pageTexts[page - 1] || '';
            if (options.recognizeImage && renderPageAsImage && (pageImages.length > 0 || 页文字.length < 300)) {
                try {
                    const pageJpeg = await renderPageAsImage(proxy, page, {
                        canvasImport: () => import('@napi-rs/canvas'),
                        format: 'jpeg',
                        quality: 0.8,
                        width: 1600,
                    });
                    任务.push({ page, name: `第${page}页整页`, bytes: Buffer.from(pageJpeg), mediaType: 'image/jpeg', kind: 'render' });
                }
                catch (error) {
                    console.warn(`[knowledge] PDF 整页渲染失败，跳过第 ${page} 页：${error instanceof Error ? error.message : error}`);
                }
            }
        }
        catch {
            /* 单页取图失败不影响文字入库 */
        }
    }
    // 同一张图（比如每页重复出现的 LOGO）只识别一次；单张失败只跳过它自己。
    const ocrCache = new Map();
    const 识别结果 = await mapWithConcurrency(任务, OCR_CONCURRENCY, async (task) => {
        const key = createHash('sha256').update(task.bytes).digest('hex');
        if (ocrCache.has(key))
            return { page: task.page, kind: task.kind, text: ocrCache.get(key) };
        try {
            const jpeg = await compressImageToJpeg(task.bytes, task.mediaType);
            const text = usableOcrText(await recognizeWithRetry(options.recognizeImage, jpeg || task.bytes, 'image/jpeg', task.name));
            ocrCache.set(key, text);
            return { page: task.page, kind: task.kind, text };
        }
        catch (error) {
            console.warn(`[knowledge] PDF 图内 OCR 失败，跳过：${task.name}（${error instanceof Error ? error.message : error}）`);
            ocrCache.set(key, '');
            return { page: task.page, kind: task.kind, text: '' };
        }
    });
    // 全部识别完成后再按页汇总：先图内文字，再整页文字，顺序与逐页处理时一致。
    const 按页 = new Map();
    for (const item of 识别结果) {
        if (!item.text)
            continue;
        const slot = 按页.get(item.page) ?? { 图内: [], 整页: [] };
        (item.kind === 'render' ? slot.整页 : slot.图内).push(item.text);
        按页.set(item.page, slot);
    }
    for (const [page, slot] of 按页) {
        let 页文字 = pageTexts[page - 1];
        if (slot.图内.length)
            页文字 = `${页文字}\n【图内文字】\n${slot.图内.join('\n')}`;
        if (slot.整页.length)
            页文字 = `${页文字}\n【图内文字】\n${slot.整页.join('\n')}`;
        pageTexts[page - 1] = 页文字;
    }
    const text = normalizeText(pageTexts.filter(Boolean).join('\n\n'));
    if (!text.replace(/\s/g, ''))
        throw new Error('PDF 中没有可提取的文字；整页扫描 OCR 也没识别出文字，请检查扫描清晰度或截图后用 OCR 导入');
    return { text, pageCount: result.totalPages, images };
}

function officeImages(buffer, kind) {
    const prefixes = kind === 'word'
        ? ['word/media/']
        : kind === 'excel'
            ? ['xl/media/']
            : ['ppt/media/'];
    const images = [];
    try {
        const files = unzip(buffer);
        for (const [name, data] of files) {
            if (!prefixes.some((prefix) => name.startsWith(prefix)))
                continue;
            const mediaType = IMAGE_MEDIA_BY_EXTENSION[extname(name).toLowerCase()];
            if (!mediaType || !data?.byteLength)
                continue;
            images.push({ bytes: Buffer.from(data), mediaType, name: basename(name) });
        }
    }
    catch {
        /* 文档文字已解析成功时，图片解包失败不影响入库 */
    }
    return images;
}

async function ocrOfficeImages(images, options) {
    if (!Array.isArray(images) || !images.length || !options.recognizeImage)
        return '';
    // Office 内嵌图也走并发池：不再限制单文件识别张数，单张失败只跳过它自己。
    const 待识别 = images.filter((image) => image?.bytes?.byteLength && image.bytes.byteLength <= 5 * 1024 * 1024);
    const ocrCache = new Map();
    const texts = await mapWithConcurrency(待识别, OCR_CONCURRENCY, async (image) => {
        const key = createHash('sha256').update(Buffer.from(image.bytes)).digest('hex');
        if (ocrCache.has(key))
            return ocrCache.get(key);
        try {
            const jpeg = await compressImageToJpeg(Buffer.from(image.bytes), image.mediaType);
            const text = usableOcrText(await recognizeWithRetry(options.recognizeImage, jpeg || Buffer.from(image.bytes), 'image/jpeg', image.name || '内嵌图'));
            ocrCache.set(key, text);
            return text;
        }
        catch (error) {
            console.warn(`[knowledge] Office 图内 OCR 失败，跳过：${image.name || '内嵌图'}（${error instanceof Error ? error.message : error}）`);
            ocrCache.set(key, '');
            return '';
        }
    });
    const kept = texts.filter(Boolean);
    return kept.length ? `\n【图内文字】\n${kept.join('\n')}` : '';
}

/** 用 Windows 自带的 System.Drawing 把图片压到长边 1024、JPEG 75，不引入 npm 依赖。 */
async function compressImageToJpeg(input, mediaType) {
    let directory;
    try {
        if (mediaType === 'image/jpeg' && input.byteLength > 8 * 1024 * 1024)
            return null;
        directory = await mkdtemp(join(tmpdir(), 'dsh-kb-image-'));
        const source = join(directory, 'source');
        const target = join(directory, 'target.jpg');
        await writeFile(source, input);
        const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
        const script = [
            'Add-Type -AssemblyName System.Drawing',
            `$src=[System.Drawing.Image]::FromFile(${quote(source)})`,
            'try {',
            '  $max=[Math]::Max($src.Width,$src.Height)',
            '  $scale=[Math]::Min(1.0,[Double]1024/[Double]$max)',
            '  $w=[int][Math]::Max(1,[Math]::Round([Double]$src.Width*$scale))',
            '  $h=[int][Math]::Max(1,[Math]::Round([Double]$src.Height*$scale))',
            '  $bmp=New-Object -TypeName System.Drawing.Bitmap -ArgumentList $w,$h',
            '  $g=[System.Drawing.Graphics]::FromImage($bmp)',
            '  $g.Clear([System.Drawing.Color]::White)',
            '  $g.DrawImage($src,0,0,$w,$h)',
            "  $codec=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }",
            '  $ep=New-Object -TypeName System.Drawing.Imaging.EncoderParameters -ArgumentList 1',
            '  $ep.Param[0]=New-Object -TypeName System.Drawing.Imaging.EncoderParameter -ArgumentList ([System.Drawing.Imaging.Encoder]::Quality),75',
            `  $bmp.Save(${quote(target)},$codec,$ep)`,
            '} finally {',
            '  if ($g) { $g.Dispose() }',
            '  if ($bmp) { $bmp.Dispose() }',
            '  $src.Dispose()',
            '}',
        ].join('\n');
        await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 30_000, windowsHide: true });
        const output = await readFile(target);
        return output.byteLength ? output : null;
    }
    catch {
        return null;
    }
    finally {
        if (directory)
            await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
}

async function persistDocumentImages(storePath, images) {
    if (!Array.isArray(images) || !images.length)
        return [];
    const directory = join(dirname(storePath), ...IMAGE_DIR.split('/'));
    await mkdir(directory, { recursive: true });
    const result = [];
    const seen = new Set();
    for (const image of images) {
        if (!image?.bytes?.byteLength)
            continue;
        const digest = createHash('sha256').update(image.bytes).digest('hex');
        if (seen.has(digest))
            continue;
        seen.add(digest);
        const jpeg = await compressImageToJpeg(Buffer.from(image.bytes), image.mediaType);
        if (!jpeg)
            continue;
        const fileName = `${digest.slice(0, 32)}.jpg`;
        await writeFile(join(directory, fileName), jpeg, { mode: 0o600 });
        result.push({
            path: fileName,
            mediaType: 'image/jpeg',
            ...(Number.isFinite(Number(image.page)) ? { page: Math.max(1, Math.trunc(Number(image.page))) } : {}),
            ...(image.name ? { caption: String(image.name).slice(0, 200) } : {}),
        });
    }
    return result;
}

/**
 * 提取单个文件的文本。
 * options.recognizeImage(bytes, mime, fileName) 与 options.transcribeAudio(bytes, mime, fileName)
 * 由调用方提供，用于复用知识复习设置里的 OCR / ASR。
 */
export async function extractTextFromBuffer(buffer, fileName, options = {}) {
    if (buffer.byteLength > MAX_FILE_BYTES)
        throw new Error(`文件超过 ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)}MB 限制`);
    const file = classifyFile(fileName);
    let text;
    let meta = {};
    let images = [];
    if (file.kind === 'text') {
        const raw = decodeTextFile(buffer);
        text = file.extension === '.html' || file.extension === '.htm' ? htmlToText(raw) : raw;
    }
    else if (file.kind === 'word') {
        text = docxToText(buffer);
        images = officeImages(buffer, 'word');
        text += await ocrOfficeImages(images, options);
    }
    else if (file.kind === 'excel') {
        text = xlsxToText(buffer);
        images = officeImages(buffer, 'excel');
        text += await ocrOfficeImages(images, options);
    }
    else if (file.kind === 'slides') {
        text = pptxToText(buffer);
        images = officeImages(buffer, 'slides');
        text += await ocrOfficeImages(images, options);
    }
    else if (file.kind === 'pdf') {
        const pdf = await pdfToText(buffer, options);
        text = pdf.text;
        images = pdf.images;
        meta = { pageCount: pdf.pageCount };
    }
    else if (file.kind === 'image') {
        images = [{ bytes: buffer, mediaType: file.mime, name: basename(fileName) }];
        // OCR 失败（或 OCR 未开启）不丢图：原图照样进 uploads，正文写一句可检索的说明。
        let ocrText = '';
        if (options.recognizeImage) {
            try {
                ocrText = usableOcrText(await recognizeWithRetry(options.recognizeImage, buffer, file.mime, fileName));
            }
            catch {
                ocrText = '';
            }
        }
        if (String(ocrText || '').trim()) {
            text = ocrText;
            meta = { ocr: true };
        }
        else {
            text = `图片资料：${basename(fileName)}（OCR 未识别出文字，原图已保留）`;
            meta = { ocr: false, imageOnly: true };
        }
    }
    else if (file.kind === 'audio') {
        if (!options.transcribeAudio)
            throw new Error('音频需要 ASR；请在 DSH 设置 → 知识复习中启用 ASR 后重试');
        text = await options.transcribeAudio(buffer, file.mime, fileName);
        meta = { asr: true };
    }
    else if (file.kind === 'legacy')
        throw new Error(`暂不支持旧版 ${file.extension} 格式，请另存为 .docx / .xlsx / .pptx / .pdf 后再导入`);
    else
        throw new Error(`不支持的文件类型 ${file.extension || '（无扩展名）'}`);
    const clean = normalizeText(text);
    if (!clean)
        throw new Error('文件中没有可提取的文字内容');
    return { ...limitText(clean), kind: file.kind, images, ...meta };
}

async function readLocalFile(filePath) {
    const info = await stat(filePath);
    if (!info.isFile())
        throw new Error('不是普通文件');
    if (info.size > MAX_FILE_BYTES)
        throw new Error(`文件超过 ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)}MB 限制`);
    return readFile(filePath);
}

async function collectDirectoryFiles(directory) {
    const found = [];
    const visit = async (current) => {
        const entries = await readdir(current, { withFileTypes: true });
        for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))) {
            if (found.length >= MAX_DIRECTORY_FILES)
                return;
            if (entry.name.startsWith('.') || entry.name === 'node_modules')
                continue;
            const target = join(current, entry.name);
            if (entry.isDirectory())
                await visit(target);
            else if (entry.isFile() && classifyFile(entry.name).kind !== 'unsupported' && classifyFile(entry.name).kind !== 'legacy')
                found.push(target);
        }
    };
    await visit(directory);
    return found;
}

/** 把本地文件或目录全部导入本地知识库；单个文件失败不会中断其他文件。 */
export async function importLocalPaths(inputPaths, options) {
    const raw = String(inputPaths ?? '').split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    if (!raw.length)
        throw new Error('请提供文件或目录路径');
    const targets = [];
    const skipped = [];
    for (const item of raw) {
        const cleaned = item.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').trim();
        const target = resolve(cleaned.startsWith('file://') ? fileURLToPath(cleaned) : cleaned.replace(/^~(?=[\\/])/, homedir()));
        let info;
        try {
            info = await stat(target);
        }
        catch {
            skipped.push({ path: target, reason: '路径不存在' });
            continue;
        }
        if (info.isDirectory()) {
            const files = await collectDirectoryFiles(target);
            if (!files.length)
                skipped.push({ path: target, reason: '目录中没有可导入的文件' });
            for (const file of files)
                targets.push({ path: file, fromDirectory: target });
        }
        else if (info.isFile())
            targets.push({ path: target });
    }
    return importTargets(targets, skipped, options);
}

/** 导入浏览器上传的文件内容（不含本地路径）。 */
export async function importUploadedFiles(uploads, options) {
    const targets = [];
    const skipped = [];
    for (const upload of uploads ?? []) {
        const fileName = String(upload?.fileName ?? '').trim();
        if (!fileName || !upload?.bytes?.byteLength) {
            skipped.push({ path: fileName || '（未命名文件）', reason: '文件内容为空' });
            continue;
        }
        targets.push({ path: fileName, bytes: upload.bytes });
    }
    return importTargets(targets, skipped, options);
}

async function importTargets(targets, skipped, options) {
    const imported = [];
    const failed = [...skipped];
    const total = targets.length;
    for (const target of targets) {
        const fallbackTitle = titleFromFileName(target.path) || '未命名资料';
        const title = (total === 1 ? target.title ?? options.title ?? fallbackTitle : fallbackTitle).trim() || fallbackTitle;
        const baseSource = total === 1 ? options.source : options.source ? `${options.source}：${basename(target.path)}` : undefined;
        const source = (baseSource ?? (target.bytes ? `上传文件：${basename(target.path)}` : `本地文件：${target.path}`)).trim();
        try {
            const bytes = target.bytes ?? await readLocalFile(target.path);
            const extracted = await extractTextFromBuffer(bytes, target.path, options);
            const images = await persistDocumentImages(options.storePath, extracted.images);
            const document = await addLocalDocument(options.storePath, title, extracted.text, source, images);
            imported.push({
                documentId: document.id,
                title: document.title,
                summary: document.summary,
                summarySource: document.summarySource,
                systemCategory: document.systemCategory,
                userCategory: document.userCategory,
                characters: document.content.length,
                ...(images.length ? { imageCount: images.length } : {}),
                ...(extracted.imageOnly ? { imageOnly: true } : {}),
                ...(extracted.pageCount ? { pageCount: extracted.pageCount } : {}),
                ...(extracted.truncated ? { truncated: true } : {}),
            });
        }
        catch (error) {
            failed.push({ path: target.path, reason: error instanceof Error ? error.message : '未知错误' });
        }
    }
    if (imported.length > 3)
        for (const item of imported)
            delete item.summary;
    return { imported, failed, total };
}

export function describeImportResult(result) {
    return {
        status: result.imported.length ? 'READY' : 'FAILED',
        importedCount: result.imported.length,
        failedCount: result.failed.length,
        imported: result.imported,
        failed: result.failed,
        sharedWithCurrentProject: false,
        message: result.imported.length
            ? `已导入 ${result.imported.length} 份资料${result.failed.length ? `，${result.failed.length} 份失败` : ''}。`
            : '没有资料成功写入本地知识库。',
    };
}
