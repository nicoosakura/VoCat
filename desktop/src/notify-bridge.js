'use strict';

// VoCat 桌面端 · 通知桥接（PRD D6）
//
// 主进程以短轮询方式消费服务端 /api/events/poll 事件流，将
// sms.received / device.offline / device.online / 本地服务状态 分类后
// 转为系统通知（macOS Notification Center / Windows Toast）。
//
// 认证策略（本地一体 vs 远程）：
//   - 本地一体：主进程用一次性随机口令换取的会话 cookie 注入默认 session，
//     渲染进程打开页面即已登录，轮询请求经 net.request + useSessionCookies
//     自动携带同一 cookie，主进程不保存任何令牌明文。
//   - 远程：渲染进程负责 Web 登录，主进程轮询请求共享默认 session 的
//     cookie（useSessionCookies），登录后自动开始推送，401 时降频静默。
//
// 行为约束：
//   - 新事件 5s 去重窗口，同键事件只弹一次；
//   - 应用退出（非最小化到托盘）后桥停止，不产生任何通知；
//   - 单主机离线事件只弹一次，不构成通知风暴；
//   - 通知开关（settings.notificationsEnabled）关闭时继续消费游标但不弹窗，
//     重新开启后不会突然补发历史通知。
//
// electron 模块在实例方法内按需加载，纯函数与事件呈现逻辑可被无 Electron
// 环境的单测直接引用。

const EVENTS_PATH = '/api/events/poll';

const REMOTE_POLL_MS = 15 * 1000; // PRD D6: 远程模式 15s 降频
const LOCAL_POLL_MS = 5 * 1000;
const UNAUTH_RETRY_MS = 30 * 1000; // 未登录时降频探测，登录后自动恢复
const DEDUP_WINDOW_MS = 5 * 1000;
const REQUEST_TIMEOUT_MS = 8 * 1000;

// 事件类型 → 系统通知内容与点击路由。
function eventPresentation(kind, payload) {
  const label = String(payload.device_label || '');
  switch (kind) {
    case 'sms.received': {
      const number = String(payload.number || '');
      const content = String(payload.content || '').replace(/\s+/g, ' ').trim();
      const body = content ? `${number}: ${content}` : `来自 ${number}`;
      return { title: label ? `新短信 · ${label}` : '收到新短信', body: truncate(body, 120), route: '/sms' };
    }
    case 'device.offline':
      return { title: label ? `设备掉线 · ${label}` : '设备掉线', body: '设备已失去连接，请检查 USB 与网络', route: '/devices' };
    case 'device.online':
      return { title: label ? `设备上线 · ${label}` : '设备上线', body: '设备已恢复连接', route: '/devices' };
    default:
      return null;
  }
}

function truncate(value, max) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function dedupKey(kind, payload) {
  return `${kind}:${JSON.stringify(payload)}`;
}

class NotificationBridge {
  constructor({ notify, focusAndNavigate }) {
    this.notify = notify;               // (title, body, route) => void
    this.focusAndNavigate = focusAndNavigate;
    this.timer = null;
    this.active = null;                 // { key, baseUrl, pollMs }
    this.since = new Map();             // baseUrl -> 已消费事件序号
    this.lastDedup = new Map();         // 去重键 -> 最近通知时间
    this.backoffUntil = new Map();      // baseUrl -> 401 降频截止时间
  }

  // start 在选定的目标主机上工作；enabled=false 只推进游标不弹通知。
  start(target, enabled) {
    const key = target.baseUrl;
    const pollMs = target.local ? LOCAL_POLL_MS : REMOTE_POLL_MS;
    if (this.active && this.active.key === key && this.active.pollMs === pollMs) {
      this.setNotificationsEnabled(enabled);
      return;
    }
    this.stop();
    this.active = { key, baseUrl: key, pollMs };
    this.enabled = enabled !== false;
    if (!this.since.has(key)) this.since.set(key, 0);
    this.timer = setInterval(() => this.pollOnce(), pollMs);
    // 立即进行第一次轮询，避免首条短信延迟一个周期。轮询失败不回抛，
    // 后续周期会按退避策略重试。
    try {
      this.pollOnce();
    } catch (err) {
      console.warn('[vocat-desktop] 通知桥首次轮询失败:', err.message);
    }
  }

  setNotificationsEnabled(enabled) {
    this.enabled = enabled !== false;
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.active = null;
  }

  isActiveFor(baseUrl) {
    return Boolean(this.active && this.active.key === baseUrl);
  }

