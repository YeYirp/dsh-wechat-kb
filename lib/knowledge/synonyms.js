/**
 * 本地同义词表（不联网、不调模型）。
 *
 * 只在第一次检索未命中时参与一次“扩展词再查”，仍然只走本地词法检索。
 * 每组内的词必须真的同义；不要把“迟到 / 早退”“罚款 / 旷工”这类不同后果的词放进同一组，
 * 否则会把一种情形套到另一种条款上。
 */
export const KNOWLEDGE_SYNONYM_GROUPS = [
    ['迟到', '晚到'],
    ['早退', '提前走', '提前离开'],
    ['罚款', '罚钱', '扣钱'],
    ['通报批评', '通报', '批评'],
    ['旷工', '缺勤', '没上班'],
    ['打卡', '签到', '考勤打卡'],
    ['口头警告', '警告'],
    ['请假', '休假', '请假手续'],
    ['发票', '票据', '收据'],
    ['留存', '保存', '保留', '存档'],
    ['保修', '质保', '维保'],
    ['退款', '退钱', '退货'],
];

/** 返回与原始检索词同义、但尚未出现在问题里的词。 */
export function expandBySynonyms(normalizedQuestion) {
    const added = new Set();
    for (const group of KNOWLEDGE_SYNONYM_GROUPS) {
        if (!group.some((word) => normalizedQuestion.includes(word)))
            continue;
        for (const word of group)
            added.add(word);
    }
    return [...added];
}
