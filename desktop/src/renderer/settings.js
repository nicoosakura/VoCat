'use strict';

// VoCat 桌面控制端 · 设置窗口渲染脚本
// 仅通过 window.vocat 桥接访问主进程能力；本页不持任何明文凭证。

const api = window.vocat;

const el = (id) => document.getElementById(id);
const show = (id) => el(id).classList.remove('hidden');
const hide = (id) => el(id).classList.add('hidden');

let hosts = [];
let editingId = null;
let pendingAsset = null; // 检查更新命中后的安装包资源
let unsubscribeProgress = null;

async function boot() {
  const settings = await api.loadSettings();
  hosts = settings.hosts || [];

  el('c-auth').checked = !!settings.autoLaunch;
  el('c-tray').checked = settings.closeToTray !== false;
  el('c-notify').checked = settings.notificationsEnabled !== false;
  el('notify-note').textContent =
    '新短信与设备掉线事件实时推送到系统通知；点击通知直接跳到短信或设备页。';
  el('ver').textContent = `v${settings.version || '?'}`;

  if (settings.credentialStorageUsable === false) {
    show('cred-warning');
    el('cred-warning').textContent =
      '系统钥匙串不可用：凭证将以弱加密保存，请谨慎保管本机账户。';
  }
  el('platform-note').textContent =
    `当前平台：${settings.platform}。Linux 专属能力（DJI QMI 绑定修复、udev、uenvent 热插拔）在本平台不可用。`;

  renderList();
}

function renderList() {
  const list = el('host-list');
  list.textContent = '';
  for (const host of hosts) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot';

    const info = document.createElement('span');
    info.className = 'grow';
    info.innerHTML = '';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = host.name || host.address;
    const addr = document.createElement('div');
    addr.className = 'addr';
    addr.textContent =
      host.mode === 'local' ? `本地一体 · 127.0.0.1:${host.port}` : `${host.protocol}://${host.address}:${host.port}`;
    info.append(name, addr);

    const modeTag = document.createElement('span');
    modeTag.className = 'mode-tag';
    modeTag.textContent = host.mode === 'local' ? '本地' : '远程';

    const editButton = document.createElement('button');
    editButton.textContent = '编辑';
    editButton.addEventListener('click', () => openEditor(host.id));

    const defaultButton = document.createElement('button');
    defaultButton.textContent = '设默认';
    defaultButton.className = 'ghost';
    defaultButton.addEventListener('click', async () => {
      await api.setDefaultHost(host.id);
      await refresh();
    });

    li.append(dot, info, modeTag, editButton, defaultButton);
    list.append(li);
    void probeSoon(host, dot);
  }
  hide('empty-hint');
  if (hosts.length === 0) show('empty-hint');
}

async function probeSoon(host, dot) {
  if (host.mode !== 'remote') return; // 本地一体由服务探活，列表不重复探测
  const result = await api.probeHost(host).catch(() => ({ ok: false }));
  dot.className = result.ok ? 'dot ok' : 'dot bad';
}

function openEditor(hostId) {
  editingId = hostId || null;
  const host = hosts.find((item) => item.id === hostId) || {};
  el('editor-title').textContent = hostId ? '编辑主机' : '添加主机';
  el('f-name').value = host.name || '';
  el('f-mode').value = host.mode || 'remote';
  el('f-protocol').value = host.protocol || 'http';
  el('f-address').value = host.address || '';
  el('f-port').value = host.port || 7575;
  el('f-credential').value = '';
  el('cred-hint').textContent = host.hasCredential ? '已保存凭证（输入新值可覆盖）' : '凭证密文保存于系统钥匙串';
  hide('verify-result');
  hide('btn-delete-host');
  if (hostId) show('btn-delete-host');
  toggleRemoteFields(host.mode === 'local');
  show('editor');
  el('f-name').focus();
}

function toggleRemoteFields(isLocal) {
  if (isLocal) hide('remote-fields');
  else show('remote-fields');
}

el('btn-add').addEventListener('click', () => openEditor(null));
el('btn-cancel').addEventListener('click', () => {
  editingId = null;
  hide('editor');
});
el('f-mode').addEventListener('change', (event) => toggleRemoteFields(event.target.value === 'local'));

