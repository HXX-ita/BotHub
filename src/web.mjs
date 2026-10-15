/**
 * web.mjs —— 本机面板 + 状态接口（只用 node:http，零依赖）。
 *
 *   GET  /                     面板（深色，5 秒自动刷新）
 *   GET  /api/status           机器人们的实时状态（含队列、计数、最后消息时间）
 *   GET  /api/logs?bot=&tail=  某个机器人的日志尾巴（排障用）
 *   POST /api/bots/<id>/restart  重启某个机器人
 *   GET  /api/health           给守护进程/看门狗用的轻量探针
 *
 * 只监听 127.0.0.1，默认不开外网。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { LOGDIR, appendLog, stamp } from './util.mjs';

/**
 * 界面单独放在 `src/ui.html`，**不再塞在 JS 模板字符串里**。
 * 为什么改：以前整页 HTML 是个模板常量，里面每个 ${} 和反引号都得转义，
 * 改一句界面要数半天括号（我改错过）。现在当成普通网页文件，编辑器能高亮、能查错。
 * 每次请求都重新读，所以改界面**不用重启应用**，刷新页面就行。
 */
const UI_PATH = new URL('./ui.html', import.meta.url);
function uiHtml() {
  try { return fs.readFileSync(UI_PATH, 'utf8'); }
  catch (e) { return '<!doctype html><meta charset="utf-8"><h1>界面文件读不到</h1><p>' + String(e.message) + '</p>'; }
}

