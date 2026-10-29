import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import QRCode from 'qrcode';
import { trustedBase } from './weixin.js';
import { downloadMedia, describeMedia, saveMedia } from './media.js';
import { downloadNotice } from './downloads.js';

export class Bridge extends EventEmitter {
  constructor(store, api, dir, { media = downloadMedia, pollDelay = 300, retryDelay = 2000, validateAccount = () => {}, replyLimit = 0, publishDownload } = {}) {
    super();
    Object.assign(this, { store, api, dir, media, pollDelay, retryDelay, validateAccount, replyLimit, publishDownload });
    this.state = { phase: 'offline', detail: '扫码连接微信，开始接收消息', qr: null, lastReceived: null };
    this.jobs = new Set();
  }
  snapshot() {
    const account = this.store.get('account');
    return { ...this.state, account: account ? { id: account.id, userId: account.userId } : null,
      canSend: Boolean(account?.userId) && ['connected', 'connecting', 'reconnecting', 'paused'].includes(this.state.phase),
      hasReplyContext: Boolean(account && this.store.get(`context:${account.id}:${account.userId}`)),
      codex: this.codex?.snapshot() || { available: false, enabled: false },
      total: this.store.count(), messages: this.store.messages() };
  }
  update(state) { Object.assign(this.state, state); this.emit('change'); }
  run(promise) {
    this.jobs.add(promise);
    promise.catch(() => {}).finally(() => this.jobs.delete(promise));
  }
  async init() {
    this.store.recoverSends();
    if (this.store.get('account')) {
      if (this.store.get('paused')) this.update({ phase: 'paused', detail: '接收已暂停' });
      else this.resume();
    }
  }
  async login() {
    this.loginController?.abort();
    this.pollController?.abort();
    const controller = this.loginController = new AbortController();
    this.verifyCode = null;
    const { signal } = controller;
    this.update({ phase: 'loading', detail: '正在获取微信二维码…', qr: null });
    try {
      const response = await this.api.qr(signal);
      if (!response.qrcode || !response.qrcode_img_content) throw new Error('微信未返回有效二维码，请重试');
      const qr = await QRCode.toDataURL(response.qrcode_img_content, { width: 280, margin: 2, errorCorrectionLevel: 'M' });
      signal.throwIfAborted();
      this.update({ phase: 'waiting', detail: '请使用微信扫一扫', qr });
      this.run(this.waitForLogin(response.qrcode, controller));
    } catch (error) {
      if (!signal.aborted) this.update({ phase: 'error', detail: `获取二维码失败：${error.message}`, qr: null });
    }
  }
  async waitForLogin(qrcode, controller) {
    const { signal } = controller;
    const deadline = Date.now() + 240000;
    let base = this.api.baseUrl;
    try {
      while (!signal.aborted && Date.now() < deadline) {
        if (this.state.phase === 'verifying' && !this.verifyCode) {
          await delay(300, undefined, { signal });
          continue;
        }
        let result;
        try { result = await this.api.status(base, qrcode, signal, this.verifyCode); }
        catch (error) {
          if (signal.aborted) return;
          if (error.name === 'TimeoutError') continue;
          this.update({ detail: '连接微信暂时中断，正在重试…' });
          await delay(this.retryDelay, undefined, { signal });
          continue;
        }
        signal.throwIfAborted();
        if (result.status === 'expired') break;
        if (result.status === 'need_verifycode') {
          const detail = this.verifyCode ? '配对码不匹配，请重新输入手机微信显示的数字' : '请输入手机微信显示的配对码';
          this.verifyCode = null;
          this.update({ phase: 'verifying', detail });
        } else if (result.status === 'verify_code_blocked') {
          throw new Error('配对码错误次数过多，请稍后重新扫码');
        } else if (result.status === 'binded_redirect') {
          if (!this.store.get('account')) throw new Error('微信提示已绑定，但本机没有凭证，请在手机上断开原连接后重试');
          this.resume();
          this.emit('paired');
          return;
        } else if (result.status === 'scaned_but_redirect') {
          if (!result.redirect_host) throw new Error('微信未返回扫码节点地址，请重试');
          base = trustedBase(`https://${result.redirect_host}`);
          this.update({ phase: 'scanned', detail: '扫码成功，正在连接微信服务节点…' });
        }
        if (result.status === 'scaned' || result.status === 'scanned') {
          this.verifyCode = null;
          this.update({ phase: 'scanned', detail: '扫码成功，请在手机上确认' });
        } else if (result.status === 'confirmed') {
          if (!result.bot_token || !result.ilink_bot_id) throw new Error('登录响应缺少账号信息，请重新扫码');
          const account = { id: result.ilink_bot_id, token: result.bot_token,
            userId: result.ilink_user_id, baseUrl: trustedBase(result.baseurl || base) };
          this.validateAccount(account);
          this.store.set('account', account);
          this.update({ qr: null });
          this.resume();
          this.emit('paired');
          return;
        } else if (result.status === 'wait' && this.state.phase !== 'scanned') {
          this.update({ detail: '请使用微信扫一扫' });
        }
        await delay(1000, undefined, { signal });
      }
      if (!signal.aborted) this.update({ phase: 'expired', detail: '二维码已过期，请重新获取', qr: null });
    } catch (error) {
      if (!signal.aborted) this.update({ phase: 'error', detail: error.message, qr: null });
    }
  }
  verify(code) {
    if (this.state.phase !== 'verifying') throw new Error('当前无需输入配对码');
    if (typeof code !== 'string' || !/^\d{1,12}$/.test(code)) throw new Error('请输入手机显示的数字配对码');
    this.verifyCode = code;
    this.update({ detail: '正在验证配对码…' });
  }
  resume() {
    const account = this.store.get('account');
    if (!account) throw new Error('请先扫码连接微信');
    this.loginController?.abort();
    this.pollController?.abort();
    const controller = this.pollController = new AbortController();
    this.store.set('paused', false);
    this.update({ phase: 'connecting', detail: '正在连接微信消息通道…', qr: null });
    this.run(this.poll(account, controller));
  }
  pause() {
    this.loginController?.abort();
    this.pollController?.abort();
    this.store.set('paused', true);
    this.update({ phase: 'paused', detail: '接收已暂停', qr: null });
  }
  logout() {
    this.pause();
    this.store.set('account', null);
    this.update({ phase: 'offline', detail: '已断开连接，可重新扫码', qr: null });
  }
  async send(text, requestId, expected = {}) {
    return this.sendPayload({ text }, requestId, expected);
  }
  async sendMedia(bytes, name, kind, requestId, expected = {}) {
    const description = describeMedia(bytes, name, kind);
    const account = this.store.get('account');
    const result = await this.sendPayload({ text: '', bytes, description }, requestId, expected);
    if (!this.publishDownload || !['failed', 'unknown'].includes(result.status)) return result;
    const matches = () => { const a = this.store.get('account'); return a?.id === account?.id && a?.userId === account?.userId; };
    if (!matches()) return result;
    try {
      const id = createHash('sha256').update(`download:${this.dir}:${account.id}:${account.userId}:${requestId}`).digest('hex');
      const link = await this.publishDownload(bytes, description.name, id);
      if (!matches()) return result;
      result.download = { ...link, text: downloadNotice(description.name, link, result.status === 'unknown') };
      // Platform queues this notice durably in its outbox, sharing the ten-reply limit.
      // Legacy callers have no platform outbox; use a stable receipt here instead.
      if (!this.replyLimit) {
        const noticeId = `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20,32)}`;
        const notice = await this.send(result.download.text, noticeId, { ...expected, accountId: account.id, userId: account.userId });
        result.download.noticeStatus = notice.status;
      }
    } catch { result.downloadError = '备用下载链接暂时无法提供'; }
    return result;
  }
  async sendPayload({ text, bytes, description }, requestId, expected) {
    if (!bytes && (typeof text !== 'string' || !text.trim())) throw new Error('请输入要发送的文字');
    if (text.length > 4000) throw new Error('每条消息最多 4000 个字符，请分条发送');
    if (typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/i.test(requestId)) throw new Error('发送请求标识无效，请刷新页面重试');
    const account = this.store.get('account');
    if (!account?.userId) throw new Error('请先扫码连接微信，确认接收账号');
    if ((expected.accountId && expected.accountId !== account.id) || (expected.userId && expected.userId !== account.userId)) {
      throw new Error('微信绑定账号已变更，已停止向原会话发送');
    }
    const id = `out:${account.id}:${requestId}`;
    const hash = createHash('sha256').update(bytes ? JSON.stringify(description) : text);
    if (bytes) hash.update(bytes);
    const digest = hash.digest('hex');
    const receipt = this.store.receipt(id);
    if (receipt) {
      if (receipt.hash !== digest) throw new Error('同一发送请求不能修改消息内容');
      return { id, status: receipt.status, error: receipt.error };
    }
    if (!this.snapshot().canSend) throw new Error('微信连接暂不可用，请完成扫码或恢复连接');
    if (bytes && this.replyLimit) {
      const budget=this.store.replyBudget(account,this.replyLimit);
      if (budget.remaining===1) {
        // Keep the tenth slot as a text notice: do not rely on mixed media/text
        // rendering or spend an eleventh message after the attachment.
        const h=createHash('sha256').update(`quota-notice:${account.id}:${account.userId}:${budget.epoch}`).digest('hex');
        const noticeId=`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
        await this.send('还有图片或文件等待发送。',noticeId,expected);
        return {id,status:'blocked',budgetEpoch:budget.epoch,error:'已到微信回复上限，附件已排队，请在微信发送消息后继续'};
      }
    }
    const message = { id, direction: 'outbound', sender: '本机', recipient: account.userId,
      receivedAt: new Date().toISOString(), text, quotes: [], attachments: [], status: 'sending', source: expected.source || 'local' };
    // Reserve the receipt before the first await so simultaneous retries cannot send twice.
    const reserved = this.store.beginSend(message, digest, this.replyLimit ? {
      account, limit: this.replyLimit,
      notice: `\n\n【回复提醒】这是本轮第 ${this.replyLimit} 条消息，已达到微信连续回复上限。请在微信里再发一条消息（例如“继续”），才能接收后续回复；完整内容也可在网页查看。`,
    } : null);
    if (!reserved) return { id, status: 'blocked', budgetEpoch: this.store.replyBudget(account, this.replyLimit).epoch,
      error: '微信回复额度已用完，请在微信里再发一条消息后继续' };
    this.emit('change');
    let status = 'sent', error = null, submitted = false;
    try {
      let item;
      if (bytes) {
        const attachment = await saveMedia(bytes, description, this.dir);
        this.store.setSendAttachments(id, [attachment]);
        this.emit('change');
        item = await this.api.uploadMedia(account, bytes, attachment);
      }
      const current = this.store.get('account');
      if (current?.id !== account.id || current?.userId !== account.userId) throw new Error('微信绑定账号已变更，附件未发送');
      submitted = true;
      if (item) await this.api.sendItem(account, item, `clawbot-local-${requestId}`,
        this.store.get(`context:${account.id}:${account.userId}`));
      else await this.api.sendText(account, message.text, `clawbot-local-${requestId}`,
        this.store.get(`context:${account.id}:${account.userId}`));
    } catch (cause) {
      if (!submitted && typeof cause.code !== 'number') {
        status = 'failed'; error = `附件准备或上传失败：${cause.message}`;
      } else if (typeof cause.code === 'number') {
        status = 'failed';
        error = `${cause.message}。请从微信向 ClawBot 再发一条消息后重试`;
        if (cause.code === -14) {
          this.pollController?.abort();
          this.store.set('account', null);
          this.update({ phase: 'expired', detail: '微信登录已失效，请重新扫码', qr: null });
          error = '微信登录已失效，请重新扫码后发送';
        }
      } else {
        status = 'unknown';
        error = '未能确认发送结果，请先在微信查看是否收到，避免重复发送';
      }
    }
    this.store.finishSend(id, status, error);
    this.emit('change');
    return { id, status, error };
  }
  startTyping(expected, onState = () => {}) {
    const account = this.store.get('account');
    if (!this.api.config || !this.api.typing || !account || account.id !== expected.accountId || account.userId !== expected.userId) {
      return async () => {};
    }
    let stopped = false, ticket = null, lastTicket = null, timer, pending;
    const matches = () => {
      const current = this.store.get('account');
      return current?.id === account.id && current?.userId === account.userId && current?.token === account.token;
    };
    const tick = async () => {
      try {
        if (stopped || !matches()) return;
        if (!ticket) ticket = (await this.api.config(account, this.store.get(`context:${account.id}:${account.userId}`))).typing_ticket;
        if (!ticket) throw new Error('未获取输入状态凭证');
        if (stopped || !matches()) return;
        lastTicket = ticket;
        await this.api.typing(account, ticket, 1);
        if (!stopped) onState({ typing: true, typingError: null });
      } catch {
        ticket = null;
        if (!stopped) onState({ typing: false, typingError: '微信输入状态暂不可用，任务仍在继续' });
      } finally {
        if (!stopped && matches()) { timer = setTimeout(() => { pending = tick(); }, this.typingInterval || 8000); timer.unref(); }
      }
    };
    pending = tick();
    return async () => {
      if (stopped) return;
      stopped = true; clearTimeout(timer);
      await pending;
      if (lastTicket && matches()) {
        try { await this.api.typing(account, lastTicket, 2); } catch { /* Indicator expires upstream. */ }
      }
      onState({ typing: false });
    };
  }
  async poll(account, controller) {
    const { signal } = controller;
    const cursorKey = `cursor:${account.id}`;
    let failures = 0;
    while (!signal.aborted) {
      try {
        const result = await this.api.updates(account, this.store.get(cursorKey) || '', signal);
        signal.throwIfAborted();
        if (!Array.isArray(result.msgs) && result.msgs != null) throw new Error('微信消息格式异常');
        const messages = [];
        const contexts = [];
        const batchIds = new Set();
        for (const msg of result.msgs || []) {
          if (Number(msg.message_type) !== 1 || !msg.from_user_id ||
              (account.userId && account.userId !== msg.from_user_id) ||
              (msg.message_state != null && Number(msg.message_state) !== 2)) continue;
          if (typeof msg.context_token === 'string' && msg.context_token.trim()) {
            contexts.push([`context:${account.id}:${msg.from_user_id}`, msg.context_token]);
          }
          const id = this.store.key(account.id, msg);
          if (this.store.has(id) || batchIds.has(id)) continue;
          batchIds.add(id);
          const text = [], attachments = [], quotes = [];
          for (const item of msg.item_list || []) {
            if (item.type === 1 && typeof item.text_item?.text === 'string') text.push(item.text_item.text);
            if (item.type === 3 && typeof item.voice_item?.text === 'string') text.push(item.voice_item.text);
            if (item.ref_msg?.title) quotes.push(String(item.ref_msg.title));
            if ([2, 3, 4, 5].includes(item.type)) attachments.push(await this.media(item, this.dir, signal));
          }
          messages.push({ id, sender: msg.from_user_id, receivedAt: new Date().toISOString(),
            text: text.join('\n'), quotes, attachments });
        }
        signal.throwIfAborted();
        const added = this.store.ingest(messages, cursorKey, result.get_updates_buf, contexts,
          this.codex?.plan(messages, account) || []);
        failures = 0;
        this.update({ phase: 'connected', detail: '正在实时接收微信消息',
          ...(added.length ? { lastReceived: added.at(-1).receivedAt } : {}) });
        if (added.length) this.emit('messages', added);
        this.codex?.wake();
        await delay(this.pollDelay, undefined, { signal });
      } catch (error) {
        if (signal.aborted) return;
        if (error.code === -14) {
          this.store.set('account', null);
          this.update({ phase: 'expired', detail: '微信登录已失效，请重新扫码', qr: null });
          return;
        }
        if (error.name !== 'TimeoutError') {
          failures++;
          this.update({ phase: 'reconnecting', detail: `${error.message}，正在自动重连…` });
        }
        try { await delay(Math.min(this.retryDelay * 2 ** Math.min(failures, 4), 30000), undefined, { signal }); }
        catch { return; }
      }
    }
  }
  async close() {
    this.loginController?.abort();
    this.pollController?.abort();
    await Promise.allSettled([...this.jobs]);
  }
}
