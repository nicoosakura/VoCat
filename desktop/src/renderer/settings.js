'use strict';

// VoCat 桌面控制端 · 设置窗口渲染脚本
// 仅通过 window.vocat 桥接访问主进程能力；本页不持任何明文凭证。

const api = window.vocat;

const el = (id) => document.getElementById(id);
const show = (id) => el(id).classList.remove('hidden');
const hide = (id) => el(id).classList.add('hidden');

let hosts = [];
let editingId = null;

async function boot() {
  const settings = await api.loadSettings();
  hosts = settings.hosts || [];

  el('c-auth').checked = !!settings.autoLaunch;
  el('c-tray').checked = settings.closeToTray !== false;

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

async function refresh() {
  const settings = await api.loadSettings();
  hosts = settings.hosts || [];
  renderList();
}

boot();