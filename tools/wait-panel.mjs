#!/usr/bin/env node
/**
 * wait-panel.mjs —— 等面板能应答（最多 60 秒），给双击启动器用。
 *
 * 为什么要有它：双击图标时要"先确保应用在跑、再开窗口"，
 * 否则会出现一个"连接不上"的白屏窗口 —— 那看起来就像程序坏了。
 * 退出码 0 = 面板通了；1 = 超时（启动器会照样开窗口，页面上会自己显示连不上）。
 */
const PORT = Number(process.env.BOTHUB_PORT) || 7788;
const URL_ = `http://127.0.0.1:${PORT}/api/health`;
const t0 = Date.now();

for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(URL_, { signal: AbortSignal.timeout(2000) });
    if (r.ok || r.status === 503) { console.log(`面板已就绪（等了 ${Date.now() - t0} ms）`); process.exit(0); }
  } catch { /* 还没起来 */ }
  await new Promise((r) => setTimeout(r, 1000));
}
console.log('等 60 秒面板还没应答 —— 照样开窗口，页面上会显示"连不上"');
process.exit(1);
