/**
 * models.mjs —— 模型通道：一个"OpenAI 兼容"的聊天客户端。
 *
 * 为什么只做 OpenAI 兼容这一种：千问（compatible-mode）、DeepSeek、以及绝大多数
 * 国内厂商都提供这个形状；一个适配器就能让"每个机器人接不同模型"成立。
 * 真遇到非兼容的厂商，再加一个 kind 分支即可，不影响上层。
 *
 * 这里刻意做得**保守**：
 *   · 默认不流式（少一层出错面）；需要流式时再开
 *   · 超时/重试/降级都显式配置，重试次数写进日志
 *   · 用量（tokens）记下来，方便老板看"这个机器人今天花了多少"
 */
import { appendLog, stamp } from './util.mjs';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 120000;

/**
 * 找 DSH 本体（可移植：**不再写死作者机器的路径**）。
 * 顺序：环境变量 → 配置里该通道的 `dshExe` → 常见安装位置。
 * 一条都找不到就抛带解决方案的错误（而不是让机器人莫名其妙不回话）。
 */
const DSH_EXE_CANDIDATES = [
  process.env.DSH_EXE,
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
].filter(Boolean);

function resolveLocal() {
  try { return JSON.parse(fs.readFileSync(path.join(process.env.BOTHUB_HOME || path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '')), '..'), 'config', 'local.json'), 'utf8')); } catch { return {}; }
}

function resolveDshExe(channel) {
  // 顺序：配置里该通道 → 环境变量 → **本机私有文件 config\local.json**（不进版本库）→ 常见安装位置
  const cands = [channel && channel.dshExe, ...DSH_EXE_CANDIDATES, resolveLocal().dshExe].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch { /* ignore */ } }
  return null;
}

/** DSH 的 CLI 入口：优先环境变量，其次按 exe 的位置推出来（安装目录里就带着） */
/**
 * ── 列出 DSH 能用的模型（老板："模型我希望和 DSH 对话框里一样可以手动选"）──
 *
 * 做法：让 DSH 自己把**组合后的配置**打印出来（`--dump-config`），从里面把
 * `llm-pi-ai.config.providers.<供应商>.models[]` 抠出来 —— 这样**他装了什么插件、
 * 有什么免费模型，列表里就有什么**（别人下载后看到的也是他自己 DSH 的清单）。
 *
 * ⚠️ 不引 YAML 库（BotHub 只有两个依赖），用**按缩进的块扫描**：
 *    先找 `providers:` 那一行，再只认它下面 +2 缩进的键（供应商）和更深的 `- id:`（模型）。
 *    第一版用固定缩进的正则，被"别处的 models:"带跑偏了。
 */
/**
 * 兜底：有些 profile（例如 `desktop`）被 Electron 独占，**不给 dump-config**
 * （会回 "managed exclusively by the Electron application"）。
 * 那就静态扫它自己的 patch 文件（profile 的 + 各插件自带的），把 `provider:` / `model:` 组合抠出来。
 * 扫不到模型清单，只能知道"默认用哪个"—— 但总比这个 profile 完全不可见好。
 */
