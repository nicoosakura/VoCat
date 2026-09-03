'use strict';

// 通知桥接纯逻辑测试：事件呈现、去重、Set-Cookie 解析、游标推进。
// 运行：npm test（node --test test/）

const test = require('node:test');
const assert = require('node:assert');

const {
  NotificationBridge,
  eventPresentation,
  dedupKey,
  truncate,
  parseSetCookie,
} = require('../src/notify-bridge');

test('eventPresentation 分类映射', () => {
  const sms = eventPresentation('sms.received', {
    device_label: 'EC20',
    number: '10086',
    content: '您的验证码是 123456',
  });
  assert.ok(sms.title.includes('EC20'), 'sms title 应含设备名');
  assert.ok(sms.body.includes('10086') && sms.body.includes('123456'), 'sms body 应含号码与内容');
  assert.strictEqual(sms.route, '/sms');

  const offline = eventPresentation('device.offline', { device_label: '阳台模块' });
  assert.ok(offline.title.includes('阳台模块'));
  assert.strictEqual(offline.route, '/devices');

  const online = eventPresentation('device.online', {});
  assert.strictEqual(online.route, '/devices');

  assert.strictEqual(eventPresentation('unknown.kind', {}), null);
});

test('eventPresentation 短信长内容截断', () => {
  const longContent = 'x'.repeat(300);
  const sms = eventPresentation('sms.received', { number: '10086', content: longContent });
  assert.ok(sms.body.length <= 121, `body 应被截断，实际 ${sms.body.length}`);
  assert.ok(sms.body.endsWith('…'), '截断应带省略号');
});

test('truncate 边界', () => {
  assert.strictEqual(truncate('hello', 10), 'hello');
  assert.strictEqual(truncate('hello world', 5), 'hell…');
});

test('dedupKey 对同键同载荷稳定', () => {
  const payload = { device_label: 'EC20', number: '10086' };
  assert.strictEqual(dedupKey('sms.received', payload), dedupKey('sms.received', payload));
  assert.notStrictEqual(dedupKey('sms.received', payload), dedupKey('device.offline', payload));
});

test('parseSetCookie 解析 HttpOnly 与普通 cookie', () => {
  const sessionCookie = parseSetCookie('vocat_session=token-abc; HttpOnly; Path=/');
  assert.deepStrictEqual(sessionCookie, { name: 'vocat_session', value: 'token-abc', httpOnly: true });

  const csrfCookie = parseSetCookie('vocat_csrf=csrf-xyz; Path=/');
  assert.strictEqual(csrfCookie.name, 'vocat_csrf');
  assert.strictEqual(csrfCookie.value, 'csrf-xyz');
  assert.strictEqual(csrfCookie.httpOnly, false);

  assert.strictEqual(parseSetCookie('malformed'), null);
  assert.strictEqual(parseSetCookie(''), null);
});

test('bridge.consume 推进游标、去重窗口与开关', () => {
  const notified = [];
  const bridge = new NotificationBridge({
    notify: (title, body, route) => notified.push({ title, body, route }),
    focusAndNavigate: () => {},
  });
  bridge.enabled = true;

  const baseUrl = 'http://127.0.0.1:21000';
  bridge.consume(baseUrl, {
    events: [
      { seq: 1, kind: 'sms.received', payload: { device_label: 'EC20', number: '10086', content: '验证码 5678' } },
      { seq: 2, kind: 'device.offline', payload: { device_label: 'EC20' } },
    ],
    latest: 2,
  });
  assert.strictEqual(notified.length, 2, '两条新事件都应通知');
  assert.strictEqual(bridge.since.get(baseUrl), 2);

  // 同键事件在 5s 去重窗口内重复出现 → 不重复通知。
  bridge.consume(baseUrl, {
    events: [
      { seq: 3, kind: 'sms.received', payload: { device_label: 'EC20', number: '10086', content: '验证码 5678' } },
    ],
    latest: 3,
  });
  assert.strictEqual(notified.length, 2, '去重窗口内同键事件应被抑制');

  // 关闭通知开关：游标继续推进但不再弹通知。
  bridge.enabled = false;
  bridge.consume(baseUrl, {
    events: [{ seq: 4, kind: 'device.online', payload: { device_label: 'EC20' } }],
    latest: 4,
  });
  assert.strictEqual(notified.length, 2, '开关关闭时不应弹通知');
  assert.strictEqual(bridge.since.get(baseUrl), 4);

  // 未知事件类型不弹通知，但游标仍推进。
  bridge.enabled = true;
  bridge.consume(baseUrl, {
    events: [{ seq: 5, kind: 'custom.event', payload: {} }],
    latest: 5,
  });
  assert.strictEqual(notified.length, 2);
  assert.strictEqual(bridge.since.get(baseUrl), 5);
});

test('bridge.start 本地与远程间隔内存', () => {
  const bridge = new NotificationBridge({ notify: () => {}, focusAndNavigate: () => {} });
  // 单测环境无 electron；屏蔽真实轮询请求。
  bridge.pollOnce = () => {};
  bridge.start({ baseUrl: 'http://192.168.1.100:7575', local: false }, true);
  assert.strictEqual(bridge.active.pollMs, 15000, '远程模式间隔应为 15s');
  bridge.stop();

  bridge.start({ baseUrl: 'http://127.0.0.1:20000', local: true }, true);
  assert.strictEqual(bridge.active.pollMs, 5000, '本地模式间隔应为 5s');
  bridge.stop();
});