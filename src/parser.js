'use strict';
// 解析 codex session JSONL 日志行 → agent 状态模型

class SessionState {
  constructor(file) {
    this.file = file;
    this.sessionId = null;
    this.cwd = '';
    this.originator = 'codex';
    this.startedAt = null;
    this.lastEventAt = null;
    this.taskStartedAt = null;
    this.taskCompletedAt = null;
    this.lastAgentMessage = '';
    this.lastReasoning = '';
    this.lastTool = '';
    this.turns = 0;
    this.tokens = 0;
    this.taskComplete = false;
    this.lineCount = 0; // 已成功解析的事件行数（不含空行/坏行）
    this.linesRead = 0; // 已读过的原始行数（含空行/坏行，watcher 增量偏移用）
  }

  get status() {
    if (this.taskComplete && !this.isActive()) return 'done';
    if (!this.lastEventAt) return 'unknown';
    if (this.isActive()) return this.taskComplete ? 'done' : 'working';
    return 'idle'; // 超时无事件
  }

  // 最近 IDLE_TIMEOUT_MS 内有事件则视为活跃
  isActive(now = Date.now(), timeoutMs = 3 * 60 * 1000) {
    return this.lastEventAt && now - this.lastEventAt < timeoutMs;
  }

  get project() {
    if (!this.cwd) return '';
    return this.cwd.split(/[\\/]/).filter(Boolean).pop() || this.cwd;
  }

  // 当前正在做什么的摘要
  get summary() {
    const msg = this.lastAgentMessage;
    if (msg && !msg.startsWith('{')) return truncate(msg, 80);
    if (this.lastReasoning) return truncate(this.lastReasoning, 60);
    if (this.lastTool) return `调用 ${this.lastTool}`;
    return this.status === 'working' ? '正在思考…' : '';
  }

  // 解析一行；返回是否为合法 JSON 行（空行/坏行返回 false，不计数）
  ingest(line) {
    let o;
    try { o = JSON.parse(line); } catch { return false; }
    this.lineCount++;
    const ts = o.timestamp ? Date.parse(o.timestamp) : Date.now();
    if (ts) this.lastEventAt = ts;

    const p = o.payload || {};
    switch (o.type) {
      case 'session_meta':
        this.sessionId = p.session_id;
        this.cwd = p.cwd || '';
        this.originator = p.originator || 'codex';
        this.startedAt = ts;
        // 过滤内部子代理（如 guardian 安全审查），不属于用户任务
        this.internal = !!(p.source && p.source.subagent) ||
          p.thread_source === 'guardian_review';
        break;
      case 'turn_context':
        if (p.cwd) this.cwd = p.cwd;
        break;
      case 'event_msg':
        this.ingestEventMsg(p, ts);
        break;
      case 'response_item':
        this.ingestResponseItem(p);
        break;
    }
    return true;
  }

  ingestEventMsg(p, ts) {
    switch (p.type) {
      case 'task_started':
        this.taskStartedAt = ts;
        this.taskComplete = false;
        this.turns++;
        break;
      case 'task_complete':
        this.taskComplete = true;
        this.taskCompletedAt = ts;
        if (p.last_agent_message) this.lastAgentMessage = p.last_agent_message;
        break;
      case 'token_count':
        if (p.info && p.info.total_token_usage) {
          this.tokens = p.info.total_token_usage.total_tokens || this.tokens;
        }
        break;
      case 'item_completed': {
        const item = p.item || {};
        if (item.type === 'AgentMessage' && item.message) {
          this.lastAgentMessage = item.message;
        } else if (item.type === 'Reasoning') {
          // item_completed 的 reasoning 一般无文本，忽略
        }
        break;
      }
    }
  }

  ingestResponseItem(p) {
    switch (p.type) {
      case 'message':
        if (p.role === 'assistant' && Array.isArray(p.content)) {
          const text = p.content
            .filter(c => c.type === 'output_text' || c.type === 'text')
            .map(c => c.text).join(' ');
          if (text) this.lastAgentMessage = text;
        }
        break;
      case 'reasoning':
        if (Array.isArray(p.summary) && p.summary.length) {
          const t = p.summary.map(s => s.text).join(' ').replace(/\*\*/g, '');
          if (t) this.lastReasoning = t;
        }
        break;
      case 'function_call':
        if (p.name) this.lastTool = p.name;
        break;
    }
  }

  toJSON() {
    return {
      sessionId: this.sessionId,
      file: this.file,
      project: this.project,
      cwd: this.cwd,
      originator: this.originator,
      status: this.status,
      startedAt: this.startedAt,
      lastEventAt: this.lastEventAt,
      taskCompletedAt: this.taskCompletedAt,
      summary: this.summary,
      turns: this.turns,
      tokens: this.tokens,
    };
  }
}

function truncate(s, n) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

module.exports = { SessionState };
