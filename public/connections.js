const $ = selector => document.querySelector(selector);
const labels = { offline: '未连接', loading: '获取二维码', waiting: '等待扫码', scanned: '等待确认', verifying: '待输入配对码',
  connecting: '连接中', connected: '已连接', reconnecting: '正在重连', paused: '已暂停', expired: '登录已失效', error: '连接异常' };
let profiles = [], filter = 'all', healthy = false, refreshing = false, revision = 0, cardStamp = '', toastTimer;
let selectedId = null, detailState = null, detailStream = null, editId = null, disconnectId = null, nameBusy = false;
const busy = new Set();
const needsAttention = p => !['connected', 'paused'].includes(p.phase);
const date = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
function url(path, id) {
  return id ? `${path}?profile=${encodeURIComponent(id)}` : path;
}
async function request(path, id, body, post = false) {
  const response = await fetch(url(path, id), { method: post ? 'POST' : 'GET', signal: AbortSignal.timeout(22000),
    ...(post ? { headers: { 'X-Clawbot-Local': '1', 'Content-Type': 'application/json' }, body: body === undefined ? '' : JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '操作失败，请重试');
  return data;
}
function toast(text) {
  $('#toast').textContent = text; $('#toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 3500);
}
function adopt(data) {
  if (data.profiles) { profiles = data.profiles; revision++; }
  render();
}
function action(text, className, p, handler, key) {
  const button = element('button', className, text);
  button.disabled = busy.has(p.id) || !healthy;
  button.dataset.action = `${p.id}:${key}`;
  button.addEventListener('click', handler);
  return button;
}
function card(p) {
  const card = element('article', 'connection-card'); card.dataset.profile = p.id;
  const heading = element('div', 'card-heading');
  heading.append(element('div', 'avatar', p.name.trim().slice(0, 1)));
  const title = element('div', 'card-title');
  title.append(element('h3', '', p.name));
  const badge = element('span', 'badge', labels[p.phase] || p.phase); badge.dataset.phase = p.phase;
  title.append(badge); heading.append(title);
  const rename = action('重命名', 'rename-button', p, () => editName(p), 'rename');
  rename.setAttribute('aria-label', `重命名 ${p.name}`); heading.append(rename); card.append(heading);
  const account = element('p', 'account-id', p.account?.userId || '尚未绑定微信账号');
  account.title = account.textContent; card.append(account);
  card.append(element('p', 'card-detail', p.detail || (p.phase === 'connected' ? '正在实时接收微信消息' : '生成二维码，连接此用户的微信。')));
  const facts = element('div', 'card-facts');
  const messages = element('span', '', '消息 '); messages.append(element('strong', '', String(p.total ?? 0)));
  facts.append(messages, element('span', '', p.lastReceived ? `最近接收 ${date.format(new Date(p.lastReceived))}` : '本次运行尚未接收')); card.append(facts);
  const actions = element('div', 'card-actions');
  if (!p.account) actions.append(action(['waiting', 'scanned', 'verifying', 'loading'].includes(p.phase) ? '查看配对' : '扫码连接', 'primary', p, () => openDetail(p.id), 'pair'));
  else actions.append(action(p.phase === 'paused' ? '恢复接收' : '暂停接收', 'secondary', p, async () => {
    try { await command(p.id, p.phase === 'paused' ? 'resume' : 'pause'); toast(p.phase === 'paused' ? '已恢复接收' : '已暂停接收'); }
    catch (error) { toast(error.message); }
  }, 'toggle'));
  const inbox = element('a', 'secondary', '消息收件箱'); inbox.href = url('/', p.id); actions.append(inbox);
  if (p.account) {
    actions.append(action('详情', 'text-button', p, () => openDetail(p.id), 'detail'));
    const disconnect = action('断开', 'text-button', p, () => {
      disconnectId = p.id; $('#disconnect-description').textContent = `即将断开「${p.name}」的微信连接。`;
      $('#disconnect-error').hidden = true; $('#disconnect-dialog').showModal();
    }, 'disconnect');
    disconnect.setAttribute('aria-label', `断开 ${p.name}`); actions.append(disconnect);
  }
  card.append(actions); return card;
}
function render() {
  $('#metric-total').textContent = profiles.length;
  $('#metric-online').textContent = profiles.filter(p => p.phase === 'connected').length;
  $('#metric-attention').textContent = profiles.filter(needsAttention).length;
  $('#list-count').textContent = profiles.length;
  $('#add-profile').disabled = !healthy || nameBusy;
  $('#network-error').hidden = healthy;
  const query = $('#search').value.trim().toLocaleLowerCase();
  const visible = profiles.filter(p => (filter === 'all' || filter === 'online' && p.phase === 'connected' || filter === 'attention' && needsAttention(p) || filter === 'paused' && p.phase === 'paused') &&
    `${p.name} ${p.account?.userId || ''} ${p.account?.id || ''}`.toLocaleLowerCase().includes(query));
  $('#empty').hidden = visible.length > 0 || !healthy;
  const stamp = JSON.stringify([visible, [...busy], healthy]);
  if (stamp !== cardStamp) {
    const focused = document.activeElement?.dataset.action;
    $('#connections').replaceChildren(...visible.map(card)); cardStamp = stamp;
    if (focused) [...$('#connections').querySelectorAll('button')].find(b => b.dataset.action === focused)?.focus({ preventScroll: true });
  }
  renderDetail();
}
async function refresh() {
  if (refreshing) return;
  refreshing = true; $('#refresh').disabled = true;
  const start = revision;
  try {
    const data = await request('/api/profiles');
    if (start === revision) profiles = data.profiles;
    healthy = true;
    $('#sync-status').textContent = '服务已连接 · 自动同步'; $('#sync-status').classList.add('live');
    $('#last-sync').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
  } catch {
    healthy = false; $('#sync-status').textContent = '连接中断 · 正在重试'; $('#sync-status').classList.remove('live');
  } finally { refreshing = false; $('#refresh').disabled = false; render(); }
}
async function command(id, path, body) {
  if (busy.has(id)) return null;
  busy.add(id); render();
  try {
    const data = await request(`/api/${path}`, id, body, true);
    adopt(data);
    if (selectedId === id && $('#connection-dialog').open) { detailState = data; renderDetail(); }
    return data;
  } finally { busy.delete(id); render(); }
}
function editName(p) {
  editId = p?.id || null;
  $('#name-title').textContent = p ? '重命名连接' : '新增连接';
  $('#name-description').textContent = p ? '修改显示名称，微信绑定和历史消息保持不变。' : '起个容易识别的名字，然后由对应微信账号扫码。';
  $('#name-submit').textContent = p ? '保存名称' : '创建并扫码';
  $('#profile-name').value = p?.name || ''; $('#name-error').hidden = true;
  $('#name-dialog').showModal(); $('#profile-name').focus();
}
$('#name-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (nameBusy) return;
  nameBusy = true; $('#name-submit').disabled = true; render();
  const id = editId;
  try {
    const data = id ? await command(id, 'profile', { name: $('#profile-name').value.trim() }) :
      await request('/api/profiles', null, { name: $('#profile-name').value.trim() }, true);
    if (!data) return;
    adopt(data); $('#name-dialog').close();
    toast(id ? '名称已更新' : '连接已创建，请扫码配对');
    if (!id) { await openDetail(data.profile.id); if (selectedId === data.profile.id) await generateQR(); }
  } catch (error) {
    if ($('#name-dialog').open) { $('#name-error').hidden = false; $('#name-error').textContent = error.message; }
    else toast(error.message);
  } finally { nameBusy = false; $('#name-submit').disabled = false; render(); }
});
async function openDetail(id) {
  detailStream?.close(); detailStream = null;
  selectedId = id; detailState = null;
  $('#detail-error').hidden = true; $('#verify-code').value = '';
  $('#connection-dialog').showModal(); renderDetail();
  try {
    const data = await request('/api/state', id);
    if (selectedId !== id || !$('#connection-dialog').open) return;
    detailState = data; adopt(data);
    const stream = detailStream = new EventSource(url('/api/events', id));
    stream.addEventListener('snapshot', event => {
      if (detailStream !== stream || selectedId !== id) return;
      const data = JSON.parse(event.data); detailState = data; adopt(data);
      if ($('#detail-error').dataset.source === 'stream') $('#detail-error').hidden = true;
    });
    stream.addEventListener('error', () => {
      if (detailStream !== stream) return;
      $('#detail-error').dataset.source = 'stream';
      $('#detail-error').hidden = false; $('#detail-error').textContent = '实时状态连接中断，正在重连。';
    });
  } catch (error) {
    if (selectedId === id) { $('#detail-error').dataset.source = 'operation'; $('#detail-error').hidden = false; $('#detail-error').textContent = error.message; }
  }
}
function renderDetail() {
  if (!$('#connection-dialog').open) return;
  const p = profiles.find(p => p.id === selectedId);
  const s = detailState;
  $('#detail-name').textContent = s?.profile.name || p?.name || '连接详情';
  $('#detail-badge').textContent = s ? labels[s.phase] || s.phase : '读取中';
  $('#detail-badge').dataset.phase = s?.phase || 'loading';
  $('#detail-title').textContent = !s ? '正在读取连接状态…' : s.phase === 'connected' ? '微信已连接' : s.phase === 'paused' ? '接收已暂停' : s.phase === 'verifying' ? '完成最后一步配对' : '扫码连接微信';
  $('#detail-description').textContent = s?.detail || '正在同步此账号的连接信息。';
  $('#detail-account').textContent = s?.account?.userId || '尚未连接';
  $('#detail-bot').textContent = s?.account?.id || '—';
  $('#detail-codex').textContent = s?.codex?.available ? s.codex.enabled ? s.codex.active ? '正在处理消息' : '已开启' : '已暂停' : '未启用';
  $('#detail-auto').hidden = !s?.codex?.available;
  $('#detail-auto').textContent = s?.codex?.enabled ? '暂停自动回复' : '开启自动回复';
  $('#detail-auto').disabled = !healthy || busy.has(selectedId);
  $('#detail-inbox').href = url('/', selectedId);
  $('#pairing-qr').hidden = !s?.qr;
  if (s?.qr && $('#pairing-qr').src !== s.qr) $('#pairing-qr').src = s.qr;
  $('#pairing-placeholder').hidden = Boolean(s?.qr);
  $('#pairing-symbol').textContent = s?.account ? '✓' : '▦';
  $('#pairing-heading').textContent = s?.account ? '微信已绑定' : '连接你的微信';
  $('#pairing-hint').textContent = s?.account ? '可以打开消息收件箱，查看此账号的对话。' : '生成二维码后，使用微信扫一扫。';
  $('#pairing-status').textContent = s?.detail || '';
  $('#verify-form').hidden = s?.phase !== 'verifying';
  $('#verify-form button').disabled = !healthy || busy.has(selectedId);
  $('#generate-qr').hidden = Boolean(s?.account);
  $('#generate-qr').disabled = !s || busy.has(selectedId) || s.phase === 'loading' || !healthy;
  $('#generate-qr').textContent = s?.phase === 'loading' ? '正在获取二维码…' : s?.qr || s?.phase === 'expired' ? '刷新登录二维码' : '生成登录二维码';
}
async function generateQR() {
  const id = selectedId;
  $('#detail-error').hidden = true;
  try { await command(id, 'login'); }
  catch (error) { if (selectedId === id) { $('#detail-error').dataset.source = 'operation'; $('#detail-error').hidden = false; $('#detail-error').textContent = error.message; } }
}
$('#generate-qr').addEventListener('click', generateQR);
$('#verify-form').addEventListener('submit', async event => {
  event.preventDefault(); const id = selectedId;
  try { await command(id, 'verify', { code: $('#verify-code').value.trim() }); if (selectedId === id) $('#verify-code').value = ''; }
  catch (error) { if (selectedId === id) { $('#detail-error').dataset.source = 'operation'; $('#detail-error').hidden = false; $('#detail-error').textContent = error.message; } }
});
$('#detail-auto').addEventListener('click', async () => {
  if (!detailState?.codex) return;
  try { await command(selectedId, 'codex/config', { enabled: !detailState.codex.enabled }); }
  catch (error) { toast(error.message); }
});
$('#connection-dialog').addEventListener('close', () => { detailStream?.close(); detailStream = null; selectedId = null; detailState = null; });
$('#disconnect-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('#disconnect-submit').disabled = true;
  try { const data = await command(disconnectId, 'logout'); if (data) { $('#disconnect-dialog').close(); toast('已断开此账号，历史记录已保留'); } }
  catch (error) { $('#disconnect-error').hidden = false; $('#disconnect-error').textContent = error.message; }
  finally { $('#disconnect-submit').disabled = false; }
});
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => {
  if (button.dataset.close === 'name-dialog' && nameBusy) return;
  document.getElementById(button.dataset.close).close();
});
$('#name-dialog').addEventListener('cancel', event => { if (nameBusy) event.preventDefault(); });
for (const button of document.querySelectorAll('[data-filter]')) button.addEventListener('click', () => {
  filter = button.dataset.filter;
  for (const b of document.querySelectorAll('[data-filter]')) b.setAttribute('aria-pressed', String(b === button));
  render();
});
$('#reset-filters').addEventListener('click', () => { $('#search').value = ''; $('[data-filter=all]').click(); });
$('#search').addEventListener('input', render);
$('#add-profile').addEventListener('click', () => editName());
$('#refresh').addEventListener('click', refresh);
const scheduleRefresh = () => setInterval(() => { if (!document.hidden) void refresh(); }, 3000);
let timer = scheduleRefresh();
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
window.addEventListener('pagehide', () => { clearInterval(timer); detailStream?.close(); });
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  clearInterval(timer); timer = scheduleRefresh(); void refresh();
  if (selectedId && $('#connection-dialog').open) void openDetail(selectedId);
});
void refresh();
