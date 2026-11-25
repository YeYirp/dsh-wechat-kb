/**
 * 纯本地检索文本处理：归一化、分词、停用词、条款切片、语种判断。
 *
 * 这里不访问网络、不调用模型，所有函数都可以单独跑单测。
 * 提问侧和资料侧必须共用同一套归一化（normalizeQuantities + extractTerms），
 * 只归一化一侧等于没做。
 */

/** 不参与打分的高频虚词/口语字。命中的二元词里只要含这些字就丢掉。 */
export const STOP_CHARS = new Set([
    ...'个这那我你他她它我们会样儿了吗呢吧啊呀哦嘛的之其于和与及或也就都还又很更最把被让给对从向在是为以所而但很太挺么怎什哪谁每各某此该些有没未不要想能可',
]);

/** 口语问句的“壳”：分词前先去掉，避免“怎么样 / 是不是”这类词吃掉召回。 */
export const QUESTION_SHELLS = [
    '怎么样', '怎么办', '咋办', '怎么', '如何', '为什么',
    '是不是', '有没有', '会不会', '能不能', '可不可以', '多少', '什么', '请问',
    '帮我', '告诉我', '一下', '麻烦', '想问问', '问一下',
];

/** 数量词后面跟这些单位时，把中文数字换成阿拉伯数字，两侧一致。 */
const QUANTITY_UNITS = ['次', '天', '周', '月', '年', '小时', '分钟', '元', '个', '条', '份', '张', '名', '人', '点', '分', '秒', '岁', '级', '楼', '号', '页', '遍', '趟', '台', '件', '项', '家', '位', '只', '本', '辆', '瓶', '包', '盒', '箱', '套', '双', '斤', '克', '公斤', '米', '公里', '升', '度', '倍', '成', '折', '期', '届', '班'];

const CHINESE_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CHINESE_UNITS = { 十: 10, 百: 100, 千: 1000, 万: 10000 };

