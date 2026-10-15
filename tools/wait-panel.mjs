#!/usr/bin/env node
/**
 * wait-panel.mjs —— 等面板能应答（最多 60 秒）+ **动态启动提示**，给双击启动器用。
 *
 * 老板要求：「加个动态图标显示正在启动」。
 * 在**终端**上打一个转圈的动画（只在 TTY 上打），结论同时写一行进启动日志。
 * 退出码 0 = 面板通了；1 = 超时（启动器会照样开窗口，页面上会自己显示连不上）。
 */
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const LOGDIR = path.join(HERE, '..', 'data', 'logs');
const PORT = Number(process.env.BOTHUB_PORT) || 7788;
const URL_ = `http://127.0.0.1:${PORT}/api/health`;
const t0 = Date.now();
const tty = process.stdout.isTTY;
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];   // 转圈
const STEPS = [
  [0, '正在检查守护进程'],
  [3, '正在启动应用'],
  [10, '正在等面板应答'],
  [25, '还在启动（第一次会慢一点）'],
  [45, '快好了'],
];

function logLine(s) {
  try {
    fs.mkdirSync(LOGDIR, { recursive: true });
    fs.appendFileSync(path.join(LOGDIR, 'launcher.log'), `[${new Date().toLocaleString()}] wait-panel: ${s}\n`, 'utf8');
  } catch { /* 日志写不进去也不影响启动 */ }
}

function draw(i, note) {
  if (!tty) return;
  const spin = FRAMES[i % FRAMES.length];
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  process.stdout.write(`\r  ${spin}  ${note}…  ${sec}s   `);
}

let ok = false;
for (let i = 0; i < 60; i++) {
  const note = (STEPS.filter(([at]) => i >= at).pop() || STEPS[0])[1];
  draw(i, note);
  try {
    const r = await fetch(URL_, { signal: AbortSignal.timeout(2000) });
    if (r.ok || r.status === 503) { ok = true; break; }
  } catch { /* 还没起来 */ }
  await new Promise((r) => setTimeout(r, 1000));
}
const sec = ((Date.now() - t0) / 1000).toFixed(1);
if (tty) process.stdout.write('\r' + ' '.repeat(70) + '\r');
if (ok) {
  console.log(`  ✅ 启动完成（等了 ${sec} 秒）—— 正在打开面板…`);
  logLine(`面板已就绪（${sec}s）`);
  process.exit(0);
}
console.log('  ⚠️ 60 秒面板还没应答 —— 照样开窗口，页面上会显示"连不上"');
logLine('超时：60 秒面板没应答');
process.exit(1);