export function scanProfilePatches(dshHome, profile) {
  const dir = path.join(dshHome, 'profiles', profile);
  const files = [];
  const push = (f) => { try { if (fs.existsSync(f)) files.push(f); } catch { /* ignore */ } };
  push(path.join(dir, 'cordis.patch.yml'));
  try {
    for (const d of fs.readdirSync(path.join(dir, 'node_modules'), { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue;
      push(path.join(dir, 'node_modules', d.name, 'cordis.patch.yml'));
    }
  } catch { /* 没有 node_modules 很正常 */ }
  const pairs = new Map();   // provider -> Set(model)
  for (const f of files) {
    let txt = '';
    try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    let cur = null;
    for (const l of txt.split(/\r?\n/)) {
      const mp = /^\s*provider:\s*([\w.@-]+)\s*$/.exec(l);
      const mm = /^\s*model:\s*([\w.@/.-]+)\s*$/.exec(l);
      const ml = /^\s*models:\s*$/.exec(l);
      if (mp) { cur = mp[1]; if (!pairs.has(cur)) pairs.set(cur, new Set()); continue; }
      if (cur && mm) pairs.get(cur).add(mm[1]);
      if (ml && cur) { /* 下面是列表，交给 dumps 正则；这里只记 provider */ }
    }
  }
  return [...pairs.entries()].map(([id, models]) => ({ id, displayName: null, baseURL: null, models: [...models], fromPatch: true }));
}
export function listDshProviders(profile = 'headless', exe = null) {
  const dshExe = exe || resolveDshExe({});
  if (!dshExe) return { ok: false, error: '找不到 DSH 本体', providers: [] };
  const cli = resolveDshCli(dshExe);
  return new Promise((resolve) => {
    execFile(dshExe, ['--expose-internals', cli, '--profile', profile, '--dump-config'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true, timeout: 60000, maxBuffer: 8 << 20, encoding: 'utf8',
    }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: String(err.message).slice(0, 200), providers: [] });
      const lines = String(stdout).split(/\r?\n/).map((l) => l.replace(/\t/g, '  '));
      const indentOf = (l) => (l.match(/^\s*/) || [''])[0].length;
      const found = [];
      for (let i = 0; i < lines.length; i++) {
        if (!/^\s*providers:\s*$/.test(lines[i])) continue;
        const base = indentOf(lines[i]);
        let cur = null;
        for (let j = i + 1; j < lines.length; j++) {
          const l = lines[j];
          if (!l.trim()) continue;
          const ind = indentOf(l);
          if (ind <= base) break;
          const mKey = new RegExp('^\\s{' + (base + 2) + '}([\\w.@-]+):\\s*$').exec(l);
          if (mKey) { cur = { id: mKey[1], displayName: null, baseURL: null, models: [] }; found.push(cur); continue; }
          if (!cur) continue;
          const mName = new RegExp('^\\s{' + (base + 4) + '}displayName:\\s*(.+)$').exec(l);
          if (mName) { cur.displayName = mName[1].trim().replace(/^["']|["']$/g, ''); continue; }
          const mUrl = new RegExp('^\\s{' + (base + 4) + '}baseURL:\\s*(.+)$').exec(l);
          if (mUrl) { cur.baseURL = mUrl[1].trim(); continue; }
          const mModel = /-\s*id:\s*([^\s]+)/.exec(l);
          if (mModel && ind >= base + 4) cur.models.push(mModel[1].replace(/^["']|["']$/g, ''));
        }
      }
      const map = new Map();
      for (const p of found) map.set(p.id, { ...p, models: [...new Set(p.models)] });
      const providers = [...map.values()].filter((p) => p.models.length);
      resolve({ ok: true, profile, providers });
    });
  });
}

/** DSH 的权限预设：sandbox 与 approval **必须成对**（实测：read-only+never 会被 permission 插件直接判错） */
export const PERMISSION_PRESETS = {
  'read-only': { sandbox: 'read-only', approval: 'ask' },
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
};

/** 「只聊天」时要关掉的工具插件（关掉之后它只会说话、不动手） */
const TOOL_PLUGINS = [
  'tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search', 'tool-skill', 'tool-web',
  'tool-workflow', 'tool-todo', 'tool-goal', 'tool-ralph', 'tool-jobs',
  'tool-subagent', 'tool-subagent-fork', 'tool-subagent-control', 'tool-subagent-list-agents',
];

/**
 * 生成"这个机器人专属"的 patch（**不改老板的 profile 配置**）。三件事可任意组合：
 *   · 模型 / 供应商 / 推理等级 → 覆盖 `agent-default-model`
 *   · 权限（只读 / 可写自己目录 / 完全放开）→ 覆盖 `sandbox-policy` + `approval`（成对预设）
 *   · 不给工具 → 把 tool-* 插件 `disabled: true`
 * 返回 true = 文件写成功（调用方据此决定加不加 `--patch`）。
 */
/**
 * 读这个 profile 的**默认模型**（`agent-default-model` 的 provider/model）。
 *
 * ⛔ 为什么必须有：patch 里**只写 `reasoningEffort` 会让插件加载失败**
 *   （实测报 `Plugin Missing services | headless-runner (required) agentDefaultModel`），
 *   于是那一层 patch 整个作废、我加的"退回默认"兜底又把推理等级丢了。
 *   所以设推理等级时必须**连 provider/model 一起写**。
 */
export function dshDefaultModel(profile = 'headless', exe = null) {
  const dshExe = exe || resolveDshExe({});
  if (!dshExe) return null;
  const cli = resolveDshCli(dshExe);
  return new Promise((resolve) => {
    execFile(dshExe, ['--expose-internals', cli, '--profile', profile, '--dump-config'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 60000, maxBuffer: 8 << 20, encoding: 'utf8',
    }, (err, stdout) => {
      if (err) return resolve(null);
      const lines = String(stdout).split(/\r?\n/);
      const i = lines.findIndex((l) => /^\s*-\s*id:\s*agent-default-model\s*$/.test(l));
      if (i < 0) return resolve(null);
      let provider = null, model = null;
      for (let j = i + 1; j < Math.min(i + 14, lines.length); j++) {
        const mp = /^\s*provider:\s*([\w.@-]+)\s*$/.exec(lines[j]);
        const mm = /^\s*model:\s*([\w.@/.-]+)\s*$/.exec(lines[j]);
        if (mp) provider = mp[1];
        if (mm) model = mm[1];
        if (/^\s*-\s*id:/.test(lines[j])) break;
      }
      resolve(provider || model ? { provider, model } : null);
    });
  });
}
export function writeModelPatch(file, opts = {}) {
  const { provider, model, reasoningEffort, permission, noTools } = opts;
  const lines = ['# BotHub 自动生成：这个机器人的模型 / 推理等级 / 权限（不改你的 profile 配置）'];
  if (provider || model || reasoningEffort) {
    lines.push('- id: agent-default-model', '  name: "@deepseek-ai/dsh-agent-default-model"', '  config:');
    if (provider) lines.push(`    provider: ${provider}`);
    if (model) lines.push(`    model: ${model}`);
    if (reasoningEffort) lines.push(`    reasoningEffort: ${reasoningEffort}`);
  }
  const preset = PERMISSION_PRESETS[permission];
  if (preset) {
    lines.push(
      '- id: sandbox-policy', '  name: "@deepseek-ai/dsh-sandbox-policy"', '  config:', `    mode: ${preset.sandbox}`,
      '- id: approval', '  name: "@deepseek-ai/dsh-user-approval"', '  config:', `    policy: ${preset.approval}`,
    );
  }
  if (noTools) for (const id of TOOL_PLUGINS) lines.push(`- id: ${id}`, '  disabled: true');
  lines.push('');
  try { fs.writeFileSync(file, lines.join('\n'), 'utf8'); return true; } catch { return false; }
}
function resolveDshCli(exe) {
  if (process.env.DSH_CLI_JS) return process.env.DSH_CLI_JS;
  const rel = ['resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'];
  const guesses = [];
  if (exe) guesses.push(path.join(path.dirname(exe), ...rel));
  for (const g of guesses) { try { if (fs.existsSync(g)) return g; } catch { /* ignore */ } }
  return guesses[0];
}


/**
 * ★ `kind: "dsh"` —— 把一条消息交给 **DSH 本体**去办，而不是普通模型通道。
 *
 * 为什么要有这个：普通通道只是"聊天"（会说话，不会干活）。DSH 那套是**会干活的**
 * ——能读文件、跑命令、用技能、翻资料。所以某个机器人可以绑这个通道，
 * 变成"能替你办事的机器人"，而不是"会聊天的机器人"。
 *
 * 实现要点：
 *   · 起一次 `dsh --profile <p> --json <任务>`，读 NDJSON 事件流拿**最终回答**和**会话 id**
 *   · 有会话 id 就带 `--session-id` 续聊 —— 于是**每个 QQ 对话对象有自己的 DSH 会话**（上下文不串）
 *   · 超时就杀进程（不能让一次卡死把队列堵死）
 */
function runDsh(channel, messages, opts = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const task = String(lastUser?.content || '');
    const profile = channel.profile || 'headless';
    const dshExe = resolveDshExe(channel);
    if (!dshExe) {
      return resolve({
        text: '⚠️ 找不到 DSH 本体（DeepSeek Harness.exe）。请在 `config\\bots.json` 里给这个通道加一项 ' +
              '`"dshExe": "…\\DeepSeek Harness.exe"`，或者设个环境变量 `DSH_EXE`。',
        error: 'DSH_EXE_NOT_FOUND',
      });
    }
    const dshCli = resolveDshCli(dshExe);
    // 这个机器人专属的覆盖（模型 / 推理等级 / 权限 / 不给工具）→ 一份 patch（**不动老板的 profile 配置**）
    const patchArgs = [];
    if (opts.modelOverride && opts.modelOverride.file) {
      if (writeModelPatch(opts.modelOverride.file, opts.modelOverride)) {
        patchArgs.push('--patch', opts.modelOverride.file);
      }
    }
    // ⛔ `--patch` 是**启动器参数**，必须在 `--profile` 之前 —— 放到后面 DSH 会报
    //    `unknown option '--patch'`（实测踩过：调用直接退出码 1）。
    const args = ['--expose-internals', dshCli, ...patchArgs, '--profile', profile, '--json'];
    if (opts.dshSessionId) args.push('--session-id', opts.dshSessionId);
    args.push(task);

    const child = spawn(dshExe, args, {
      cwd: opts.cwd || channel.cwd || process.cwd(),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
    });

    let out = '';
    let err = '';
    let sessionId = null;
    let finalText = null;
    let usage = null;
    let textParts = [];
    let killed = false;

    const timeoutMs = opts.timeoutMs || channel.timeoutMs || 180000;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      out += d.toString();
      let idx;
      while ((idx = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, idx).trim();
        out = out.slice(idx + 1);
        if (!line) continue;
        try {
          const e = JSON.parse(line);
          if (e.type === 'session' && e.sessionId) sessionId = e.sessionId;
          else if (e.type === 'final' && typeof e.text === 'string') finalText = e.text;
          else if (e.type === 'text' && typeof e.text === 'string') textParts.push(e.text);
          else if (e.type === 'status' && e.phase === 'step_end' && e.usage) usage = e.usage;
        } catch { /* 非 JSON 行忽略 */ }
      }
    });
    child.stderr.on('data', (d) => { err += d.toString(); });

    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ text: null, usage: null, ms: Date.now() - t0, raw: null, error: new Error('起 DSH 失败：' + e.message) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        appendLog('app.log', `[${stamp()}] WARN  dsh 通道超时被杀（${profile}，${Math.round(timeoutMs / 1000)}s）`);
        return resolve({ text: null, usage: null, ms: Date.now() - t0, raw: null, error: new Error(`DSH 超过 ${Math.round(timeoutMs / 1000)} 秒没干完，已中断`) });
      }
      const text = (finalText ?? textParts.join('')).trim();
      if (code !== 0 || !text) {
        const hint = (err || out).split(/\r?\n/).filter(Boolean).slice(-3).join(' | ').slice(0, 300);
        /**
         * ★ 退回默认模型（2026-10-15，老板明确要的兜底）：
         *   如果这次是**面板上钉住的模型**失败了（额度用尽 / 该供应商不可用 / 模型下线），
         *   就**去掉 patch 再试一次** —— 于是这次请求落回 DSH 的默认模型（也是免费插件都不可用时的退路）。
         *   只重试一次，并且如实标记 `fellBackToDefault`，好让上层能告诉对方"这次用的是默认模型"。
         */
        /**
         * ★ 退回策略是**两级**的（2026-10-15 实测修出来的）：
         *   ① 如果错因是"这个模型不支持推理等级"（`UNSUPPORTED_REASONING_EFFORT`，例如 qwen3.8-flash），
         *      就**只丢掉推理等级**再试一次 —— 模型和权限都保留（退到默认模型是过头的）。
         *   ② 其它失败（额度用尽 / 供应商不可用 / 模型下线）才**去掉整份 patch**，
         *      落回 DSH 的默认模型（也是免费插件都不可用时的退路）。
         *   两级都只重试一次，并如实标记，好让上层能解释发生了什么。
         */
        if (patchArgs.length && opts._noFallback !== true) {
          const unsupportedEffort = /UNSUPPORTED_REASONING_EFFORT|does not support reasoning effort/i.test(String(hint));
          if (unsupportedEffort && opts.modelOverride && opts.modelOverride.reasoningEffort) {
            appendLog('app.log', `[${stamp()}] WARN  这个模型不支持推理等级，丢掉它重试（${String(hint).slice(0, 100)}）`);
            const retry = { ...opts, modelOverride: { ...opts.modelOverride, reasoningEffort: null }, _noFallback: true };
            return resolve(runDsh(channel, messages, retry).then((r) => ({ ...r, reasoningDropped: true })));
          }
          appendLog('app.log', `[${stamp()}] WARN  钉住的模型失败，退回 DSH 默认模型重试一次（${String(hint).slice(0, 120)}）`);
          const retryOpts = { ...opts, modelOverride: null, _noFallback: true };
          return resolve(
            runDsh(channel, messages, retryOpts).then((r) => ({
              ...r,
              fellBackToDefault: true,
              pinnedModelFailed: true,
              error: r.error,   // 重试还是失败就如实报错
            })),
          );
        }
        return resolve({ text: null, usage: null, ms: Date.now() - t0, raw: { code, sessionId }, error: new Error(`DSH 退出码 ${code}${hint ? '：' + hint : ''}`) });
      }
      resolve({ text, usage, ms: Date.now() - t0, raw: { code, sessionId }, error: null, sessionId });
    });
  });
}

