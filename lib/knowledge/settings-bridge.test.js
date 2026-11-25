import assert from 'node:assert/strict';
import test from 'node:test';
import { isTrustedLocalRequest } from './settings-bridge.js';
/** 构造最小请求对象；只校验“本机回环 + 非跨站”这两道边界。 */
function request(method, origin, host = '127.0.0.1:3080', fetchSite, remoteAddress = '127.0.0.1') {
    return {
        method,
        headers: { ...(origin ? { origin } : {}), host, ...(fetchSite ? { 'sec-fetch-site': fetchSite } : {}) },
        socket: { remoteAddress },
    };
}
test('写接口只允许本机回环地址且拒绝跨站请求', () => {
    assert.equal(isTrustedLocalRequest(request('POST', 'http://127.0.0.1:3080')), true);
    assert.equal(isTrustedLocalRequest(request('POST', undefined)), true);
    assert.equal(isTrustedLocalRequest(request('POST', 'http://localhost:3080')), true);
    assert.equal(isTrustedLocalRequest(request('POST', 'http://127.0.0.1:3080', '127.0.0.1:3080', 'cross-site')), false);
    assert.equal(isTrustedLocalRequest(request('POST', 'http://127.0.0.1:3080', '127.0.0.1:3080', undefined, '10.0.0.5')), false);
});
test('无 Origin 的本机只读诊断仍可查询状态', () => {
    assert.equal(isTrustedLocalRequest(request('GET', undefined)), true);
    assert.equal(isTrustedLocalRequest(request('HEAD', undefined)), true);
});
