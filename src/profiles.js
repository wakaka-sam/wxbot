import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from './store.js';
import { Bridge } from './bridge.js';
import { CodexManager } from './codex-manager.js';

const validId = id => id === 'default' || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
function nameOf(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 40) throw new Error('用户名称须为 1–40 个字符');
  return value.trim();
}

// Each profile owns its credentials, database, polling loop, queue and Codex client.
// The original directory remains the default profile; no legacy data is moved.
export class Profiles extends EventEmitter {
  constructor(dir, api, bridgeOptions, codexOptions) {
    super();
    Object.assign(this, { dir, api, bridgeOptions, codexOptions });
    this.items = new Map();
  }
  async init() {
    try {
      await this.open({ id: 'default', name: '默认用户' });
      const saved = this.items.get('default').store.get('profiles') || [];
      for (const meta of saved) {
        if (!validId(meta.id)) throw new Error('用户配置中的 ID 无效');
        nameOf(meta.name);
        if (meta.id === 'default') this.items.get('default').name = meta.name;
        else {
          if (this.items.has(meta.id)) throw new Error('用户配置中的 ID 重复');
          await this.open(meta);
        }
      }
    } catch (error) { await this.close(); throw error; }
  }
  async open({ id, name }) {
    const dir = id === 'default' ? this.dir : join(this.dir, 'profiles', id);
    const cwd = join(this.dir, 'workspaces', id);
    if (id !== 'default') await mkdir(cwd, { recursive: true, mode: 0o700 });
    const store = new Store(dir);
    const bridge = new Bridge(store, this.api, dir, {
      ...this.bridgeOptions,
      validateAccount: account => {
        const bound = store.get('profile-binding');
        if (bound && (bound.id !== account.id || bound.userId !== account.userId)) {
          throw new Error('此用户已绑定其他微信账号，请新增用户后扫码，避免混合历史记录');
        }
        for (const other of this.items.values()) {
          if (other.id !== id && other.store.get('account')?.id === account.id) {
            throw new Error(`此微信 Bot 已在「${other.name}」连接，请切换到该用户，勿重复连接`);
          }
        }
        store.set('profile-binding', { id: account.id, userId: account.userId });
      },
    });
    const options = this.codexOptions === false ? false : {
      ...this.codexOptions, ...(id === 'default' ? {} : { cwd }),
    };
    const codex = options === false ? null : new CodexManager(store, bridge, dir, options);
    bridge.codex = codex;
    const profile = { id, name, dir, store, bridge, codex, clients: new Set(), commands: Promise.resolve() };
    this.items.set(id, profile);
    const account = store.get('account');
    if (account) bridge.validateAccount(account);
    bridge.on('change', () => this.emit('change', profile));
    await bridge.init();
    codex?.wake();
    return profile;
  }
  list() {
    return [...this.items.values()].map(p => {
      const account = p.store.get('account');
      return { id: p.id, name: p.name, phase: p.bridge.state.phase,
        detail: p.bridge.state.detail, total: p.store.count(),
        lastReceived: p.bridge.state.lastReceived,
        account: account ? { id: account.id, userId: account.userId } : null };
    });
  }
  snapshot(profile) {
    return { ...profile.bridge.snapshot(), profile: { id: profile.id, name: profile.name }, profiles: this.list() };
  }
  save() {
    this.items.get('default').store.set('profiles', [...this.items.values()].map(({ id, name }) => ({ id, name })));
  }
  async create(name) {
    name = nameOf(name);
    if (this.items.size >= 50) throw new Error('最多支持 50 个用户');
    const profile = await this.open({ id: randomUUID(), name });
    this.save();
    this.emit('change', profile);
    return profile;
  }
  rename(profile, name) {
    profile.name = nameOf(name);
    this.save();
    this.emit('change', profile);
  }
  async close() {
    this.removeAllListeners('change');
    // Stop intake for every profile before waiting on any running Codex task.
    for (const p of this.items.values()) { p.bridge.loginController?.abort(); p.bridge.pollController?.abort(); }
    await Promise.all([...this.items.values()].map(async p => {
      await p.codex?.close();
      await p.bridge.close();
      for (const client of p.clients) client.end();
      p.store.close();
    }));
  }
}