/** 全角字母数字和常见标点转半角，避免同一句话出现两套字符。 */
export function normalizeWidth(text) {
    return String(text ?? '')
        .replace(/[\uFF01-\uFF5E]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
        .replace(/\u3000/g, ' ');
}

/** 纯函数：中文数字转阿拉伯数字；无法解析时返回 NaN。 */
export function chineseNumberToArabic(text) {
    const value = String(text ?? '').trim();
    if (!value || !/^[零〇一二两三四五六七八九十百千万]+$/.test(value))
        return Number.NaN;
    let total = 0;
    let section = 0;
    let number = 0;
    for (const char of value) {
        if (char in CHINESE_DIGITS) {
            number = CHINESE_DIGITS[char];
            continue;
        }
        const unit = CHINESE_UNITS[char];
        if (unit === undefined)
            return Number.NaN;
        if (unit === 10000) {
            section = (section + number) * unit;
            total += section;
            section = 0;
        }
        else {
            section += (number || 1) * unit;
        }
        number = 0;
    }
    return total + section + number;
}

/**
 * 纯函数：数字与中文数量词归一。
 * 三次 ↔ 3次；三十 ↔ 30；半小时 ↔ 30分钟；半天 ↔ 0.5天；一周 ↔ 7天。
 */
export function normalizeQuantities(text) {
    let value = normalizeWidth(text);
    value = value.replace(/半\s*个?\s*小时/g, '30分钟');
    value = value.replace(/半\s*个?\s*天/g, '0.5天');
    value = value.replace(/一\s*个?\s*星期/g, '7天');
    value = value.replace(/一\s*周/g, '7天');
    value = value.replace(/一\s*天/g, '1天');
    const unitPattern = QUANTITY_UNITS.sort((left, right) => right.length - left.length).join('|');
    value = value.replace(new RegExp(`([零〇一二两三四五六七八九十百千万]+)(?=\\s*(?:${unitPattern}))`, 'g'), (match) => {
        const number = chineseNumberToArabic(match);
        return Number.isFinite(number) ? String(number) : match;
    });
    value = value.replace(/([零〇一二两三四五六七八九十百千万]+)(?=$|[\s，。；、！？,.!?;:])/g, (match) => {
        const number = chineseNumberToArabic(match);
        return Number.isFinite(number) ? String(number) : match;
    });
    return value;
}

/** 去掉口语问句壳，保留问题里的事实词。 */
export function stripQuestionShells(text) {
    let value = normalizeWidth(text);
    for (const shell of QUESTION_SHELLS)
        value = value.split(shell).join(' ');
    return value.replace(/\s+/g, ' ').trim();
}

/** 所有汉字连续段。 */
function hanRuns(text) {
    return text.match(/[\u3400-\u4dbf\u4e00-\u9fff]+/g) ?? [];
}

/** 从归一化文本提取检索项：英文词、数字/单位、汉字二元词。 */
export function extractTerms(text) {
    const normalized = normalizeQuantities(stripQuestionShells(text)).toLowerCase();
    const terms = new Set();
    for (const word of normalized.match(/[a-z][a-z0-9_+#.-]*/g) ?? [])
        terms.add(word);
    for (const match of normalized.matchAll(/(\d+(?:\.\d+)?)\s*(次|天|周|月|年|小时|分钟|元|个|条|份|张|名|人|点|分|秒|岁|级|楼|号|页|遍|趟|台|件|项|家|位|只|本|辆|瓶|包|盒|箱|套|双|斤|克|公斤|米|公里|升|度|倍|成|折|期|届|班)?/g)) {
        terms.add(`n:${match[1]}`);
        if (match[2])
            terms.add(`u:${match[2]}`);
    }
    for (const run of hanRuns(normalized)) {
        for (let index = 0; index + 2 <= run.length; index += 1) {
            const bigram = run.slice(index, index + 2);
            if ([...bigram].some((char) => STOP_CHARS.has(char)))
                continue;
            terms.add(bigram);
        }
    }
    return [...terms];
}

/** 纯函数：按提问的主要字符区段判断语种。 */
export function detectLanguage(text) {
    const value = String(text ?? '');
    const counts = { 中文: 0, 日语: 0, 韩语: 0, 俄语: 0, 阿拉伯语: 0, 英语: 0 };
    for (const char of value) {
        const code = char.codePointAt(0) ?? 0;
        if (code >= 0x3040 && code <= 0x30ff)
            counts.日语 += 1;
        else if (code >= 0xac00 && code <= 0xd7af)
            counts.韩语 += 1;
        else if (code >= 0x4e00 && code <= 0x9fff)
            counts.中文 += 1;
        else if (code >= 0x0400 && code <= 0x04ff)
            counts.俄语 += 1;
        else if (code >= 0x0600 && code <= 0x06ff)
            counts.阿拉伯语 += 1;
        else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a))
            counts.英语 += 1;
    }
    if (counts.日语 > 0 && counts.日语 + counts.中文 > 0)
        return '日语';
    let best = '未知';
    let bestCount = 0;
    for (const [name, count] of Object.entries(counts)) {
        if (count > bestCount) {
            best = name;
            bestCount = count;
        }
    }
    return best;
}

/**
 * 把资料正文切成条款/句子单元：先按换行和句末标点，过长时再按分号、逗号打包。
 * 不按固定字数从命中位置硬切。
 */
export function splitClauses(content, maxUnitChars = 600) {
    const normalized = String(content ?? '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/[ \t]+/g, ' ')
        .trim();
    const sentences = normalized
        .split(/\n+|(?<=[。！？!?])/u)
        .map((value) => value.trim())
        .filter(Boolean);
    const clauses = [];
    for (const sentence of sentences) {
        if (sentence.length <= maxUnitChars) {
            clauses.push(sentence);
            continue;
        }
        let buffer = '';
        for (const piece of sentence.split(/(?<=[；;，,])/u)) {
            if (buffer && buffer.length + piece.length > maxUnitChars) {
                clauses.push(buffer.trim());
                buffer = '';
            }
            buffer += piece;
        }
        if (buffer.trim())
            clauses.push(buffer.trim());
    }
    return clauses.length ? clauses : [normalized];
}

/** 条款里出现的数字集合，用于“数字/日期对不上就当不同条款”。 */
export function numbersIn(text) {
    return new Set([...String(text ?? '').matchAll(/\d+(?:\.\d+)?/g)].map((match) => match[0]));
}

/** 从内容里挑与检索词最相关、且落在 maxChars 内的一段。 */
export function chooseSnippet(content, queryTerms, maxChars, weightOf = () => 1) {
    const limit = Math.max(40, Math.trunc(maxChars) || 320);
    const terms = [...new Set(queryTerms)];
    const clauses = splitClauses(content, Math.max(limit, 240));
    const info = clauses.map((clause, index) => {
        const searchable = normalizeQuantities(clause).toLowerCase();
        const clauseNumbers = numbersIn(searchable);
        const matched = [];
        let score = 0;
        for (const term of terms) {
            let hit = false;
            if (term.startsWith('n:'))
                hit = clauseNumbers.has(term.slice(2));
            else if (term.startsWith('u:'))
                hit = searchable.includes(term.slice(2));
            else
                hit = searchable.includes(term);
            if (hit) {
                matched.push(term);
                score += weightOf(term);
            }
        }
        return { clause, index, score, matched };
    });
    const bestSingle = info.reduce((left, right) => (right.score > left.score ? right : left), info[0] ?? { clause: '', index: 0, score: 0, matched: [] });
    if (!info.length)
        return '';
    // 表格题常常“列名在一行、M10 这一行在下面几行”；只取单条会拿到表头。
    // 在 maxChars 内找覆盖查询词最多的一段连续条款，同样覆盖时取更短的一段。
    if (bestSingle.clause.length <= limit) {
        let bestWindow = { start: bestSingle.index, end: bestSingle.index, weight: bestSingle.score, length: bestSingle.clause.length };
        for (let start = 0; start < info.length; start += 1) {
            let weight = 0;
            let length = 0;
            const covered = new Set();
            for (let end = start; end < info.length; end += 1) {
                const addLength = (end > start ? 1 : 0) + info[end].clause.length;
                if (length + addLength > limit)
                    break;
                length += addLength;
                for (const term of info[end].matched) {
                    if (!covered.has(term)) {
                        covered.add(term);
                        weight += weightOf(term);
                    }
                }
                if (weight > bestWindow.weight || (weight === bestWindow.weight && length < bestWindow.length))
                    bestWindow = { start, end, weight, length };
            }
        }
        // 同一节下用 1、2、3、 编号的相邻条款：只要相邻条款也命中了查询词，
        // 且总长不超过上限，就一起给模型。避免“迟到会有处罚吗”只拿到罚款那一条，
        // 漏掉“超过三十分钟未办临时请假按旷工半天”的另一条。
        const 编号 = (text) => /(?:^|\s)(?:\d+|[一二三四五六七八九十]+)[、.．]/.test(String(text).slice(0, 40));
        if (!terms.some((term) => term.startsWith('n:')) && 编号(info[bestWindow.end].clause)) {
            let start = bestWindow.start;
            let end = bestWindow.end;
            let length = info.slice(start, end + 1).reduce((sum, item, index) => sum + item.clause.length + (index ? 1 : 0), 0);
            let next = end + 1;
            while (next < info.length && 编号(info[next].clause) && info[next].matched.length
                && length + 1 + info[next].clause.length <= limit) {
                end = next;
                length += 1 + info[next].clause.length;
                next += 1;
            }
            let previous = start - 1;
            while (previous >= 0 && 编号(info[previous].clause) && info[previous].matched.length
                && length + 1 + info[previous].clause.length <= limit) {
                start = previous;
                length += 1 + info[previous].clause.length;
                previous -= 1;
            }
            return trimSnippet(info.slice(start, end + 1).map((item) => item.clause).join(' '));
        }
        return trimSnippet(info.slice(bestWindow.start, bestWindow.end + 1).map((item) => item.clause).join(' '));
    }
    // 条款本身仍超长：围绕最佳子句，按分号/逗号边界向外扩到上限。
    const best = bestSingle;
    const pieces = best.clause.split(/(?<=[；;，,])/u).map((value) => value.trim()).filter(Boolean);
    let pivot = pieces.findIndex((piece) => terms.some((term) => normalizeQuantities(piece).toLowerCase().includes(term.replace(/^[nu]:/, ''))));
    if (pivot < 0)
        pivot = 0;
    let start = pivot;
    let end = pivot + 1;
    let length = pieces[pivot].length;
    while (start > 0 && length + pieces[start - 1].length + 1 <= limit) {
        start -= 1;
        length += pieces[start].length + 1;
    }
    while (end < pieces.length && length + pieces[end].length + 1 <= limit) {
        length += pieces[end].length + 1;
        end += 1;
    }
    return trimSnippet(pieces.slice(start, end).join(' ').slice(0, limit));
}

function trimSnippet(value) {
    return String(value).replace(/\s+/g, ' ').trim();
}

/** 这句是不是“标准如下 / 见下表”这种引导句（真正内容在后面的表里）。 */
export function isTableLeadIn(snippet) {
    const text = String(snippet ?? '');
    return text.length <= 160 && /(如下|见下表|标准见下表)/.test(text);
}

/**
 * 从资料里找“职级 / 飞机 / 动车 / 火车 / 轮船 / 用车”这类表，按查询词挑最相关的一段。
 * 用于“引导句 + 表格”被切成两份时，把表补充成第二条 evidence。
 */
export function chooseTableSnippet(content, queryTerms, maxChars) {
    const normalized = String(content ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = normalized.split('\n');
    const labels = ['飞机', '动车', '火车', '轮船', '用车'];
    let start = -1;
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (labels.filter((label) => line.includes(label)).length >= 4) {
            start = index;
            break;
        }
    }
    if (start < 0)
        return '';
    const block = lines.slice(start, Math.min(lines.length, start + 16)).join(' ');
    return chooseSnippet(block, queryTerms, maxChars);
}

/** 判断回答里是否照抄了资料中连续 minRun 个字符（忽略空白）。 */
export function hasVerbatimCopy(answer, sources, minRun = 30) {
    const run = Math.max(10, Math.trunc(minRun) || 30);
    const normalizedAnswer = String(answer ?? '').replace(/\s+/g, '');
    if (normalizedAnswer.length < run)
        return false;
    const normalizedSources = (Array.isArray(sources) ? sources : [sources])
        .map((value) => String(value ?? '').replace(/\s+/g, ''))
        .filter(Boolean);
    for (const source of normalizedSources) {
        if (source.length < run)
            continue;
        for (let index = 0; index + run <= normalizedAnswer.length; index += 1) {
            if (source.includes(normalizedAnswer.slice(index, index + run)))
                return true;
        }
    }
    return false;
}

/** 命中阈值：由 lib/retrieval.test.js 里的正/负样本标定，见 README。 */
export const KNOWLEDGE_HIT_THRESHOLD = 1.4;

/** 供微信桥接等调用方复用同一条命中线，避免各自写死 0.5 这类旧阈值。 */
export function isKnowledgeHit(evidence) {
    return Number(evidence?.score ?? 0) >= KNOWLEDGE_HIT_THRESHOLD;
}

/**
 * 过于泛化的词不能单独构成命中：单靠“办法 / 规定 / 流程”撞到标题不算证据。
 * 发票、迟到、罚款这类领域词仍然可以单独命中。
 */
export const GENERIC_TERMS = new Set([
    '办法', '规定', '制度', '流程', '管理', '公司', '员工', '情况', '问题', '内容',
    '资料', '文件', '工作', '时间', '处理', '执行', '要求', '相关', '具体', '以上',
    '需要', '多久', '要多', '上班', '下班', '每天', '今天', '明天', '昨天', '时候',
    '现在', '可以', '可能', '一定', '一般', '进行', '使用', '通过', '方式', '方面',
    '部分', '一些', '事情', '东西', '多少', '怎样', '如何',
]);

/** 单字凑分保护：至少有一个长度 ≥ 2 的有效检索项命中，且不能只有泛化词。 */
export function hasStrongTermMatch(matchedTerms) {
    const terms = matchedTerms ?? [];
    const informative = terms.filter((term) => !term.startsWith('n:') && !term.startsWith('u:') && !GENERIC_TERMS.has(term));
    if (!informative.length)
        return false;
    return informative.some((term) => [...term].length >= 2);
}
