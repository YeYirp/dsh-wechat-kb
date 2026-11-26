import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { addLocalDocument, searchLocalKnowledge } from './local-store.js';
import { buildProjectKnowledgeReviewPrompt } from './prompt.js';
import { detectLanguage, extractTerms, hasStrongTermMatch, hasVerbatimCopy, KNOWLEDGE_HIT_THRESHOLD, normalizeQuantities } from './retrieval.js';
import { KnowledgeSettingsSchema } from './settings.js';

const 考勤规章 = '1、迟到或早退三十分钟以内、上下班忘打卡（经核实确按规定作息时间出勤）的，第一次口头警告；按月累计，自第二次开始，每次罚款30元；月累计三次以上的，除罚款外还通报批评。2、迟到或早退超过三十分钟，且未通过电话、短信等方式履行临时请假手续的，按旷工半天处理。';
const 发票规章 = '发票原件要留存三年，复印件需加盖财务专用章；丢失发票需在五个工作日内向财务部说明。';

async function withStore(action) {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-retrieval-'));
    const storePath = join(directory, 'knowledge.json');
    try {
        await addLocalDocument(storePath, '考勤管理办法', 考勤规章, '测试');
        await addLocalDocument(storePath, '发票管理规定', 发票规章, '测试');
        return await action(storePath);
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
}

test('数量词归一：三次/三十/半小时/半天/一周两侧一致', () => {
    assert.equal(normalizeQuantities('三次'), '3次');
    assert.equal(normalizeQuantities('三十'), '30');
    assert.equal(normalizeQuantities('三十元'), '30元');
    assert.equal(normalizeQuantities('半小时'), '30分钟');
    assert.equal(normalizeQuantities('半天'), '0.5天');
    assert.equal(normalizeQuantities('一天'), '1天');
    assert.equal(normalizeQuantities('一周'), '7天');
});

test('停用词与问句壳不参与打分，数字/单位成为检索项', () => {
    assert.deepEqual(extractTerms('这个办法怎么样'), ['办法']);
    const terms = extractTerms('这个月我迟到了三次，会怎么样');
    assert.ok(terms.includes('迟到'));
    assert.ok(terms.includes('n:3'));
    assert.ok(terms.includes('u:次'));
    assert.equal(extractTerms('这个月我迟到了三次，会怎么样').some((term) => term === '我迟' || term === '个这'), false);
});

test('只靠泛化词/数字不能构成命中，领域词可以', () => {
    assert.equal(hasStrongTermMatch(['办法']), false);
    assert.equal(hasStrongTermMatch(['n:3', 'u:次']), false);
    assert.equal(hasStrongTermMatch(['发票']), true);
    assert.equal(hasStrongTermMatch(['迟到']), true);
});

test('语种按字符区段判断', () => {
    assert.equal(detectLanguage('这个月迟到了三次'), '中文');
    assert.equal(detectLanguage('How many times was I late?'), '英语');
    assert.equal(detectLanguage('Сколько раз я опаздывал?'), '俄语');
    assert.equal(detectLanguage('كم مرة تأخرت؟'), '阿拉伯语');
    assert.equal(detectLanguage('이번 달에 세 번 지각했습니다'), '韩语');
    assert.equal(detectLanguage('今月は三回遅刻しました'), '日语');
});

test('长口语提问不会被长度归一压到阈值以下', async () => {
    await withStore(async (storePath) => {
        const short = await searchLocalKnowledge(storePath, '迟到三次会怎么样', 3);
        const verbose = await searchLocalKnowledge(storePath, '你好，我想问一下，这个月我迟到了三次，会怎么样呢？', 3);
        assert.equal(short[0]?.documentTitle, '考勤管理办法');
        assert.equal(verbose[0]?.documentTitle, '考勤管理办法');
        assert.ok(verbose[0].score >= KNOWLEDGE_HIT_THRESHOLD);
    });
});

test('验收：迟到三次排第一、证据短于上限、总字数低于旧基线 60%', async () => {
    await withStore(async (storePath) => {
        const settings = KnowledgeSettingsSchema({});
        const evidences = await searchLocalKnowledge(storePath, '这个月我迟到了三次，会怎么样', settings.evidenceCount, { evidenceCount: settings.evidenceCount, maxSnippetChars: settings.evidenceMaxChars });
        assert.equal(evidences[0]?.documentTitle, '考勤管理办法');
        assert.ok(evidences[0].snippet.length <= settings.evidenceMaxChars);
        const payloadChars = evidences.map((item) => `${item.documentTitle}\n${item.snippet}`).join('\n').length;
        // 旧实现在同一份固定资料上返回“考勤 135 字 + 发票 29 字”，证据文本共 179 字。
        const 旧基线 = 179;
        assert.ok(payloadChars <= 旧基线 * 0.6, `证据 ${payloadChars} 字，应 ≤ ${旧基线 * 0.6}`);
        assert.ok(evidences[0].snippet.includes('罚款30元'));
    });
});

test('验收：微信出站不得照抄原文，推导结果可以过守卫', async () => {
    await withStore(async (storePath) => {
        const evidences = await searchLocalKnowledge(storePath, '这个月我迟到了三次，会怎么样', 3);
        const sources = evidences.map((item) => item.snippet);
        const 原文 = evidences[0].snippet;
        const 推导答案 = '本月迟到三次：第二次、第三次各罚款30元，共60元；月累计三次以上还要通报批评。';
        assert.equal(hasVerbatimCopy(原文, sources, 30), true);
        assert.equal(hasVerbatimCopy(推导答案, sources, 30), false);
        assert.match(推导答案, /60元/);
        assert.match(推导答案, /通报批评/);
    });
});

test('验收：无关提问必须未命中并只走拒答出口', async () => {
    await withStore(async (storePath) => {
        assert.deepEqual(await searchLocalKnowledge(storePath, '今天天气怎么样', 3), []);
        assert.deepEqual(await searchLocalKnowledge(storePath, '这个办法怎么样', 3), []);
        // 反向对照：同一套阈值不能把真正的问题也拦掉。
        assert.equal((await searchLocalKnowledge(storePath, '发票原件要留存多久', 3))[0]?.documentTitle, '发票管理规定');
    });
});

test('表格题会把 M10 所在行补进证据，支持部分回答', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-table-'));
    const storePath = join(directory, 'knowledge.json');
    try {
        await addLocalDocument(storePath, '差旅管理办法', '第十一条 依据职级，出差人员享有不同的差旅费标准，职级分类如下：\n城市交通各层级标准见下表：\n飞机 动车/高铁 火车 轮船 用车\nM5 普通 一等座 一等软席 二等舱 经济型、舒适型\nM6-M8 普通 一等座 一等软席 二等舱 经济型、舒适型\nM9 普通 二等座 二等软席 三等舱 经济型\nM10 及以下 / 二等座 硬席（硬座、硬卧） 三等舱 经济型', '测试');
        const evidences = await searchLocalKnowledge(storePath, 'M10以下职级去美国出差的交通费标准是？', 3);
        assert.ok(evidences.some((item) => item.snippet.includes('M10 及以下') && item.snippet.includes('二等座')));
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('命中带图资料时证据会带回图片元数据，图片不参与打分', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-images-'));
    const storePath = join(directory, 'knowledge.json');
    try {
        await addLocalDocument(storePath, '打标机说明', '便携式打标机重量 6.4KG，支持锂电池。', '测试', [
            { path: 'a.jpg', mediaType: 'image/jpeg', page: 1 },
            { path: 'b.jpg', mediaType: 'image/png' },
        ]);
        const evidences = await searchLocalKnowledge(storePath, '打标机重量是多少', 3);
        assert.equal(evidences[0]?.documentTitle, '打标机说明');
        assert.equal(evidences[0]?.images?.length, 2);
        assert.equal(evidences[0]?.images?.[0]?.path, 'a.jpg');
        const textOnly = await searchLocalKnowledge(storePath, '便携式打标机', 3);
        assert.equal(textOnly[0]?.images?.length, 2);
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('提示词包含“读规定推结论”和语种镜像语义', () => {
    const prompt = buildProjectKnowledgeReviewPrompt({ projectName: '测试知识库', answerPolicy: 'strict', ocrEnabled: false, asrEnabled: false });
    assert.match(prompt, /计数与换算/);
    assert.match(prompt, /先给结论/);
    assert.match(prompt, /回答按问题本身来/);
    assert.match(prompt, /只挑和问题直接相关的说/);
    assert.match(prompt, /超过 20 个字/);
    assert.match(prompt, /不要写“依据：”/);
    assert.match(prompt, /能按资料算出总数/);
    assert.match(prompt, /只能回答一部分时/);
    assert.match(prompt, /完全没有 evidence 才拒答/);
    assert.match(prompt, /answerLanguage/);
    assert.match(prompt, /不要说明你查了哪些文件/);
});
