#!/usr/bin/env node
/**
 * open-window.mjs —— 打开应用窗口，但**已经有就不重复开**。
 *
 * 为什么：双击图标时如果无脑 `start msedge --app=...`，点几次就攒几个窗口
 * （老板已经因为"关也关不了"抱怨过一次了，不能再让他面对一堆窗口）。
 *
 * 判据用**结构特征**：`Name='msedge.exe'` 且命令行含 `--app=http://127.0.0.1:7788`。
 * ⚠️ 不能拿"命令行包含某个字符串"去匹配所有进程 —— 我这条 node 命令自己就含那个串，
 *    会被自己匹配上（今天为这类自匹配栽过 4 次）。限定 Name 就没这个问题。
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const PORT = Number(process.env.BOTHUB_PORT) || 7788;
const URL_ = `http://127.0.0.1:${PORT}/`;
const EDGES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const PWSH = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

function ps(script) {
  return new Promise((resolve) => {
    execFile(PWSH, ['-NoProfile', '-NonInteractive', 'ExecutionPolicy' === '' ? '' : '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 20000, windowsHide: true, encoding: 'utf8' },
      (err, out) => resolve(err ? '' : String(out || '').trim()));
  });
}

const existing = await ps(`@(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*--app=http://127.0.0.1:${PORT}*' }).Count`);
if (Number(existing || 0) > 0) {
  console.log(`应用窗口已经开着（${existing} 个），不再重复开`);
  process.exit(0);
}

const edge = EDGES.find((p) => fs.existsSync(p));
if (!edge) {
  console.log('找不到 Edge，改用默认浏览器打开');
  spawn('cmd.exe', ['/c', 'start', '', URL_], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  process.exit(0);
}

const child = spawn(edge, [
  `--app=${URL_}`,
  '--window-size=960,700',
  `--user-data-dir=${path.join(ROOT, 'data', 'edge-profile')}`,
  '--no-first-run', '--no-default-browser-check',
], { detached: true, stdio: 'ignore', windowsHide: true });
child.unref();
console.log('已打开应用窗口');