el('btn-verify').addEventListener('click', async () => {
  const host = readForm();
  if (!host.address && host.mode !== 'local') return;
  el('verify-result').textContent = '测试中…';
  const result = await api.probeHost(host).catch(() => ({ ok: false, error: '无响应' }));
  el('verify-result').textContent = result.ok ? '连接成功' : `无法连接：${result.error || '未知原因'}`;
});

el('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const host = readForm();
  const result = await api.saveHost(host);
  if (result.ok) {
    editingId = null;
    hide('editor');
    await refresh();
  }
});

el('btn-delete-host').addEventListener('click', async () => {
  if (!editingId) return;
  if (!window.confirm('删除该主机？此操作不可撤销。')) return;
  await api.deleteHost(editingId);
  editingId = null;
  hide('editor');
  await refresh();
});

el('c-auth').addEventListener('change', (event) => {
  void api.setAutoLaunch(event.target.checked);
});
el('c-tray').addEventListener('change', (event) => {
  void api.setCloseToTray(event.target.checked);
});
el('c-notify').addEventListener('change', (event) => {
  void api.setNotificationsEnabled(event.target.checked);
});

function readForm() {
  const host = {
    name: el('f-name').value.trim(),
    mode: el('f-mode').value,
    protocol: el('f-protocol').value,
    address: el('f-address').value.trim(),
    port: Number.parseInt(el('f-port').value, 10) || 7575,
    credential: el('f-credential').value || undefined,
  };
  if (editingId) host.id = editingId;
  return host;
}

// ---------------------------------------------------------------------------
// 更新（PRD D8）：检查 GitHub Releases → 下载并打开安装包。
// ---------------------------------------------------------------------------
function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

el('btn-check-update').addEventListener('click', async () => {
  pendingAsset = null;
  hide('update-actions');
  el('update-result').textContent = '正在检查更新…';
  el('btn-check-update').disabled = true;
  try {
    const result = await api.checkUpdate();
    if (!result.ok) {
      el('update-result').textContent = result.error || '检查更新失败';
      return;
    }
    if (!result.updateAvailable) {
      el('update-result').textContent = '已是最新版本';
      return;
    }
    el('update-result').textContent = `发现新版本 v${result.version}${result.notes ? `：${result.notes}` : ''}`;
    if (result.assetAvailable && result.asset) {
      pendingAsset = result.asset;
      show('update-actions');
    } else if (result.releaseUrl) {
      el('update-actions').innerHTML = '';
      // 当前平台无安装包：引导用户从 Release 页面手动下载。
      const link = document.createElement('button');
      link.className = 'primary';
      link.textContent = '前往 Release 页面下载';
      link.addEventListener('click', () => openExternal(result.releaseUrl));
      el('update-actions').append(link);
      show('update-actions');
    }
  } finally {
    el('btn-check-update').disabled = false;
  }
});

// 设置窗口是本地页面，主进程已把外部链接一律交系统浏览器。
function openExternal(url) {
  window.open(url, '_blank');
}

el('btn-download-update').addEventListener('click', async () => {
  if (!pendingAsset) return;
  el('btn-download-update').disabled = true;
  el('update-progress').textContent = '准备下载…';
  if (unsubscribeProgress) {
    unsubscribeProgress();
    unsubscribeProgress = null;
  }
  unsubscribeProgress = api.onUpdateProgress((progress) => {
    if (progress.phase === 'downloading') {
      const pct = progress.total > 0 ? `（${Math.round((progress.received / progress.total) * 100)}%）` : '';
      el('update-progress').textContent = `下载中 ${formatBytes(progress.received)}${pct}`;
    } else if (progress.phase === 'done') {
      el('update-progress').textContent = '下载完成，即将打开安装程序';
    } else if (progress.phase === 'failed') {
      el('update-progress').textContent = `下载失败：${progress.error || ''}`;
      el('btn-download-update').disabled = false;
    }
  });
  const result = await api.downloadUpdate(pendingAsset);
  if (!result.ok && unsubscribeProgress) {
    el('update-progress').textContent = `下载失败：${result.error || ''}`;
    el('btn-download-update').disabled = false;
  }
});

async function refresh() {
  const settings = await api.loadSettings();
  hosts = settings.hosts || [];
  renderList();
}

boot();