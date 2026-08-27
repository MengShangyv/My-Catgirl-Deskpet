'use strict';
// 猫娘桌宠单元/集成测试（纯 Node，无测试框架）
// 覆盖：src/parser.js 的 session JSONL 解析 + src/watcher.js 的聚合/增量逻辑
// 运行：npm test 或 node scripts/test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SessionState } = require('../src/parser.js');
const { AgentWatcher } = require('../src/watcher.js');

// ---------- 极简测试框架 ----------
const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  [ok]   ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: e });
    console.log(`  [FAIL] ${name}`);
    console.log(`         ${String(e.message).split('\n').join('\n         ')}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || '不相等'}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

// ---------- 临时 session root（年/月/日/rollout-*.jsonl 结构） ----------
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'nya-pet-test-'));
const FAR_MAX_AGE = 365 * 24 * 60 * 60 * 1000; // 测试中不过期清理
let caseSeq = 0;

// 每个用例独立的 session root，互不干扰
function makeCase() {
  const root = path.join(tmpBase, `case-${String(++caseSeq).padStart(2, '0')}`);
  const dayDir = path.join(root, '2026', '08', '27');
  fs.mkdirSync(dayDir, { recursive: true });
  const file = (name) => path.join(dayDir, `rollout-${name}.jsonl`);
  const makeWatcher = (opts = {}) => new AgentWatcher({
    roots: [root],
    idleTimeoutMs: opts.idleTimeoutMs ?? 60 * 1000,
    maxAgeMs: FAR_MAX_AGE,
  });
  const watcher = makeWatcher();
  return { root, file, watcher, makeWatcher };
}

const NOW = Date.now();
const ts = (offsetMs = 0) => new Date(NOW + offsetMs).toISOString();
const jline = (type, payload, offsetMs = 0) =>
  JSON.stringify({ timestamp: ts(offsetMs), type, payload });

// 按行追加（每行结尾带换行，模拟完整的 jsonl 写入）
function writeLines(file, lines) {
  fs.appendFileSync(file, lines.map((l) => `${l}\n`).join(''), 'utf8');
}
// 原样追加（可控是否带换行，模拟半截写入）
function appendRaw(file, text) { fs.appendFileSync(file, text, 'utf8'); }

function findAgent(watcher, sessionId) {
  return watcher.getAgents().find((a) => a.sessionId === sessionId);
}

// ---------- 1. session_meta 解析 ----------
test('session_meta 解析出 cwd/originator/project（project 取 cwd 最后一段）', () => {
  const { file, watcher } = makeCase();
  writeLines(file('meta'), [
    jline('session_meta', { session_id: 'sess-meta', cwd: 'C:\\Users\\LENOVO\\Desktop\\blog', originator: 'codex_cli' }),
  ]);
  watcher.loadFile(file('meta'));
  const a = findAgent(watcher, 'sess-meta');
  assert(a, '未解析出 agent');
  eq(a.cwd, 'C:\\Users\\LENOVO\\Desktop\\blog', 'cwd');
  eq(a.project, 'blog', 'project 应取 cwd 路径最后一段');
  eq(a.originator, 'codex_cli', 'originator');
  assert(a.file === file('meta'), 'file 字段应记录来源文件');
});

test('turn_context 更新 cwd，posix 路径 project 正确', () => {
  const { file, watcher } = makeCase();
  writeLines(file('meta2'), [
    jline('session_meta', { session_id: 'sess-meta2', cwd: 'C:\\old', originator: 'codex' }),
    jline('turn_context', { cwd: '/home/user/my-proj' }),
  ]);
  watcher.loadFile(file('meta2'));
  const a = findAgent(watcher, 'sess-meta2');
  eq(a.cwd, '/home/user/my-proj', 'turn_context 应覆盖 cwd');
  eq(a.project, 'my-proj', 'posix 路径 project');
});

test('cwd 末尾带分隔符 / 缺 originator 的边界', () => {
  const st = new SessionState('x');
  st.ingest(jline('session_meta', { session_id: 's1', cwd: 'C:\\work\\proj\\' }));
  eq(st.project, 'proj', '末尾分隔符不应产生空 project');
  eq(st.originator, 'codex', '缺 originator 时默认 codex');
  const st2 = new SessionState('y');
  st2.ingest(jline('session_meta', { session_id: 's2' }));
  eq(st2.project, '', '无 cwd 时 project 为空字符串');
});

// ---------- 2. internal 子代理过滤 ----------
test('internal 子代理（source.subagent / guardian_review）被过滤', () => {
  const { file, watcher } = makeCase();
  writeLines(file('main'), [
    jline('session_meta', { session_id: 'sess-main', cwd: '/w/main', originator: 'codex' }),
    jline('event_msg', { type: 'task_started' }),
  ]);
  writeLines(file('sub-a'), [
    jline('session_meta', { session_id: 'sess-sub-a', cwd: '/w/main', source: { subagent: { agent_id: 'x' } } }),
  ]);
  writeLines(file('sub-b'), [
    jline('session_meta', { session_id: 'sess-sub-b', cwd: '/w/main', thread_source: 'guardian_review' }),
  ]);
  watcher.scan(); // 走目录扫描路径
  const agents = watcher.getAgents();
  eq(agents.length, 1, 'internal 子代理应被过滤');
  eq(agents[0].sessionId, 'sess-main', '只应剩主 agent');
});

// ---------- 3. 状态机 ----------
test('roots: undefined 不覆盖默认配置（无 config.json 的默认安装不崩）', () => {
  const w = new AgentWatcher({ roots: undefined, idleTimeoutMs: undefined });
  assert(Array.isArray(w.config.roots) && w.config.roots.length >= 1, 'roots 应回退默认值');
  eq(w.config.idleTimeoutMs, 3 * 60 * 1000, 'idleTimeoutMs 应回退默认值');
  w.scan(); // 不应抛 TypeError
});

test('最近有事件 → working', () => {
  const { file, watcher } = makeCase();
  writeLines(file('st-work'), [
    jline('session_meta', { session_id: 'sess-work', cwd: '/w/a' }),
    jline('event_msg', { type: 'task_started' }, -1000),
  ]);
  watcher.loadFile(file('st-work'));
  eq(findAgent(watcher, 'sess-work').status, 'working');
});

test('task_complete → done，last_agent_message 进入 summary', () => {
  const { file, watcher } = makeCase();
  writeLines(file('st-done'), [
    jline('session_meta', { session_id: 'sess-done', cwd: '/w/a' }),
    jline('event_msg', { type: 'task_started' }, -2000),
    jline('event_msg', { type: 'task_complete', last_agent_message: '搞定，测试全绿' }, -1000),
  ]);
  watcher.loadFile(file('st-done'));
  const a = findAgent(watcher, 'sess-done');
  eq(a.status, 'done');
  eq(a.summary, '搞定，测试全绿');
});

test('超过 idleTimeoutMs 无事件 → idle（用很短的 idleTimeoutMs）', () => {
  const { file, makeWatcher } = makeCase();
  const watcher = makeWatcher({ idleTimeoutMs: 500 });
  writeLines(file('st-idle'), [
    jline('session_meta', { session_id: 'sess-idle', cwd: '/w/a' }),
    jline('event_msg', { type: 'task_started' }, -60 * 1000),
  ]);
  watcher.loadFile(file('st-idle'));
  eq(findAgent(watcher, 'sess-idle').status, 'idle');
});

test('无可解析事件 → unknown', () => {
  const { file, watcher } = makeCase();
  appendRaw(file('st-unknown'), 'not-a-json-line\n');
  watcher.loadFile(file('st-unknown'));
  const agents = watcher.getAgents();
  assert(agents.length === 1, '坏行文件也应产出 unknown agent');
  eq(agents[0].status, 'unknown');
});

test('排序：working 优先于 done 优先于 idle', () => {
  const { file, watcher } = makeCase();
  writeLines(file('order-idle'), [
    jline('session_meta', { session_id: 'o-idle' }),
    jline('event_msg', { type: 'task_started' }, -10 * 60 * 1000),
  ]);
  writeLines(file('order-done'), [
    jline('session_meta', { session_id: 'o-done' }),
    jline('event_msg', { type: 'task_started' }, -3000),
    jline('event_msg', { type: 'task_complete' }, -2000),
  ]);
  writeLines(file('order-work'), [
    jline('session_meta', { session_id: 'o-work' }),
    jline('event_msg', { type: 'task_started' }, -1000),
  ]);
  watcher.scan();
  const ids = watcher.getAgents().map((a) => a.sessionId);
  eq(ids[0], 'o-work', 'working 应排最前');
  eq(ids[1], 'o-done', 'done 次之');
  eq(ids[2], 'o-idle', 'idle 最后');
});

// ---------- 4. 增量解析 ----------
test('增量解析：追加行后状态/summary 更新且事件不重复计数（含空行偏移）', () => {
  const { file, watcher } = makeCase();
  // 初始 4 行（含一个空行，模拟真实日志中的空行）
  writeLines(file('inc'), [
    jline('session_meta', { session_id: 'sess-inc', cwd: '/w/inc', originator: 'codex' }),
    '',
    jline('event_msg', { type: 'token_count', info: { total_token_usage: { total_tokens: 100 } } }, -6000),
    jline('event_msg', { type: 'task_started' }, -5000),
  ]);
  const r1 = watcher.loadFile(file('inc'));
  assert(r1.isNew, '首次加载应标记 isNew');
  eq(r1.state.turns, 1, '首次 turns 应为 1');
  eq(r1.state.tokens, 100, '首次 tokens 应为 100');

  // 追加若干行（同样带空行）
  writeLines(file('inc'), [
    '',
    jline('event_msg', { type: 'token_count', info: { total_token_usage: { total_tokens: 260 } } }, -4000),
    jline('event_msg', { type: 'task_started' }, -3000),
    jline('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '第二段回复：修好了 3 个 bug' }] }, -2000),
  ]);
  const r2 = watcher.loadFile(file('inc'));
  assert(!r2.isNew, '第二次加载不应标记 isNew');
  eq(r2.state.turns, 2, 'task_started 只应新增计数 1 次（空行不应导致偏移重读）');
  eq(r2.state.tokens, 260, 'tokens 应更新为最新值');
  const a = findAgent(watcher, 'sess-inc');
  eq(a.status, 'working', '追加后仍应为 working');
  assert(String(a.summary).includes('第二段回复'), `summary 应包含新消息，实际: ${a.summary}`);
});

test('末行无换行符但 JSON 完整时也会被解析', () => {
  const { file, watcher } = makeCase();
  appendRaw(file('nonl'), jline('session_meta', { session_id: 'sess-nonl', cwd: '/w/n' }) + '\n');
  appendRaw(file('nonl'), jline('event_msg', { type: 'task_complete', last_agent_message: '完成了' })); // 无换行
  watcher.loadFile(file('nonl'));
  eq(findAgent(watcher, 'sess-nonl').status, 'done', '完整末行应立即解析');
});

test('半截写入的末行留待下次读取', () => {
  const { file, watcher } = makeCase();
  const complete = jline('event_msg', { type: 'task_complete', last_agent_message: 'done-msg' });
  appendRaw(file('partial'), jline('session_meta', { session_id: 'sess-partial', cwd: '/w/p' }) + '\n');
  appendRaw(file('partial'), complete.slice(0, Math.floor(complete.length / 2))); // 模拟写了一半
  watcher.loadFile(file('partial'));
  eq(findAgent(watcher, 'sess-partial').status, 'working', '半截行不应被计入');
  appendRaw(file('partial'), complete.slice(Math.floor(complete.length / 2)) + '\n'); // 补全
  watcher.loadFile(file('partial'));
  eq(findAgent(watcher, 'sess-partial').status, 'done', '补全后应解析');
});

// ---------- 5. assistant 消息 / reasoning 兜底 ----------
test('assistant 消息提取（role=assistant + output_text，多段拼接）', () => {
  const { file, watcher } = makeCase();
  writeLines(file('msg'), [
    jline('session_meta', { session_id: 'sess-msg', cwd: '/w/m' }),
    jline('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '用户输入不应成为 summary' }] }),
    jline('response_item', { type: 'message', role: 'assistant', content: [
      { type: 'output_text', text: '部署完成，' },
      { type: 'output_text', text: '共 3 个服务' },
    ] }),
  ]);
  watcher.loadFile(file('msg'));
  eq(findAgent(watcher, 'sess-msg').summary, '部署完成， 共 3 个服务');
});

test('无 assistant 消息时用 reasoning summary 兜底（去掉 ** 加粗）', () => {
  const { file, watcher } = makeCase();
  writeLines(file('reason'), [
    jline('session_meta', { session_id: 'sess-reason', cwd: '/w/r' }),
    jline('response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text: '**Planning** repo exploration' }] }),
  ]);
  watcher.loadFile(file('reason'));
  eq(findAgent(watcher, 'sess-reason').summary, 'Planning repo exploration');
});

test('lastAgentMessage 以 { 开头（guardian JSON 判定）时回退 reasoning 文本', () => {
  const { file, watcher } = makeCase();
  writeLines(file('guardian'), [
    jline('session_meta', { session_id: 'sess-guard', cwd: '/w/g' }),
    jline('response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Reviewing diff for secrets' }] }),
    jline('event_msg', { type: 'task_complete', last_agent_message: '{"verdict":"approve","reason":"ok"}' }),
  ]);
  watcher.loadFile(file('guardian'));
  const a = findAgent(watcher, 'sess-guard');
  eq(a.status, 'done');
  eq(a.summary, 'Reviewing diff for secrets', 'summary 应回退到 reasoning 文本');
});

test('无消息无 reasoning 但有工具调用时 summary 为「调用 xxx」', () => {
  const { file, watcher } = makeCase();
  writeLines(file('tool'), [
    jline('session_meta', { session_id: 'sess-tool', cwd: '/w/t' }),
    jline('response_item', { type: 'function_call', name: 'shell' }),
  ]);
  watcher.loadFile(file('tool'));
  eq(findAgent(watcher, 'sess-tool').summary, '调用 shell');
});

// ---------- 6. summary 截断 ----------
test('assistant 消息超长截断为 80 字符并带省略号', () => {
  const { file, watcher } = makeCase();
  writeLines(file('trunc'), [
    jline('session_meta', { session_id: 'sess-trunc', cwd: '/w/t' }),
    jline('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '喵'.repeat(200) }] }),
  ]);
  watcher.loadFile(file('trunc'));
  const a = findAgent(watcher, 'sess-trunc');
  eq(a.summary.length, 80, '截断后应为 80 个字符');
  assert(a.summary.endsWith('…'), '应以省略号结尾');
  assert(a.summary.startsWith('喵'.repeat(20)), '应保留开头内容');
});

test('正好 80 字符时不加省略号', () => {
  const { file, watcher } = makeCase();
  writeLines(file('trunc80'), [
    jline('session_meta', { session_id: 'sess-trunc80', cwd: '/w/t' }),
    jline('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '喵'.repeat(80) }] }),
  ]);
  watcher.loadFile(file('trunc80'));
  const a = findAgent(watcher, 'sess-trunc80');
  eq(a.summary.length, 80);
  assert(!a.summary.endsWith('…'), '长度未超不应加省略号');
});

test('reasoning 兜底按 60 字符截断', () => {
  const { file, watcher } = makeCase();
  writeLines(file('trunc-r'), [
    jline('session_meta', { session_id: 'sess-trunc-r', cwd: '/w/t' }),
    jline('response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text: 'R'.repeat(100) }] }),
    jline('event_msg', { type: 'task_complete', last_agent_message: '{"verdict":"x"}' }),
  ]);
  watcher.loadFile(file('trunc-r'));
  const a = findAgent(watcher, 'sess-trunc-r');
  eq(a.summary.length, 60, 'reasoning 截断后应为 60 个字符');
  assert(a.summary.endsWith('…'), '应以省略号结尾');
});

test('换行与连续空格被压缩为单个空格', () => {
  const { file, watcher } = makeCase();
  writeLines(file('ws'), [
    jline('session_meta', { session_id: 'sess-ws', cwd: '/w/t' }),
    jline('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '第一行\n\n第二行  继续' }] }),
  ]);
  watcher.loadFile(file('ws'));
  eq(findAgent(watcher, 'sess-ws').summary, '第一行 第二行 继续');
});

// ---------- 清理与汇总 ----------
try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* 尽力清理 */ }

const failed = results.filter((r) => !r.ok);
console.log(`\n共 ${results.length} 个用例：通过 ${results.length - failed.length}，失败 ${failed.length}`);
if (failed.length) {
  console.log('失败用例：');
  for (const r of failed) console.log(`  - ${r.name}\n      ${r.error.message}`);
  process.exitCode = 1;
}
