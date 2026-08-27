'use strict';
// 监控 ~/.codex/sessions/**/*.jsonl，聚合各 session 状态
const fs = require('fs');
const path = require('path');
const os = require('os');
const chokidar = require('chokidar');
const { SessionState } = require('./parser');

const DEFAULT_CONFIG = {
  roots: [path.join(os.homedir(), '.codex', 'sessions')],
  idleTimeoutMs: 3 * 60 * 1000,
  // 只关心最近 2 天内活跃的 session
  maxAgeMs: 2 * 24 * 60 * 60 * 1000,
};

class AgentWatcher {
  constructor(config = {}) {
    // 过滤显式传入的 undefined 值：{...默认, ...{roots: undefined}} 会用 undefined 覆盖默认值，
    // 导致 scan() 里 for...of this.config.roots 抛 TypeError（无 config.json 的默认安装就会踩中）
    const clean = {};
    for (const k of Object.keys(config)) {
      if (config[k] !== undefined) clean[k] = config[k];
    }
    this.config = { ...DEFAULT_CONFIG, ...clean };
    this.sessions = new Map(); // file -> SessionState
    this.listeners = [];
    this.watcher = null;
    this.statusTimer = null;
  }

  onChange(fn) { this.listeners.push(fn); }
  emit(reason) {
    const snapshot = this.getAgents();
    for (const fn of this.listeners) fn(snapshot, reason);
  }

  // 读取整个文件（session 文件是追加写，量级可控；增量优化后续再说）
  // 增量偏移用 SessionState.linesRead（已读的原始行数，含空行/坏行），
  // 不能用 lineCount（只统计成功解析的行），否则日志里有空行时会错位重读
  loadFile(file, force = false) {
    if (!file.endsWith('.jsonl')) return null;
    let st = this.sessions.get(file);
    const isNew = !st || force;
    if (isNew) st = new SessionState(file);
    try {
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');
      const lastIdx = lines.length - 1;
      const endsWithNewline = content.endsWith('\n');
      let i = isNew ? 0 : Math.min(st.linesRead, lines.length);
      for (; i < lines.length; i++) {
        if (!lines[i].trim()) {
          st.linesRead = i + 1; // 空行也计入已读行数
          continue;
        }
        const ok = st.ingest(lines[i]);
        // 末行无换行结尾且解析失败：可能只写了一半，不推进偏移，留待下次变更重读
        if (!ok && i === lastIdx && !endsWithNewline) break;
        st.linesRead = i + 1;
      }
    } catch (e) {
      // 文件被删或占用，忽略
    }
    this.sessions.set(file, st);
    return { state: st, isNew };
  }

  scan() {
    const cutoff = Date.now() - this.config.maxAgeMs;
    for (const root of this.config.roots) {
      if (!fs.existsSync(root)) continue;
      walk(root, f => this.loadFile(f, true));
    }
    // 清理过期 session
    for (const [f, s] of this.sessions) {
      if (!s.lastEventAt || s.lastEventAt < cutoff) this.sessions.delete(f);
    }
    this.emit('scan');
  }

  start() {
    this.scan();
    const globs = this.config.roots.map(r => path.join(r, '**', '*.jsonl').replace(/\\/g, '/'));
    this.watcher = chokidar.watch(globs, {
      ignoreInitial: true,
      depth: 5,
      awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 300 },
    });
    this.watcher.on('add', f => { this.loadFile(f, true); this.emit('add'); });
    this.watcher.on('change', f => { this.loadFile(f); this.emit('change'); });
    this.watcher.on('unlink', f => { this.sessions.delete(f); this.emit('unlink'); });
    // 周期性重算 idle/done 状态
    this.statusTimer = setInterval(() => this.emit('tick'), 15 * 1000);
    return this;
  }

  stop() {
    if (this.watcher) this.watcher.close();
    if (this.statusTimer) clearInterval(this.statusTimer);
  }

  getAgents() {
    const now = Date.now();
    const agents = [];
    for (const s of this.sessions.values()) {
      if (s.internal) continue;
      const o = s.toJSON();
      o.status = computeStatus(s, now, this.config.idleTimeoutMs);
      agents.push(o);
    }
    // 活跃优先，其次最近事件
    const rank = { working: 0, done: 1, idle: 2, unknown: 3, error: 4 };
    agents.sort((a, b) => (rank[a.status] - rank[b.status]) || (b.lastEventAt || 0) - (a.lastEventAt || 0));
    return agents;
  }
}

function computeStatus(s, now, idleTimeoutMs) {
  if (s.lastEventAt && now - s.lastEventAt > idleTimeoutMs) return 'idle';
  if (s.taskComplete) return 'done';
  if (!s.lastEventAt) return 'unknown';
  return 'working';
}

function walk(dir, fn) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, fn);
    else if (e.isFile()) fn(p);
  }
}

module.exports = { AgentWatcher };
