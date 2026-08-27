'use strict';
const petEl = document.getElementById('pet');
const petImg = document.getElementById('pet-img');
const bubble = document.getElementById('bubble');
const hintEl = document.getElementById('hint');

let agents = [];
let bubbleIdx = 0;
let mood = null;
let clickThrough = false;

const IMG_DIR = '../assets/cats';
const IMG_FILES = {
  idle: `${IMG_DIR}/idle.png`,
  working: `${IMG_DIR}/working.png`,
  done: `${IMG_DIR}/done.png`,
  error: `${IMG_DIR}/error.png`,
};

const STATUS_TEXT = {
  working: '努力干活中',
  done: '任务完成啦！',
  idle: '摸鱼打瞌睡',
  unknown: '待命中',
  error: '出问题了喵？！',
};

// 素材探测：立绘加载成功切图片模式，失败回退 CSS 兜底猫娘（自愈，素材后补也能切回图片模式）
petImg.onload = () => petEl.classList.add('has-img');
petImg.onerror = () => petEl.classList.remove('has-img');
petImg.src = IMG_FILES.idle;

function petMood(list) {
  if (list.some(a => a.status === 'working')) return 'working';
  if (list.some(a => a.status === 'done')) return 'done';
  if (list.some(a => a.status === 'error')) return 'error';
  return 'idle';
}

function setMood(m) {
  mood = m;
  petEl.className = `pet mood-${m}` + (petEl.classList.contains('has-img') ? ' has-img' : '');
  const src = IMG_FILES[m] || IMG_FILES.idle;
  if (petImg.getAttribute('src') !== src) petImg.src = src;
}

function updateBubble() {
  const visible = agents.filter(a => a.status !== 'idle');
  const show = visible.length ? visible : [];
  if (!show.length) {
    // 没有活跃 agent 时偶尔卖萌
    if (Math.random() < 0.3) {
      bubble.innerHTML = `<span class="who">猫娘</span> ${pickRandom(['主人~我在盯着哦', '咦？大家都睡了…', '喵？有新任务吗？'])}`;
      bubble.classList.remove('hidden');
    } else {
      bubble.classList.add('hidden');
    }
    return;
  }
  bubbleIdx %= show.length;
  const a = show[bubbleIdx];
  const status = STATUS_TEXT[a.status] || a.status;
  bubble.innerHTML = `<span class="who">${escapeHtml(a.originator || 'codex')}·${escapeHtml(a.project || '?')}</span> ${status}<br/>${escapeHtml(a.summary || '')}`;
  bubble.classList.remove('hidden');
}

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

window.nyaPet.onAgentsUpdate((list) => {
  agents = list;
  setMood(petMood(list));
  updateBubble();
});

// 轮播气泡（多个 agent 时）
setInterval(() => {
  const visible = agents.filter(a => a.status !== 'idle');
  if (visible.length > 1) { bubbleIdx++; updateBubble(); }
}, 6000);

// 单击详情，双击切换点击穿透
// 标准做法：单击先挂 300ms 定时器，双击到来时取消定时器，避免双击前触发两次单击
let clickTimer = null;
petEl.addEventListener('click', (e) => {
  if (e.detail !== 1) return; // 双击的第二次 click 不再当单击处理
  clickTimer = setTimeout(() => {
    clickTimer = null;
    window.nyaPet.openDetail();
  }, 300);
});
petEl.addEventListener('dblclick', () => {
  if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; } // 取消待执行的单击
  clickThrough = !clickThrough;
  window.nyaPet.toggleClickThrough(clickThrough);
  hintEl.textContent = clickThrough ? '穿透中（双击恢复）' : '双击穿透 · 单击详情';
});
// 托盘菜单也能切换穿透（穿透开启后窗口收不到鼠标，只能从托盘恢复），此处同步状态与文案
window.nyaPet.onClickThroughChanged((enabled) => {
  clickThrough = enabled;
  hintEl.textContent = clickThrough ? '穿透中（双击恢复）' : '双击穿透 · 单击详情';
});
bubble.addEventListener('click', () => window.nyaPet.openDetail());

// 初始占位
updateBubble();
