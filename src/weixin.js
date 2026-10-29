import { randomBytes, createCipheriv, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import JSONBig from 'json-bigint';

const codec = JSONBig({ storeAsString: true, protoAction: 'ignore', constructorAction: 'ignore' });
export const DEFAULT_BASE = 'https://ilinkai.weixin.qq.com';

export function trustedBase(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !(url.hostname === 'ilinkai.weixin.qq.com' ||
      url.hostname.endsWith('.ilinkai.weixin.qq.com')) || url.username || url.password ||
      (url.port && url.port !== '443')) throw new Error('微信返回了不受信任的服务地址');
  return url.origin;
}

export class Weixin {
  constructor({ baseUrl = DEFAULT_BASE, fetchImpl = fetch, routeTag = process.env.WEIXIN_ROUTE_TAG,
    onSendResult = event => console.info(JSON.stringify(event)),
    onUploadResult = event => console.info(JSON.stringify(event)) } = {}) {
    this.baseUrl = baseUrl;
    this.fetch = fetchImpl;
    this.routeTag = routeTag;
    this.onSendResult = onSendResult;
    this.onUploadResult = onUploadResult;
  }
  async request(base, path, { signal, token, body, timeout = 40000, allowEmpty = false } = {}) {
    const headers = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': '132106' };
    if (this.routeTag) headers.SKRouteTag = this.routeTag;
    if (token) Object.assign(headers, {
      Authorization: `Bearer ${token}`, AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64'),
    });
    if (body) Object.assign(headers, { 'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64') });
    const res = await this.fetch(new URL(path, base), {
      method: body ? 'POST' : 'GET', headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
      redirect: 'error',
    });
    if (!res.ok) throw new Error(`微信服务暂不可用（HTTP ${res.status}）`);
    const raw = await res.text();
    const data = allowEmpty && !raw.trim() ? {} : codec.parse(raw);
    if ((data.ret != null && Number(data.ret) !== 0) || (data.errcode != null && Number(data.errcode) !== 0)) {
      const error = new Error(`微信接口返回错误（${data.errcode || data.ret}）`);
      error.code = Number(data.errcode || data.ret);
      throw error;
    }
    return data;
  }
  qr(signal) { return this.request(this.baseUrl, '/ilink/bot/get_bot_qrcode?bot_type=3', {
    signal, timeout: 15000, body: { local_token_list: [] },
  }); }
  status(base, qr, signal, verifyCode) {
    return this.request(base, `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr)}${verifyCode ? `&verify_code=${encodeURIComponent(verifyCode)}` : ''}`, { signal });
  }
  updates(account, cursor, signal) {
    return this.request(account.baseUrl, '/ilink/bot/getupdates', {
      signal, token: account.token,
      body: { get_updates_buf: cursor, base_info: { channel_version: '2.4.10', bot_agent: 'ClawBotLocal/1.0.0' } },
      timeout: 65000,
    });
  }
  sendText(account, text, clientId, contextToken) {
    return this.sendItem(account, { type: 1, text_item: { text } }, clientId, contextToken);
  }
  config(account, contextToken) {
    return this.request(account.baseUrl, '/ilink/bot/getconfig', {
      token: account.token, timeout: 5000,
      body: { ilink_user_id: account.userId, context_token: contextToken,
        base_info: { channel_version: '2.4.10' } },
    });
  }
  typing(account, ticket, status) {
    return this.request(account.baseUrl, '/ilink/bot/sendtyping', {
      token: account.token, timeout: 5000, allowEmpty: true,
      body: { ilink_user_id: account.userId, typing_ticket: ticket, status,
        base_info: { channel_version: '2.4.10' } },
    });
  }
  async uploadMedia(account, bytes, attachment) {
    const key = randomBytes(16), filekey = randomBytes(16).toString('hex');
    const cipher = createCipheriv('aes-128-ecb', key, null);
    const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
    const result = await this.request(account.baseUrl, '/ilink/bot/getuploadurl', {
      token: account.token, timeout: 15000,
      body: { filekey, media_type: { image: 1, video: 2, file: 3 }[attachment.kind],
        to_user_id: account.userId, rawsize: bytes.length, filesize: encrypted.length,
        rawfilemd5: createHash('md5').update(bytes).digest('hex'), no_need_thumb: true,
        aeskey: key.toString('hex'), base_info: { channel_version: '2.4.10' } },
    });
    if (!result.upload_full_url && !result.upload_param) throw new Error('微信未返回媒体上传地址');
    const url = new URL(result.upload_full_url || 'https://novac2c.cdn.weixin.qq.com/c2c/upload');
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.cdn.weixin.qq.com') ||
        url.username || url.password || (url.port && url.port !== '443')) throw new Error('媒体上传地址不受信任');
    if (!result.upload_full_url) {
      url.searchParams.set('encrypted_query_param', result.upload_param);
      url.searchParams.set('filekey', filekey);
    }
    // Only encrypted bytes go to CDN; never forward the bot credential.
    // Retry only the CDN upload, with identical ciphertext and filekey. Never retry
    // sendmessage here: an ambiguous acknowledgement could duplicate a chat message.
    let param;
    for (let attempt = 1; attempt <= 3; attempt++) {
      let status = null, errorCode = null, failure;
      const started = Date.now();
      try {
        const response = await this.fetch(url, { method: 'POST', redirect: 'error',
          headers: { 'Content-Type': 'application/octet-stream' }, body: encrypted,
          signal: AbortSignal.timeout(60000) });
        status = response.status;
        const code = response.headers.get('x-error-code');
        if (code && /^-?\d{1,10}$/.test(code)) errorCode = Number(code);
        param = response.headers.get('x-encrypted-param')?.trim();
        await response.body?.cancel().catch(() => {});
        if (status !== 200) failure = new Error(`媒体上传失败（HTTP ${status}）`);
        else if (!param) failure = new Error('微信 CDN 未返回媒体下载参数');
      } catch {
        failure = new Error('媒体上传网络异常或超时');
      }
      const retry = Boolean(failure) && attempt < 3 && !(status >= 400 && status < 500);
      try { this.onUploadResult({ event: 'wechat.upload_result', attempt, status, errorCode,
        durationMs: Date.now() - started, outcome: failure ? (retry ? 'retrying' : 'failed') : 'uploaded' });
      } catch { /* Diagnostics must not affect delivery. Never log upload URLs or keys. */ }
      if (!failure) break;
      if (!retry) throw failure;
      await delay(250 * attempt);
    }
    // Upstream serializes the hex string as base64, not the raw key bytes.
    const media = { encrypt_query_param: param, aes_key: Buffer.from(key.toString('hex')).toString('base64'), encrypt_type: 1 };
    if (attachment.kind === 'image') return { type: 2, image_item: { media, mid_size: encrypted.length } };
    if (attachment.kind === 'video') return { type: 5, video_item: { media, video_size: encrypted.length } };
    return { type: 4, file_item: { media, file_name: attachment.name, len: String(bytes.length) } };
  }
  async sendItem(account, item, clientId, contextToken) {
    const started = Date.now();
    const numeric = value => value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
    const report = details => {
      // Correlate with the outbox UUID without logging users, message text or credentials.
      try { this.onSendResult({ event: 'wechat.send_result', clientId, hasContext: Boolean(contextToken),
        durationMs: Date.now() - started, ...details }); } catch { /* Logging must not trigger retries. */ }
    };
    try {
    const result = await this.request(account.baseUrl, '/ilink/bot/sendmessage', {
      token: account.token, timeout: 20000, allowEmpty: true,
      body: {
        msg: { from_user_id: '', to_user_id: account.userId, client_id: clientId,
          message_type: 2, message_state: 2,
          ...(contextToken ? { context_token: contextToken } : {}),
          item_list: [item],
        },
        base_info: { channel_version: '2.4.10', bot_agent: 'ClawBotLocal/1.0.0' },
      },
    });
    report({ outcome: 'accepted', ret: numeric(result.ret), errcode: numeric(result.errcode),
      emptyAcknowledgement: Object.keys(result).length === 0 });
    return result;
    } catch (error) {
      report({ outcome: typeof error.code === 'number' ? 'rejected' : 'unknown', errorCode: numeric(error.code) });
      throw error;
    }
  }
}