  pollOnce() {
    const { net } = require('electron');
    const target = this.active;
    if (!target) return;
    const baseUrl = target.baseUrl;
    // 未登录降频期：到点前跳过本轮。
    if (this.backoffUntil.has(baseUrl) && Date.now() < this.backoffUntil.get(baseUrl)) {
      return;
    }
    const since = this.since.get(baseUrl) || 0;
    const url = `${baseUrl}${EVENTS_PATH}?since=${since}`;
    const request = net.request({ url, useSessionCookies: true, timeout: REQUEST_TIMEOUT_MS });
    request.setHeader('Accept', 'application/json');
    request.on('response', (response) => {
      response.on('error', () => this.reschedulePoll());
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        if (response.statusCode === 401) {
          // 未登录（远程模式用户尚未完成 Web 登录）：降频探测。
          this.backoffUntil.set(baseUrl, Date.now() + UNAUTH_RETRY_MS);
          return;
        }
        if (response.statusCode >= 200 && response.statusCode < 300) {
          this.backoffUntil.delete(baseUrl);
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            this.consume(baseUrl, body && body.data);
          } catch (err) {
            console.error('[vocat-desktop] 事件轮询响应解析失败:', err.message);
          }
          return;
        }
        // 主机离线或其它 5xx：短暂退避，避免旋转风暴。
        this.backoffUntil.set(baseUrl, Date.now() + REMOTE_POLL_MS);
      });
    });
    request.on('error', () => {
      this.backoffUntil.set(baseUrl, Date.now() + REMOTE_POLL_MS);
    });
    request.end();
  }

  consume(baseUrl, data) {
    if (!data || !Array.isArray(data.events)) return;
    const latest = Number.isFinite(Number(data.latest)) ? Number(data.latest) : 0;
    for (const event of data.events) {
      const seq = Number(event.seq);
      const kind = String(event.kind || '');
      const payload = (event.payload && typeof event.payload === 'object') ? event.payload : {};
      if (Number.isFinite(seq) && seq > (this.since.get(baseUrl) || 0)) {
        this.since.set(baseUrl, seq);
      }
      if (!this.enabled) continue;
      const presentation = eventPresentation(kind, payload);
      if (!presentation) continue;
      const now = Date.now();
      const key = dedupKey(kind, payload);
      if (now - (this.lastDedup.get(key) || 0) < DEDUP_WINDOW_MS) continue;
      this.lastDedup.set(key, now);
      this.notify(presentation.title, presentation.body, presentation.route);
    }
    if (latest > (this.since.get(baseUrl) || 0)) {
      this.since.set(baseUrl, latest);
    }
  }

  // 本地一体模式：把一次性口令换取的会话 cookie 注入默认 session，
  // 渲染进程打开页面即为已登录，同时轮询请求共享该 cookie。
  injectLocalSessionLocally(baseUrl, secret) {
    const { net, session } = require('electron');
    const request = net.request({
      url: `${baseUrl}/api/auth/local-issue`,
      method: 'POST',
      useSessionCookies: true,
      timeout: REQUEST_TIMEOUT_MS,
    });
    request.setHeader('Content-Type', 'application/json');
    request.setHeader('Accept', 'application/json');
    request.on('response', (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        if (response.statusCode !== 200) {
          console.error('[vocat-desktop] 本地免密会话换取失败:', response.statusCode);
          return;
        }
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (err) {
          console.error('[vocat-desktop] 本地免密会话响应解析失败:', err.message);
          return;
        }
        const expiresAt = new Date(String((body && body.data && body.data.expires_at) || '')).getTime() / 1000;
        // 会话与 CSRF 令牌由服务端经 Set-Cookie 下发；逐个解析并注入默认
        // session，使渲染进程与轮询请求共享同一登录态。
        const setCookies = response.headers['set-cookie'] || [];
        for (const cookieLine of Array.isArray(setCookies) ? setCookies : [setCookies]) {
          const parsed = parseSetCookie(cookieLine);
          if (!parsed) continue;
          session.defaultSession.cookies
            .set({
              url: `${baseUrl}/`,
              name: parsed.name,
              value: parsed.value,
              httpOnly: parsed.httpOnly,
              secure: false,
              sameSite: 'strict',
              path: '/',
              ...(Number.isFinite(expiresAt) && expiresAt > 0 ? { expirationDate: expiresAt } : {}),
            })
            .catch((err) => {
              console.error(`[vocat-desktop] cookie 写入失败 ${parsed.name}:`, err.message);
            });
        }
      });
    });
    request.on('error', (err) => {
      console.error('[vocat-desktop] 本地免密会话请求失败:', err.message);
    });
    request.end(JSON.stringify({ secret }));
  }

  clearCursorFor(baseUrl) {
    this.since.delete(baseUrl);
    this.backoffUntil.delete(baseUrl);
  }
}

// 解析单个 Set-Cookie 行：取 name=value，并识别 HttpOnly 属性。
function parseSetCookie(line) {
  const parts = String(line).split(';');
  const first = parts.shift();
  if (!first) return null;
  const separator = first.indexOf('=');
  if (separator <= 0) return null;
  const name = first.slice(0, separator).trim();
  if (!name) return null;
  const value = first.slice(separator + 1).trim();
  const attributes = new Set(parts.map((part) => part.trim().toLowerCase().split('=')[0]));
  return { name, value, httpOnly: attributes.has('httponly') };
}

module.exports = { NotificationBridge, eventPresentation, dedupKey, truncate, parseSetCookie };