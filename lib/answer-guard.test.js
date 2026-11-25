import assert from 'node:assert/strict';
import test from 'node:test';
import { __test出站清理 } from './host.js';

const 规章 = '第一次口头警告；按月累计，自第二次开始，每次罚款30元；月累计三次以上的，除罚款外还通报批评。';
const 兜底 = '对不起，没有在知识库中找到相关的内容。';

test('微信出站保留推导结论，不夹带来源/文件/操作说明', () => {
    const 答案 = '本月迟到三次：第二次、第三次各罚款30元，共60元；月累计三次以上还要通报批评。';
    const 出站 = __test出站清理(答案, [规章]);
    assert.equal(出站, 答案);
    const 带来源 = '根据资料《考勤管理办法》，我查了知识库，本月迟到三次：第二次、第三次各罚款30元，共60元。';
    const 清理后 = __test出站清理(带来源, [规章]);
    assert.doesNotMatch(清理后, /根据资料|考勤管理办法|查了知识库/);
    assert.match(清理后, /60元/);
});

test('微信出站不要“依据：”小标题或单独的计算过程', () => {
    const 带依据 = '本月迟到三次：第二次、第三次各罚款30元，共60元；月累计三次以上还要通报批评。\n依据：迟到三十分钟以内，自第二次起每次罚30元；月累计三次以上通报批评。';
    const 清理后 = __test出站清理(带依据, [规章]);
    assert.doesNotMatch(清理后, /依据|计算过程/);
    assert.match(清理后, /60元/);
    assert.match(清理后, /通报批评/);
});

test('微信出站照抄资料连续 30 字以上时只回固定道歉句', () => {
    const 抄原文 = `本月迟到三次。${规章}以上是规定。`;
    assert.equal(__test出站清理(抄原文, [规章]), 兜底);
});

test('微信出站清掉图片语法、占位符、路径和 base64', () => {
    const 混图 = '本月迟到三次，第二次、第三次各罚30元，共60元。![]("C:\\tmp\\a.png") [图片] data:image/png;base64,AAAA C:\\tmp\\b.jpg';
    const 清理后 = __test出站清理(混图, [规章]);
    assert.doesNotMatch(清理后, /!\[|\[图片\]|base64|\.png|\.jpg/i);
    assert.match(清理后, /60元/);
});

test('微信出站空内容或只剩占位时回固定道歉句', () => {
    assert.equal(__test出站清理('（无回复）', [规章]), 兜底);
    assert.equal(__test出站清理('', [规章]), 兜底);
    assert.equal(__test出站清理('@某人', [规章]), 兜底);
});
