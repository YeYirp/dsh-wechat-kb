/**
 * Schemastery 适配层。
 *
 * 正式运行时用 DSH 宿主提供的 @deepseek-ai/schemastery。插件的自测只在本机 Node 里跑，
 * 某些安装不会把宿主的 peer 依赖暴露到插件目录；这时退回到一个只覆盖本插件用到的
 * default / min / max / role / volatile / union / object 的最小实现，避免测试因为缺包而整组挂掉。
 */
let Schema;
try {
    Schema = (await import('@deepseek-ai/schemastery')).default;
}
catch {
    Schema = createFallbackSchema();
}
export default Schema;

function createFallbackSchema() {
    const node = (type) => {
        const field = {
            type,
            defaultValue: undefined,
            default(value) { field.defaultValue = value; return field; },
            volatile() { return field; },
            min() { return field; },
            max() { return field; },
            role() { return field; },
        };
        return field;
    };
    return {
        boolean: () => node('boolean'),
        string: () => node('string'),
        number: () => node('number'),
        union: () => node('union'),
        object(shape) {
            const build = (input = {}) => {
                const value = { ...input };
                for (const [key, field] of Object.entries(shape)) {
                    if (!(key in value) && field.defaultValue !== undefined)
                        value[key] = field.defaultValue;
                }
                return value;
            };
            build.meta = { kind: 'object' };
            return build;
        },
    };
}
