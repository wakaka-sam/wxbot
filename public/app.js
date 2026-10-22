const $ = selector => document.querySelector(selector);
let state = { messages: [], total: 0, phase: 'offline' };
let filter = 'all', fingerprint = '', busy = false, toastTimer;
let sending = false, pendingSend = null, streamConnected = false;
let pendingMedia = null, sendingMedia = false;
const names = { offline: '未连接', loading: '获取中', waiting: '等待扫码', scanned: '等待确认',
  verifying: '输入配对码', connecting: '连接中', connected: '已连接', reconnecting: '重连中', paused: '已暂停', expired: '已过期', error: '连接失败' };
const dates = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
function toast(text) {
  $('#toast').textContent = text; $('#toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 2600);
}
function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}
function renderMessage(message) {
  const article = node('article', 'message');
  const outbound = message.direction === 'outbound';
  article.classList.toggle('outbound', outbound);
  article.dataset.id = message.id;
  article.append(node('div', 'avatar', outbound ? '我' : '微'));
  const content = node('div', 'message-content');
  const meta = node('div', 'message-meta');
  const sender = node('span', 'sender', outbound ? message.source === 'codex' ? 'Codex · 自动回复' : '我 · 本机发送' : '微信消息'); sender.title = message.sender;
  const time = node('time', '', dates.format(new Date(message.receivedAt))); time.dateTime = message.receivedAt;
  meta.append(sender, time);
  if (outbound) {
    const delivery = node('span', `delivery ${message.status}`, { sending: '发送中…', sent: '已发送', failed: '发送失败', unknown: '结果待确认' }[message.status] || '');
    if (message.status === 'sent') delivery.title = '微信接口已接受，不代表对方已读';
    meta.append(delivery);
  }
  content.append(meta);
  for (const quote of message.quotes || []) content.append(node('div', 'quote', quote));
  if (message.text) content.append(node('div', 'message-text', message.text));
  if (outbound && message.error) content.append(node('p', 'delivery-error', message.error));
  for (const attachment of message.attachments || []) {
    const container = node('div', 'attachment');
    if (attachment.id) {
      const url = `/media/${attachment.id}`;
      if (attachment.mime.startsWith('image/')) {
        const image = node('img'); image.src = url; image.alt = attachment.name; image.loading = 'lazy';
        container.append(image);
      } else if (attachment.mime === 'video/mp4') {
        const video = node('video'); video.src = url; video.controls = true; video.preload = 'metadata'; container.append(video);
      }
      const link = node('a', '', `↓ ${attachment.name} · ${Math.max(1, Math.round(attachment.size / 1024))} KB`);
      link.href = `${url}?download=1`; link.download = attachment.name; container.append(link);
      if (attachment.kind === 'voice') container.append(node('small', '', '原始微信语音（SILK），可下载保存'));
    } else { container.append(node('span', '', attachment.name), node('small', '', attachment.error || '暂无可预览内容')); }
    content.append(container);
  }
  if (!message.text && !message.attachments?.length) content.append(node('div', 'message-text', '[收到暂不支持展示的消息类型]'));
  article.append(content);
  if (message.text) {
    const copy = node('button', 'message-copy', '复制');
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(message.text); toast('已复制消息'); }
      catch { toast('复制失败，请手动选择消息文字'); }
    });
    article.append(copy);
  }
  return article;
}
function renderMessages() {
  const query = $('#search').value.toLocaleLowerCase();
  const messages = state.messages.filter(m => (filter !== 'text' || m.text) &&
    (filter !== 'media' || m.attachments?.length) &&
    `${m.text}\n${m.attachments?.map(a => a.name).join('\n')}`.toLocaleLowerCase().includes(query));
  const nextFingerprint = JSON.stringify(messages);
  if (fingerprint !== nextFingerprint) {
    const had = $('#messages').childElementCount;
    const oldIds = new Set([...$('#messages').children].map(el => el.dataset.id));
    const nodes = messages.map(renderMessage);
    for (const el of nodes) if (oldIds.has(el.dataset.id)) el.getAnimations().forEach(animation => animation.cancel());
    $('#messages').replaceChildren(...nodes);
    fingerprint = nextFingerprint;
    if (had && $('#follow').checked && !query && messages.length) {
      nodes.at(-1).scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'end' });
    }
  }
  $('#empty').hidden = messages.length > 0;
  $('#empty-title').textContent = state.messages.length ? '没有找到匹配的消息' : '等待第一条消息';
  $('#empty-description').textContent = state.messages.length ? '试试其他关键词，或切换消息类型。' : '连接微信后，向 ClawBot 发送一条消息。文字、图片和文件都会显示在这里。';
  $('#empty .flow').hidden = state.messages.length > 0;
  $('#list-info').textContent = query || filter !== 'all' ? `找到 ${messages.length} 条消息` :
    `最近 ${state.messages.length} 条消息${state.total > 500 ? ` · 共 ${state.total} 条，导出可查看全部` : ''}`;
  $('#clear').disabled = busy || state.total === 0;
}
function render() {
  const phase = state.phase;
  const hasAccount = Boolean(state.account);
  $('#status').textContent = names[phase] || phase; $('#status').dataset.phase = phase;
  $('#connection-detail').textContent = state.detail;
  $('#verify-form').hidden = phase !== 'verifying';
  $('#verify-form button').disabled = busy;
  $('#qr-image').hidden = !state.qr;
  if (state.qr && $('#qr-image').src !== state.qr) $('#qr-image').src = state.qr;
  const linked = hasAccount && ['connected', 'connecting', 'reconnecting', 'paused'].includes(phase);
  $('#linked-mark').hidden = !linked;
  $('#qr-placeholder').hidden = Boolean(state.qr) || linked;
  $('#account-name').textContent = state.account?.userId || state.account?.id || '';
  $('#login').hidden = linked;
  $('#login').textContent = ['waiting', 'scanned', 'expired', 'error'].includes(phase) ? '重新获取二维码 ↻' : '生成登录二维码 ↗';
  $('#login').disabled = busy || phase === 'loading';
  $('#toggle').hidden = !hasAccount;
  $('#toggle').textContent = phase === 'paused' || !linked ? '继续接收' : '暂停接收';
  $('#toggle').disabled = busy;
  $('#logout').hidden = !hasAccount; $('#logout').disabled = busy;
  $('#side-count').textContent = state.total; $('#heading-count').textContent = state.total;
  const last = state.lastReceived || state.messages.findLast(m => m.direction !== 'outbound')?.receivedAt;
  $('#last-received').textContent = last ? `最近接收 ${dates.format(new Date(last))}` : '还没有收到消息';
  renderMessages();
  renderComposer();
  renderCodex();
}
let codexConfigStamp = '';
function renderCodex() {
  const agent = state.codex;
  $('#codex-panel').hidden = !agent?.available;
  if (!agent?.available) return;
  $('#codex-status').textContent = !agent.enabled ? '自动回复已暂停；微信消息仍可查看。' :
    agent.active ? `正在处理 · 后面还有 ${agent.queued} 条消息` : `自动回复已开启${agent.queued ? ` · ${agent.queued} 条消息等待处理` : ' · 等待微信新消息'}`;
  $('#codex-toggle').textContent = agent.enabled ? '暂停自动回复' : '开启自动回复';
  $('#codex-toggle').disabled = busy || !streamConnected;
  $('#codex-new').disabled = busy || !state.account || !streamConnected;
  $('#codex-stop').disabled = busy || (!agent.active && !agent.queued) || !streamConnected;
  $('#codex-thread').textContent = agent.threadId ? `会话 ${agent.threadId}` : '首条新消息时创建会话';
  const latest = agent.active || agent.jobs?.at(-1);
  $('#codex-typing').hidden = !agent.active;
  $('#codex-typing').textContent = agent.active?.typing ? '已向微信发送「正在输入」状态' : agent.active?.typingError || '正在同步微信输入状态…';
  $('#codex-activity').textContent = latest?.activity || '每条新消息延续同一会话，重启服务后也可继续。';
  const preview = latest?.draft || latest?.reply || '';
  $('#codex-preview').hidden = !preview;
  if ($('#codex-preview').textContent !== preview) $('#codex-preview').textContent = preview;
  const stamp = JSON.stringify([agent.cwd, agent.model]);
  if (codexConfigStamp !== stamp) {
    $('#codex-cwd').value = agent.cwd || ''; $('#codex-model').value = agent.model || ''; codexConfigStamp = stamp;
  }
  $('#codex-config button').disabled = busy || !streamConnected;
  const statuses = {queued:'排队中',running:'处理中',replying:'回传中',completed:'已完成',failed:'执行失败',interrupted:'已停止',cancelled:'已取消'};
  $('#codex-jobs').replaceChildren(...(agent.jobs || []).map(job => {
    const row = node('div', 'codex-job');
    row.append(node('span', '', `${statuses[job.status] || job.status}${job.deliveryError ? ' · 回传失败' : ''}`),
      node('span', '', (job.text || '[附件]').slice(0, 120)));
    return row;
  }));
}
function renderComposer() {
  $('#media-send').disabled = busy || !streamConnected || !state.canSend || (!pendingMedia && !$('#send-file').files.length);
  $('#media-send').textContent = sendingMedia ? '正在上传并发送…' : pendingMedia ? '确认上次附件结果' : '发送附件 ↑';
  $('#send-file').disabled = busy || Boolean(pendingMedia);
  $('#send-kind').disabled = busy || Boolean(pendingMedia);
  const text = $('#send-text').value;
  $('#send-count').textContent = `${text.length} / 4000`;
  $('#send-text').readOnly = sending;
  $('#send-button').disabled = busy || !streamConnected || !state.canSend || (!pendingSend && !text.trim());
  $('#send-button').textContent = sending ? '正在发送…' : pendingSend ? '确认上次发送结果' : '发送消息 ↑';
  $('#send-recipient').textContent = state.account?.userId ? '当前扫码绑定的微信账号' : '尚未连接微信';
  $('#send-hint').textContent = !streamConnected ? '本地服务连接已断开' : !state.canSend ? '扫码连接微信后即可发送' :
    state.hasReplyContext ? 'Enter 换行 · ⌘ / Ctrl + Enter 发送' : '如提示会话失效，请先从微信发来一条消息';
}
async function sendMessage(event) {
  event?.preventDefault();
  if (busy || !streamConnected || !state.canSend) return;
  const text = $('#send-text').value;
  if (!pendingSend && !text.trim()) return;
  pendingSend ||= { requestId: crypto.randomUUID(), text, accountId: state.account.id };
  if (pendingSend.accountId !== state.account.id) {
    $('#send-error').hidden = false; $('#send-error').textContent = '接收账号已变更，上次发送已取消。请确认当前账号后重新发送。';
    pendingSend = null; renderComposer(); return;
  }
  busy = sending = true;
  $('#send-error').hidden = true;
  render();
  try {
    const response = await fetch('/api/send', { method: 'POST', headers: { 'X-Clawbot-Local': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: pendingSend.text, requestId: pendingSend.requestId }) });
    const data = await response.json();
    if (!response.ok) { pendingSend = null; throw new Error(data.error || '发送失败'); }
    state = data;
    if (data.delivery.status === 'sent') {
      if ($('#send-text').value === pendingSend.text) $('#send-text').value = '';
      toast('消息已发送到微信');
    } else {
      $('#send-error').hidden = false;
      $('#send-error').textContent = data.delivery.error || '消息仍在发送中，请稍后确认';
    }
    if (data.delivery.status !== 'sending') pendingSend = null;
  } catch (error) {
    $('#send-error').hidden = false;
    $('#send-error').textContent = pendingSend ? '未能获取发送结果。请点击「确认上次发送结果」，不会重复提交同一条消息。' : error.message;
  } finally { busy = sending = false; render(); }
}
async function sendAttachment(event) {
  event.preventDefault();
  if (busy || !streamConnected || !state.canSend) return;
  const file = $('#send-file').files[0];
  if (!pendingMedia && !file) return;
  if (!pendingMedia && (!file.size || file.size > 20 * 1024 * 1024)) { toast('请选择不超过 20 MB 的非空文件'); return; }
  pendingMedia ||= { file, kind: $('#send-kind').value, requestId: crypto.randomUUID(), accountId: state.account.id };
  if (pendingMedia.accountId !== state.account.id) { pendingMedia = null; toast('微信账号已变更，请确认后重新发送'); renderComposer(); return; }
  busy = sendingMedia = true; $('#media-error').hidden = true; render();
  try {
    const response = await fetch('/api/send-media', { method: 'POST', headers: {
      'X-Clawbot-Local': '1', 'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent(pendingMedia.file.name), 'X-File-Kind': pendingMedia.kind,
      'X-Request-Id': pendingMedia.requestId, 'X-Account-Id': pendingMedia.accountId,
    }, body: pendingMedia.file });
    const data = await response.json();
    if (!response.ok) { pendingMedia = null; throw new Error(data.error || '附件发送失败'); }
    state = data;
    if (data.delivery.status === 'sent') { $('#send-file').value = ''; toast('附件已发送到微信'); }
    else { $('#media-error').hidden = false; $('#media-error').textContent = data.delivery.error || '附件仍在发送中'; }
    if (data.delivery.status !== 'sending') pendingMedia = null;
  } catch (error) {
    $('#media-error').hidden = false;
    $('#media-error').textContent = pendingMedia ? '未能获取结果。点击「确认上次附件结果」查询，不会重复发送同一附件。' : error.message;
  } finally { busy = sendingMedia = false; render(); }
}
$('#media-form').addEventListener('submit', sendAttachment);
$('#send-file').addEventListener('change', renderComposer);
$('#send-form').addEventListener('submit', sendMessage);
$('#send-text').addEventListener('input', renderComposer);
$('#send-text').addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) sendMessage(event);
});
async function command(path, body) {
  if (busy) return;
  busy = true; render();
  try {
    const response = await fetch(`/api/${path}`, { method: 'POST', headers: { 'X-Clawbot-Local': '1', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '操作失败');
    state = data;
    return true;
  } catch (error) { toast(error.message); }
  finally { busy = false; render(); }
}
$('#codex-toggle').addEventListener('click', () => command('codex/config', { enabled: !state.codex.enabled, cwd: state.codex.cwd, model: state.codex.model }));
$('#codex-new').addEventListener('click', () => command('codex/new'));
$('#codex-stop').addEventListener('click', () => command('codex/stop'));
$('#codex-config').addEventListener('submit', event => { event.preventDefault(); command('codex/config', {
  enabled: state.codex.enabled, cwd: $('#codex-cwd').value.trim(), model: $('#codex-model').value.trim(),
}); });
$('#login').addEventListener('click', () => command('login'));
$('#verify-form').addEventListener('submit', async event => { event.preventDefault(); await command('verify', { code: $('#verify-code').value.trim() }); $('#verify-code').value = ''; });
$('#toggle').addEventListener('click', () => command(['connected', 'connecting', 'reconnecting'].includes(state.phase) ? 'pause' : 'resume'));
$('#logout').addEventListener('click', () => command('logout'));
$('#clear').addEventListener('click', () => $('#confirm-dialog').showModal());
$('#confirm-dialog').addEventListener('close', () => { if ($('#confirm-dialog').returnValue === 'confirm') command('clear'); });
$('#search').addEventListener('input', renderMessages);
document.querySelectorAll('.filter').forEach(button => button.addEventListener('click', () => {
  filter = button.dataset.filter;
  document.querySelectorAll('.filter').forEach(b => { b.classList.toggle('active', b === button); b.setAttribute('aria-pressed', String(b === button)); });
  renderMessages();
}));
document.addEventListener('keydown', event => {
  if (event.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) { event.preventDefault(); $('#search').focus(); }
});
const stream = new EventSource('/api/events');
stream.addEventListener('open', () => { streamConnected = true; renderComposer(); $('#stream-status').classList.add('live'); $('#stream-status').replaceChildren(node('i'), document.createTextNode('本地服务已连接')); });
stream.addEventListener('snapshot', event => { state = JSON.parse(event.data); render(); });
stream.addEventListener('error', () => { streamConnected = false; renderComposer(); $('#stream-status').classList.remove('live'); $('#stream-status').replaceChildren(node('i'), document.createTextNode('服务断开，正在重连')); });
render();