/** 一次补全。返回 { text, usage, ms, error } */
export async function chat(channel, messages, opts = {}) {
  const t0 = Date.now();

  if (channel.kind === 'dsh') {
    /**
     * ⛔ 只给了推理等级（没钉模型）时**必须补上** profile 的 provider/model：
     *    否则 patch 里只有 `reasoningEffort`，`agent-default-model` 插件加载会失败
     *    （实测报 `Plugin Missing services | headless-runner (required) agentDefaultModel`），推理等级等于白设。
     *    放在这里是因为 `chat()` 是 async；`runDsh` 是回调式的，那边 await 会报 "Unexpected reserved word"。
     */
    if (opts.modelOverride && opts.modelOverride.reasoningEffort && (!opts.modelOverride.provider || !opts.modelOverride.model)) {
      const def = await dshDefaultModel(channel.profile || 'headless', channel.dshExe);
      if (def) {
        opts = {
          ...opts,
          modelOverride: {
            ...opts.modelOverride,
            provider: opts.modelOverride.provider || def.provider,
            model: opts.modelOverride.model || def.model,
          },
        };
      }
    }
    return runDsh(channel, messages, opts);
  }

  /**
   * ★ `kind: "echo"` —— 本地假通道，专门用来做**确定性测试**：
   *   · 不花额度、不依赖网络，就能验证"排队回执 / 超时释放锁 / 多机器人隔离"这些逻辑
   *   · `delayMs` 可以造出"处理很久"的场景，用来复现"上一轮没结束时又发消息"
   * 今天在旧机器人上吃的亏就是：**这些逻辑从来没被真跑过**，出事只能靠现场猜。
   */
  if (channel.kind === 'echo') {
    const last = [...messages].reverse().find((m) => m.role === 'user');
    const delay = Number(opts.delayMs ?? channel.delayMs ?? 0);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    // `fail: true` 造"模型通道全挂"的场景（配额用尽 / 网络断 / 服务端 5xx）
    if (channel.fail) return { text: null, usage: null, ms: Date.now() - t0, raw: null, error: new Error(channel.failMessage || '模拟的模型故障：全部重试都失败') };
    return { text: `${channel.prefix || 'echo'}: ${String(last?.content || '').slice(0, 200)}`, usage: null, ms: Date.now() - t0, raw: null, error: null };
  }

  const url = channel.baseURL.replace(/\/+$/, '') + '/chat/completions';
  const body = {
    model: opts.model || channel.model,
    messages,
    temperature: opts.temperature ?? channel.temperature ?? 0.7,
    max_tokens: opts.maxTokens ?? channel.maxTokens ?? 2048,
    stream: false,
  };
  const retries = Number.isFinite(opts.retries) ? opts.retries : 2;
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs || channel.timeoutMs || DEFAULT_TIMEOUT_MS);
    /**
     * ★ 外部中断也要能掐断请求：队列判定"这条处理超时"时会调 task.onTimeout()，
     *   如果不把那个信号接进来，请求会继续跑完 —— **额度照花、结果没人要**。
     *   （这个坑今天在旧机器人上见过：回合被放弃了，模型其实还在算。）
     */
    const signal = opts.signal && typeof AbortSignal !== 'undefined' && AbortSignal.any
      ? AbortSignal.any([ac.signal, opts.signal])
      : ac.signal;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${channel._key}`,
        },
        body: JSON.stringify(body),
        signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      if (!res.ok) {
        // 4xx 里除了 429 基本重试没用；5xx / 429 值得重试
        const retryable = res.status === 429 || res.status >= 500;
        lastErr = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
        if (!retryable || attempt === retries) break;
        appendLog('app.log', `[${stamp()}] WARN  模型通道 ${channel.id} 第 ${attempt + 1} 次失败（${res.status}），重试`);
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        continue;
      }
      let json;
      try { json = JSON.parse(text); } catch (e) { lastErr = new Error('返回不是 JSON：' + text.slice(0, 200)); break; }
      const msg = json.choices?.[0]?.message;
      const out = (msg?.content ?? '').trim();
      if (!out) { lastErr = new Error('模型返回了空内容'); break; }
      return { text: out, usage: json.usage || null, ms: Date.now() - t0, raw: json, error: null };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      const again = attempt < retries;
      appendLog('app.log', `[${stamp()}] WARN  模型通道 ${channel.id} 第 ${attempt + 1} 次异常：${e.message}${again ? '，重试' : ''}`);
      if (!again) break;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  return { text: null, usage: null, ms: Date.now() - t0, raw: null, error: lastErr || new Error('未知错误') };
}