export function startWeb({ port, host, hub, log }) {
  const json = (res, obj, code = 200) => {
    const body = JSON.stringify(obj, null, 2);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(body);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        /**
         * ⛔ 一定要禁缓存！老板连着两轮说"画面还是一闪一闪的 / 日志不稳定"，
         *    而我明明已经修了 —— 真因是**浏览器一直在用缓存里的旧界面**：
         *    这里原来只发 content-type，没有任何缓存头，浏览器就按"启发式缓存"留住旧 HTML。
         *    面板是本地服务、每次读磁盘（秒开），禁缓存没有任何代价。
         */
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
          pragma: 'no-cache',
          expires: '0',
        });
        return res.end(uiHtml());
      }
      if (url.pathname === '/api/status') return json(res, hub.status());
      if (url.pathname === '/api/host') return json(res, await hub.hostInfo());
      if (url.pathname === '/api/health') {
        const s = hub.status();
        const worst = s.bots.find((b) => !b.running);
        return json(res, { ok: !worst, uptimeSec: s.uptimeSec, bots: s.bots.map((b) => ({ id: b.id, running: b.running, lastMessageSecAgo: b.lastMessageSecAgo })) }, worst ? 503 : 200);
      }
      if (url.pathname === '/api/logs') {
        const bot = url.searchParams.get('bot') || '';
        const tail = Math.min(Number(url.searchParams.get('tail')) || 120, 2000);
        const file = path.join(LOGDIR, bot ? `bot-${bot}.log` : 'app.log');
        let lines = '';
        try {
          const all = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
          lines = all.slice(-tail).join('\n');
        } catch { lines = ''; }
        return json(res, { file, lines });
      }
      const m = /^\/api\/bots\/([^/]+)\/restart$/.exec(url.pathname);
      if (req.method === 'POST' && m) {
        const r = await hub.restartBot(decodeURIComponent(m[1]));
        return json(res, r, r.ok ? 200 : 404);
      }
      // ── 维护：会话上下文 / 后台内存 / 数据占用 ──
      if (req.method === 'GET' && url.pathname === '/api/maintenance') {
        return json(res, { ok: true, ...hub.maintenance() });
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/maintenance/')) {
        let body = '';
        for await (const chunk of req) body += chunk;
        let payload = {};
        try { payload = JSON.parse(body || '{}'); } catch { return json(res, { ok: false, error: 'body 不是合法 JSON' }, 400); }
        const what = url.pathname.slice('/api/maintenance/'.length);
        try {
          if (what === 'gc') return json(res, hub.gc());
          if (what === 'sessions/compact') return json(res, await hub.compactSessions(payload));
          if (what === 'sessions/clear') return json(res, hub.clearSessions(payload));
          if (what === 'logs/prune') return json(res, hub.pruneLogs(payload));
          if (what === 'browser/clear') return json(res, hub.clearBrowserCache());
          return json(res, { ok: false, error: '不认识的维护动作：' + what }, 404);
        } catch (e) {
          log.error(`维护动作 ${what} 失败：${e && e.message}`);
          return json(res, { ok: false, error: String(e && e.message) }, 500);
        }
      }
      // 这个机器人能选的模型（跟 DSH 对话框一样可选）
      if (req.method === 'GET' && url.pathname === '/api/models') {
        const botId = url.searchParams.get('bot') || [...hub.botIds][0];
        return json(res, await hub.listModels(botId));
      }
      // 机器人资料（平台侧名字/头像，只读）；?force=1 才真去问平台
      const prof = /^\/api\/bots\/([^/]+)\/profile$/.exec(url.pathname);
      if (req.method === 'GET' && prof) {
        const r = await hub.botProfile(decodeURIComponent(prof[1]), { force: url.searchParams.get('force') === '1' });
        return json(res, r, r.ok ? 200 : 400);
      }
      // 设置/轮换凭据（值只往文件里写，不回显、不进日志）
      const cred = /^\/api\/bots\/([^/]+)\/credentials$/.exec(url.pathname);
      if (req.method === 'POST' && cred) {
        let body = '';
        for await (const chunk of req) body += chunk;
        let payload = {};
        try { payload = JSON.parse(body || '{}'); } catch { return json(res, { ok: false, error: 'body 不是合法 JSON' }, 400); }
        const r = await hub.setCredentials(decodeURIComponent(cred[1]), payload);
        // ⚠️ 这里**绝不能**把 payload 写进日志 —— 里面是 appSecret
        log.info(`凭据更新请求：${cred[1]} → ${r.ok ? '成功' : '失败（' + String(r.error).slice(0, 60) + '）'}`);
        return json(res, r, r.ok ? 200 : 400);
      }
      // 让机器人主动说一句（出站链路验证）
      const say = /^\/api\/bots\/([^/]+)\/say$/.exec(url.pathname);
      if (req.method === 'POST' && say) {
        let body = '';
        for await (const chunk of req) body += chunk;
        let payload = {};
        try { payload = JSON.parse(body || '{}'); } catch { return json(res, { ok: false, error: 'body 不是合法 JSON' }, 400); }
        const r = await hub.sayBot(decodeURIComponent(say[1]), payload);
        return json(res, r, r.ok ? 200 : 400);
      }
      // 断线重连演练：掐断连接，看它自己接不接得回来
      const kick = /^\/api\/bots\/([^/]+)\/kick$/.exec(url.pathname);
      if (req.method === 'POST' && kick) {
        const r = hub.kickBot(decodeURIComponent(kick[1]));
        return json(res, r, r.ok ? 200 : 400);
      }
      // 假机器人注入（验收测试用；真机器人会返回 400）
      const inj = /^\/api\/bots\/([^/]+)\/inject$/.exec(url.pathname);      if (req.method === 'POST' && inj) {
        let body = '';
        for await (const chunk of req) body += chunk;
        let payload = {};
        try { payload = JSON.parse(body || '{}'); } catch { return json(res, { ok: false, error: 'body 不是合法 JSON' }, 400); }
        const r = await hub.injectBot(decodeURIComponent(inj[1]), payload);
        return json(res, r, r.ok ? 200 : 400);
      }
      if (url.pathname === '/api/outbox') {
        const bot = url.searchParams.get('bot') || '';
        return json(res, { outbox: hub.outbox(bot) });
      }
      // ── 面板改配置：读原文 / 保存（先校验再落盘，失败回滚） / 重启应用 ──
      /**
       * 新增空白机器人 / 新增凭证 / 保存凭证值。
       * ⚠️ 读请求体的写法跟别的 POST 路由一致（本地 `for await (const chunk of req)`）——
       *    web.mjs 里那个 `body` 是 `json()` 内部的**响应体字符串**，不是读请求的函数（我第一次就写错了）。
       */
      {
        const readJsonBody = async () => { let raw = ''; for await (const chunk of req) raw += chunk; return JSON.parse(raw || '{}'); };
        if (req.method === 'POST' && url.pathname === '/api/bots/new') {
          return json(res, await hub.addBot(await readJsonBody()));
        }
        if (req.method === 'POST' && url.pathname === '/api/credentials/new') {
          return json(res, await hub.addCredential(await readJsonBody()));
        }
        const cv = /^\/api\/credentials\/([^/]+)\/values$/.exec(url.pathname);
        if (req.method === 'POST' && cv) {
          const r = await hub.saveCredentialValues(decodeURIComponent(cv[1]), await readJsonBody());
          return json(res, r, r.ok ? 200 : 400);   // ⚠️ 绝不把 payload 写日志（里面有 appSecret）
        }
      }
      // 面板偏好：颜色模式（浅色 / 深色 / 跟随 DSH）
      if (req.method === 'GET' && url.pathname === '/api/prefs') return json(res, hub.getPrefs());
      if (req.method === 'POST' && url.pathname === '/api/prefs') {
        let raw = ''; for await (const chunk of req) raw += chunk;
        let payload = {}; try { payload = JSON.parse(raw || '{}'); } catch { return json(res, { ok: false, error: 'body 不是合法 JSON' }, 400); }
        const r = hub.setPrefs(payload);
        return json(res, r, r.ok ? 200 : 400);
      }
      /** 公开配置：界面靠它渲染"凭据清单 / 每凭据上限 / 初始机器人"（以前漏了这个路由） */
      if (req.method === 'GET' && url.pathname === '/api/config') return json(res, hub.publicConfig());
      if (url.pathname === '/api/config/raw') {
        if (req.method === 'GET') return json(res, { path: hub.configPath(), text: hub.configText() });
        if (req.method === 'POST') {
          let body = '';
          for await (const chunk of req) body += chunk;
          let text = '';
          try { text = JSON.parse(body || '{}').text || ''; } catch { return json(res, { ok: false, error: '请求体不是合法 JSON' }, 400); }
          const r = hub.saveConfig(text);
          return json(res, r, r.ok ? 200 : 400);
        }
      }
      // 只压缩会话（托盘的「退出」和 stop-bothub 会先调它，保证「关闭时压缩」真的发生 ——
      // 因为 Windows 上直接 kill 不会触发任何信号钩子）
      if (req.method === 'POST' && url.pathname === '/api/app/compact') {
        return json(res, await hub.compactAll());
      }
      if (req.method === 'POST' && url.pathname === '/api/app/restart') {
        json(res, { ok: true, note: '正在退出，守护进程会在几秒内把它拉起来' });
        setTimeout(() => hub.restartApp(), 300);
        return;
      }
      json(res, { error: 'not found' }, 404);
    } catch (e) {
      appendLog('app.log', `[${stamp()}] ERROR 面板请求出错 ${url.pathname}: ${e && e.message}`);
      json(res, { error: String(e && e.message) }, 500);
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      log.info(`面板已启动：http://${host}:${port}/`);
      resolve(server);
    });
  });
}
