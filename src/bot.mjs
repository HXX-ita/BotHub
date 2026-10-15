/**
 * bot.mjs —— 一个机器人实例：把 QQ 连接、队列、会话、模型通道串起来。
 *
 * 关键设计（都是被今天这些坑逼出来的）：
 *   · **不用 SDK 的中间件链做门控**：那套会在 debug 关闭时静默丢弃，查起来是黑洞。
 *     这里所有判断都在我的代码里，每一个"不回"的决定都写一行 TRACE。
 *   · 入站全链路留痕：RAW（平台推来）→ EVENT（我收到）→ 判定（回/不回 + 原因）→
 *     QUEUED/START/DONE/ERROR/超时。
 *   · 排队期间**立刻回执**，超时**明确告知**，绝不让人对着屏幕干等。
 *   · 连接断了自己重连（指数退避），进程死了由外层守护进程秒级拉起。
 */
import { QQBot } from '@tencent-connect/qqbot-nodejs';
import { PeerQueue } from './queue.mjs';
import { SessionStore } from './sessions.mjs';
import { chat } from './models.mjs';
import { makeLogger, stamp, sleep, DATA } from './util.mjs';
import fs from 'node:fs';
import path from 'node:path';

const CHUNK = 1500; // QQ 单条消息别太长，超了切开发

function splitText(text, size = CHUNK) {
  const out = [];
  let rest = String(text);
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) out.push(rest);
  return out;
}

/** 去掉 @机器人 的标记、压掉多余空白 */
export function sanitize(content, appId) {
  let t = String(content || '');
  if (appId) t = t.replace(new RegExp(`<@!?${appId}>`, 'g'), ' ');
  return t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

export class BotInstance {
  constructor({ cfg, channel, log }) {
    this.cfg = cfg;
    this.channel = channel;
    this.log = log;
    this.running = false;
    this.startedAt = 0;
    this.restarts = 0;
    this.sessions = new SessionStore({ historyTurns: cfg.historyTurns, idleTimeoutMin: cfg.idleTimeoutMin });
    this.stats = {
      rawEvents: 0, messagesIn: 0, repliesOut: 0, skipped: 0,
      modelCalls: 0, modelMsTotal: 0, tokensTotal: 0, lastMessageAt: 0, lastReplyAt: 0, lastError: null,
      // 网关链路：READY = 全新连接；RESUMED = 断过线后恢复（**恢复的判据要认这两个**）
      gatewayUps: 0, gatewayResumes: 0, lastGatewayUpAt: 0,
      // 去重与限流（平台级现实：QQ 会重复投递；有人会连发/刷屏）
      duplicates: 0, rateLimited: 0, selfEcho: 0, commands: 0, modelFallbacks: 0,
    };
    this.seen = new Map();          // msgId -> 时间戳（去重窗口内的）
    this.dedupeWindowMs = cfg.limits?.dedupeWindowMs ?? 5 * 60 * 1000;
    this.rate = new Map();          // 对话对象 -> 这一分钟内的消息时间戳
    this.rateAckAt = new Map();     // 限流提醒的节流
    this.rateLimitPerMin = cfg.limits?.perPeerPerMin ?? 8;
    /** dsh 通道专用：每个对话对象一个 DSH 会话 id（落盘，重启不丢） */
    this.dshSessions = new Map();
    this.dshSessionFile = path.join(DATA, 'dsh-sessions.json');
    try {
      const saved = JSON.parse(fs.readFileSync(this.dshSessionFile, 'utf8'));
      for (const [k, v] of Object.entries(saved)) this.dshSessions.set(k, v);
    } catch { /* 第一次跑，没有这个文件很正常 */ }
    /**
     * ★ 平台适配：`mock` 是**本地假机器人**，用来做确定性验收测试。
     *   有了它，"多个机器人 + 每个绑不同模型 + 排队回执"这些不用等真 QQ 消息就能跑通并断言。
     *   真实平台（qq）走 QQBot；假平台把回复记进 outbox，供测试和面板读取。
     */
    this.isMock = cfg.platform === 'mock';
    this.outbox = [];
    this.queue = new PeerQueue({
      name: cfg.id,
      log,
      maxQueue: cfg.queue.maxQueue,
      maxProcessingMs: cfg.queue.maxProcessingMs,
      ackThrottleMs: cfg.queue.ackThrottleMs,
      runner: (task) => this.#handle(task),
      onAck: (ctx, info) => this.#ack(ctx, info),
    });
    if (!this.isMock) {
      /**
       * ⛔ **没凭据时不能构造 QQBot** —— SDK 的构造函数会直接抛 `QQBot: appId is required`，
       *    应用就起不来了（全新安装时面板打不开、首次向导没机会弹）。
       *    所以延迟到真正要连的时候再建（`#ensureClient()`），凭据一填上就能立刻连。
       */
      if (cfg._appId && cfg._appSecret) this.#ensureClient();
    }
  }

  /** 延迟创建 QQBot 客户端（凭据齐了才建；首次向导保存完凭据后由这里补建） */
  #ensureClient() {
    if (this.isMock || this.bot) return this.bot;
    this.bot = new QQBot({
      appId: this.cfg._appId,
      appSecret: this.cfg._appSecret,
      accountId: this.cfg.id,
      logger: {
        info: (m) => this.log.info(String(m)),
        warn: (m) => this.log.warn(String(m)),
        error: (m) => this.log.error(String(m)),
        debug: (m) => this.log.trace(`DEBUG ${String(m)}`),
      },
    });
    return this.bot;
  }

  /** 统一出口：真平台发给 QQ，假平台记进 outbox（测试用） */
  async #send(target, text) {
    if (this.isMock) {
      this.outbox.push({ at: Date.now(), scope: target.scope, peer: target.targetId, text });
      if (this.outbox.length > 500) this.outbox.splice(0, this.outbox.length - 500);
      this.stats.repliesOut++;
      this.log.trace(`OUTBOX peer=${target.scope}:${target.targetId} text=${JSON.stringify(String(text).slice(0, 100))}`);
      return;
    }
    await this.bot.sendText(target, text);
    this.stats.repliesOut++;
  }

  /**
   * 假平台注入：形状和 SDK 收到的真实消息保持一致，**走同一条处理路径**，
   * 所以测出来的结论对真 QQ 也成立。
   */
  async inject({ text, scope = 'group', peerId, mention = true, rawEventType, senderId = 'mock-user', messageId, senderIsBot = false }) {
    if (!this.isMock) throw new Error('只有 platform=mock 的机器人能注入消息');
    const peer = peerId || this.cfg.id + '-peer';
    this.stats.rawEvents++;
    this.log.trace(`RAW ${rawEventType || (scope === 'group' && mention ? 'GROUP_AT_MESSAGE_CREATE' : 'GROUP_MESSAGE_CREATE')} peer=${peer} id=mock-${Date.now()}`);
    const msg = {
      kind: scope,
      content: mention ? `<@!${this.cfg._appId}> ${text}` : text,
      groupOpenid: scope === 'group' ? peer : undefined,
      senderId,
      senderIsBot,
      messageId: messageId || ('mock-' + Date.now() + '-' + Math.random().toString(16).slice(2, 6)),
      rawEventType: rawEventType || (scope === 'group' && mention ? 'GROUP_AT_MESSAGE_CREATE' : 'GROUP_MESSAGE_CREATE'),
      mentions: mention ? [{ is_you: true }] : [],
      replyTarget: { scope, targetId: peer, msgId: 'mock' },
    };
    this.#onMessage(msg);
    // 给队列一点时间跑起来（测试脚本随后按 outbox 断言）
    await new Promise((r) => setTimeout(r, 10));
    return { peer, messageId: msg.messageId };
  }

  async start() {
    // 还没填 appId/appSecret（全新安装）→ 别去连平台，等面板向导填完；日志里说清楚，别让人以为它坏了
    if (this.cfg.credentialsMissing) {
      this.log.warn('还没填 appId / appSecret —— 打开面板里的向导填一下，填完自动连上');
      return;
    }
    /**
     * ⓪ 共用凭证（一个凭证最多 4 个机器人）→ **只有连接者去连**。
     *   为什么要拦：同一个 appId 建两条连接会互相抢事件（当初最痛的那个故障），
     *   平台侧也可能直接踢掉一条。其余机器人靠连接者 `route()` 分流收到消息。
     */
    if (this.cfg.sharedCredential) {
      /**
       * ⚠️ 共用凭证的机器人**也算"在跑"** —— 它不自己连，但连接者会把属于它的消息转交过来，
       *    它要能正常回话。第一版这里直接 return（running 还是 false），
       *    结果 `deliver()` 把转交来的消息当"没在跑"忽略了（实测：日志显示分流成功、但没有回复）。
       */
      this.running = true;
      this.startedAt = Date.now();
      this.log.info(`共用凭证：不自己连（由 ${this.cfg.connectorId || '连接者'} 那条连接分流过来）`);
      return;
    }
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();
    this.log.info(`启动机器人 ${this.cfg.id}（平台 ${this.cfg.platform}，通道 ${this.channel.id} / ${this.channel.kind === 'echo' ? '本地假通道' : this.channel.kind === 'dsh' ? 'DSH 本体（会干活的通道，profile=' + (this.channel.profile || 'headless') + '）' : '模型 ' + this.channel.model}，群里${this.cfg.mentionRequired ? '必须 @ 才回' : '所有消息都看'}）`);
    if (this.isMock) {
      this.log.info('这是假机器人（platform=mock）：消息从面板 /api/bots/' + this.cfg.id + '/inject 注入，不会连 QQ');
      return;
    }
    this.#ensureClient();   // 凭据齐了才建；首次向导刚填完凭据时，这里会补建
    this.bot.on('rawEvent', (c) => {
      this.stats.rawEvents++;
      const d = c.data || {};
      const peer = d.group_openid || (d.author && d.author.user_openid) || '';
      this.log.trace(`RAW ${c.eventType} peer=${peer} id=${d.id || ''} text=${JSON.stringify(String(d.content || '').slice(0, 80))}`);
    });
    this.bot.on('error', (e) => {
      this.stats.lastError = String(e && e.message);
      this.log.error(`bot error: ${this.stats.lastError}`);
    });
    this.bot.on('disconnected', (e) => {
      this.log.warn(`连接断开：code=${e.code} willReconnect=${e.willReconnect}${e.reason ? ' reason=' + e.reason : ''}`);
    });
    /**
     * ★ 网关链路的两个"活了"的信号都要记：
     *   `ready`   = 新建连接（第一次连上、或恢复失败后退回全新会话）
     *   `resumed` = **断线后恢复**（QQ 网关的 RESUME 语义）
     * 实测踩过：拔线后走的是 RESUMED，我一开始只认 READY，把"1.5 秒就恢复了"报成"没恢复"。
     */
    this.bot.on('ready', () => {
      this.stats.gatewayUps++;
      this.stats.lastGatewayUpAt = Date.now();
      this.log.info(`网关就绪（READY，累计 ${this.stats.gatewayUps} 次）`);
    });
    this.bot.on('resumed', () => {
      this.stats.gatewayUps++;
      this.stats.gatewayResumes++;
      this.stats.lastGatewayUpAt = Date.now();
      this.log.warn(`网关会话恢复（RESUMED，累计恢复 ${this.stats.gatewayResumes} 次）—— 说明刚才断过线，已经接回`);
    });
    this.bot.on('message', (ctx, msg) => this.#onMessage(msg));

    // 连接循环：SDK 的重连预算用完、或者别的异常让 start() 返回，都重新接一次
    this.#loop().catch((e) => this.log.error(`连接循环异常退出：${e && e.message}`));
  }

  async #loop() {
    let backoff = 2000;
    while (this.running) {
      try {
        await this.bot.start();
        this.log.warn('连接已结束（start() 返回）—— 5 秒后重连');
      } catch (e) {
        this.stats.lastError = String(e && e.message);
        this.log.error(`连接失败：${this.stats.lastError} —— ${Math.round(backoff / 1000)} 秒后重试`);
      }
      if (!this.running) return;
      this.restarts++;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 60000);
      if (this.running && this.restarts % 5 === 0) this.log.warn(`已经重连 ${this.restarts} 次`);
    }
  }

  stop() {
    this.running = false;
    if (this.bot) { try { this.bot.stop(); } catch { /* ignore */ } }
    this.log.info('已停止');
  }

  /**
   * 主动说一句话（不需要先收到消息）。
   * 用途：① 面板上手动让机器人冒个泡 ② 端到端验证"出站链路"到底通不通。
   * ⚠️ QQ 对**主动消息**有限额（不是回复、没有 msgId 的那种），失败会明确报错 —— 报错也要留痕。
   */
  async say({ scope = 'group', peerId, text }) {
    if (!text) throw new Error('要说什么？text 不能空');
    const target = { scope, targetId: peerId };
    this.log.trace(`SAY scope=${scope} peer=${peerId} text=${JSON.stringify(String(text).slice(0, 80))}`);
    try {
      await this.#send(target, text);
      return { ok: true };
    } catch (e) {
      /**
       * 实测（2026-10-15）：QQ 官方机器人**默认没有「主动消息」权限**，
       * 会返回 `{"message":"主动消息失败, 无权限","code":40034105}`。
       * 这不是我们代码的问题 —— 请求形状、鉴权、端点都对，是平台侧的开关。
       * 所以：把原始错误翻成人话再抛，别让老板对着一串 400 猜。
       * 影响：**机器人不能主动冒泡/定时提醒**，只能"别人先说、它才能回"。
       * 想要主动推送，得去 QQ 开放平台申请主动消息权限（有额度和审核）。
       */
      const raw = String((e && e.message) || e);
      if (/40034105|无权限/.test(raw)) {
        const hint = 'QQ 平台不给「主动消息」权限（错误码 40034105）：这条机器人只能**回复**别人，不能主动开口。'
          + '要主动推送得去 QQ 开放平台申请权限；在那之前，先让人 @ 它一下它才能答。';
        this.log.warn(`主动发言被平台拒绝：${hint}`);
        throw new Error(hint);
      }
      throw e;
    }
  }

  /**
   * 主动掐断连接（**故障演练**用）。两档，越像真故障越好：
   *
   *   ① `socket`（默认，**最接近真断网**）：直接 `terminate()` 掉 WebSocket 的 TCP 连接 ——
   *      没有干净的关闭握手，跟"网线被拔 / NAT 超时 / 中间设备重置"一模一样，
   *      逼 SDK 走它自己的"检测到 close → 退避重连"路径。
   *   ② `clean`：`bot.stop()`（干净停机再起），比真断网温和。
   *
   * 为什么要能演练：旧机器人今天最大的教训就是"这些恢复逻辑从来没被真跑过"。
   * 断网这条路不能等真出事才知道行不行。
   */
  kick(reason = '手动演练', mode = 'socket') {
    if (this.isMock) return { ok: false, error: '假机器人没有真连接，不用演练' };
    if (mode === 'socket') {
      // ⚠️ SDK 的 d.ts 把 gateway 标成 private，但 JS 运行时就在实例上：
      //    bot.gateway.currentWs 是那条真实的 WebSocket。取不到就退回干净重启。
      const ws = this.bot?.gateway?.currentWs;
      if (ws && typeof ws.terminate === 'function') {
        this.log.warn(`⚠️ 演练：直接掐断 WebSocket 的 TCP 连接（${reason}）—— 等价于拔网线，看它自己接不接得回来`);
        try { ws.terminate(); return { ok: true, mode: 'socket', note: '已拔线（TCP 层掐断），等它自己重连' }; }
        catch (e) { this.log.error(`掐连接失败（${e && e.message}），改用干净重启`); }
      } else {
        this.log.warn('拿不到 WebSocket 实例（SDK 结构可能变了），退回干净重启这条路');
      }
    }
    this.log.warn(`⚠️ 主动掐断连接（${reason}，干净模式）—— 看它会不会自己接回来`);
    try { this.bot.stop(); } catch (e) { return { ok: false, error: String(e && e.message) }; }
    return { ok: true, mode: 'clean', note: '已掐断，重连循环会在几秒内接回来（看日志的 READY）' };
  }

  /**
   * 自定义指令：匹配 + 执行。返回 true 表示这条消息已经被指令处理掉（不再进模型）。
   *
   * 设计取舍：
   *   · 指令**不走队列**（除了 `prompt` 那种要问模型的）—— 回一句固定话没必要排队等前面那条长回复；
   *   · `prompt` 类型**走队列**：它本质是一次模型调用，得跟普通对话同一个串行通道，
   *     否则同一个人的两轮会互相踩上下文；
   *   · `/帮助` 内置，且**永远列出当前这套指令**（否则用户根本不知道有什么可用）。
   */
  #handleCommand(msg, scope, peerId, text) {
    // 只认**启用中**的指令（界面上的开关关掉 = 临时停用，配置里还留着）
    const cmds = (this.cfg.commands || []).filter((c) => c.enabled !== false);
    const helpName = '/帮助';
    const lower = text.toLowerCase();

    const describe = () => {
      const lines = cmds.map((c) => `${c.name}${c.desc ? ' — ' + c.desc : ''}`);
      if (!cmds.some((c) => c.name === helpName)) lines.unshift(`${helpName} — 看有哪些指令`);
      lines.push('/新会话 — 开一段新对话（把现在这段压缩存进记忆）');
      lines.push('/记忆 — 看存了哪几次对话、各自的关键词');
      return '我能用的指令：\n' + lines.join('\n');
    };

    /**
     * 内置：**开新会话**（老板定的：只有用户主动要，才开新会话）。
     * 把这段对话压成"摘要 + 关键词"存进记忆（只留最近 3 次），然后清空当前上下文。
     */
    if (lower === '/新会话' || lower === '/新对话' || lower === '/new' || lower === '新会话') {
      this.stats.commands++;
      const r = this.sessions.startNew(this.cfg.id, scope, peerId);
      this.stats.newSessions = (this.stats.newSessions || 0) + 1;
      this.log.info(`CMD 新会话 peer=${scope}:${peerId} 归档=${r.archived ? '是' : '否'} 关键词=${(r.archived?.keywords || []).slice(0, 5).join('、')}`);
      const kw = r.archived ? `（记下了关键词：${(r.archived.keywords || []).slice(0, 6).join('、')}）` : '';
      this.#send(msg.replyTarget, r.archived
        ? `好，这是新的一段对话了。刚才那段我压好存进记忆了 ${kw}\n要翻旧账的时候提一下这些词就行。`
        : '我们还没聊什么呢，直接说事就行。').catch(() => {});
      return true;
    }

    /** 内置：看存了哪几次对话 + 关键词（让老板知道"要触发哪个词"） */
    if (lower === '/记忆' || lower === '/会话' || lower === '/memory') {
      this.stats.commands++;
      const mem = this.sessions.loadMemory(this.cfg.id, scope, peerId);
      const { readAll } = this.sessions;
      const now = readAll(this.cfg.id, scope, peerId).length;
      const lines = [`当前这段对话：${now} 条消息`];
      if (mem.current?.keywords?.length) lines.push(`·（这段压缩过一次，关键词：${mem.current.keywords.slice(0, 6).join('、')}）`);
      if (!mem.archives.length) lines.push('还没存过别的对话。想开新的一段就说 /新会话');
      else mem.archives.forEach((a, i) => {
        const when = new Date(a.endedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        lines.push(`${i + 1}. ${when}（${a.turns} 条）关键词：${(a.keywords || []).slice(0, 6).join('、')}`);
      });
      if (mem.archives.length) lines.push('提到上面的关键词，我就会把那次对话翻出来看。');
      this.#send(msg.replyTarget, lines.join('\n')).catch(() => {});
      return true;
    }

    // 内置帮助
    if (lower === helpName.toLowerCase() || lower === '/help' || lower === '指令' || lower === '帮助') {
      this.stats.commands++;
      this.log.trace(`CMD ${helpName} peer=${scope}:${peerId}`);
      this.#send(msg.replyTarget, describe()).catch(() => {});
      return true;
    }

    for (const c of cmds) {
      const name = c.name.toLowerCase();
      if (lower !== name && !lower.startsWith(name + ' ')) continue;
      const arg = text.slice(c.name.length).trim();
      this.stats.commands++;
      this.log.trace(`CMD ${c.name} peer=${scope}:${peerId} arg=${JSON.stringify(arg.slice(0, 60))}`);

      if (c.reply) { this.#send(msg.replyTarget, c.reply).catch(() => {}); return true; }

      if (c.action === 'status') {
        const s = this.status();
        this.#send(msg.replyTarget,
          `我还在跑。\n收到 ${s.messagesIn} 条 · 回了 ${s.repliesOut} 条 · 跳过 ${s.skipped} 条\n` +
          `队列：${s.queue.busyLanes} 处理中 / ${s.queue.queued} 排队 · 已重连 ${s.restarts} 次\n` +
          `最后一条消息：${s.lastMessageSecAgo === null ? '还没有' : s.lastMessageSecAgo + ' 秒前'}` +
          (s.lastError ? `\n最后出错：${s.lastError}` : '')).catch(() => {});
        return true;
      }

      if (c.action === 'logs') {
        let lines = '';
        try {
          const all = fs.readFileSync(path.join(DATA, 'logs', `bot-${this.cfg.id}.log`), 'utf8').split(/\r?\n/).filter(Boolean);
          lines = all.slice(-10).join('\n');
        } catch { lines = '（还没有日志）'; }
        this.#send(msg.replyTarget, '最近 10 行日志：\n' + lines.slice(0, 900)).catch(() => {});
        return true;
      }

      if (c.action === 'restart') {
        this.#send(msg.replyTarget, '收到，几秒后回来。').catch(() => {});
        setTimeout(() => { try { this.kick('指令要求重启', 'clean'); } catch { /* ignore */ } }, 800);
        return true;
      }

      if (c.prompt) {
        // 交给模型，但带上这段额外提示 —— 走队列，跟普通对话同一条串行通道
        const ac = new AbortController();
        const task = {
          ctx: msg, replyTarget: msg.replyTarget, scope, peerId,
          text: arg || '（没写内容）',
          extraPrompt: c.prompt,
          receivedAt: Date.now(), ac, onTimeout: () => { try { ac.abort(); } catch { /* ignore */ } },
        };
        this.queue.push(`${scope}:${peerId}`, task).catch((e) => this.log.error(`指令入队失败：${e && e.message}`));
        return true;
      }

      // 指令配了但什么都没填 —— 明确说一句，别静默
      this.#send(msg.replyTarget, `${c.name} 这条指令还没配动作（reply / prompt / action 三选一）。`).catch(() => {});
      return true;
    }
    return false;
  }

  /**
   * 让这个机器人的"脑子"把一段旧对话总结成短摘要（维护里的"智能压缩"用）。
   * 直接走它自己的模型通道；失败就抛出去，由调用方退回结构化压缩。
   */
  async summarize(oldText) {
    const { chat } = await import('./models.mjs');
    const msgs = [
      { role: 'system', content: '把下面这段对话压缩成一段不超过 200 字的中文摘要，只留事实、约定和结论，不要寒暄。' },
      { role: 'user', content: oldText },
    ];
    const r = await chat(this.channel, msgs, {
      timeoutMs: Math.min(60000, this.channel.timeoutMs || 60000),
      modelOverride: this.#modelOverride(),   // 总结也守这个机器人的模型/权限设置
    });
    return r;
  }
  /**
   * 这个机器人的 DSH 覆盖项（模型 / 推理等级 / 权限 / 是否给工具）：返回 { file, ... }，全空就返回 null。
   *   · 全空 = **跟随 DSH** —— 免费模型插件的自动轮切、退回默认，全都照常生效；
   *   · 只要有一项，就生成 patch 用 `--patch` 传（**不改老板的 profile 配置**）。
   *   · openai 通道只用其中的 model 覆盖请求。
   */
  #modelOverride() {
    const { model, provider, reasoningEffort, permission, noTools } = this.cfg;
    if (!model && !reasoningEffort && !permission && !noTools) return null;
    return {
      provider: provider || null, model: model || null, reasoningEffort: reasoningEffort || null,
      permission: permission || null, noTools: !!noTools,
      file: path.join(DATA, `model-patch-${this.cfg.id}.yml`),
    };
  }
  /** dsh 会话映射落盘（重启不丢，别每次都开新会话） */  #saveDshSessions() {
    try {
      fs.mkdirSync(DATA, { recursive: true });
      fs.writeFileSync(this.dshSessionFile, JSON.stringify(Object.fromEntries(this.dshSessions), null, 2), 'utf8');
    } catch (e) {
      this.log.warn(`dsh 会话映射写盘失败（不影响对话）：${e && e.message}`);
    }
  }

  /**
   * 入站第一站：判定要不要回（每个"不回"都留痕）。
   *
   * 这里加了两道**平台级现实**的闸（2026-10-15 补）：
   *   ① **重复投递去重**：QQ 在网络抖动/重连重叠时**会把同一条消息推两次**；
   *      旧插件有这个去重，我第一版没写 —— 那就会"同一句话答两遍"。
   *   ② **发得太快的限流**：老板连发/有人刷屏时，不拦就会一路打到 QQ 的接口限额，
   *      表现成一堆 400 错误（用户看到的是"没反应"）。现在提前挡住并**明确告知**，不是静默丢。
   */
  /**
   * 公开入口：**连接者把消息转交给同凭证的另一个机器人**时用（内部还是走同一套门控/队列）。
   * 为什么需要它：`#onMessage` 是私有的，连接者不能直接调；而"共用一条连接"要成立就必须能转交。
   */
  deliver(msg) {
    if (!this.running) { this.log.warn('收到转交的消息，但本机器人没在跑（共享凭证）—— 忽略'); return; }
    this.#onMessage(msg);
  }

  #onMessage(msg) {
    this.stats.messagesIn++;
    this.stats.lastMessageAt = Date.now();
    const scope = msg.kind === 'group' ? 'group' : 'c2c';
    const peerId = scope === 'group' ? (msg.groupOpenid || msg.senderId) : msg.senderId;
    const text = sanitize(msg.content, this.cfg._appId);

    this.log.trace(`EVENT scope=${scope} peer=${peerId} msgId=${msg.messageId || '?'} rawType=${msg.rawEventType || '?'} text=${JSON.stringify(text.slice(0, 120))}`);

    /**
     * ⓪·5 **共用凭证的分流**（一个凭证最多 4 个机器人，但同一个 appId 只能有一条连接）。
     *
     * 所以：连接者收到消息后先问一句"这条该交给谁"，由 hub 按**群/私聊白名单**决定；
     * 有归属就转交、并且**本机器人不再处理**（避免两个机器人同时回一条消息）。
     * 没有归属就自己处理（默认机器人兜底）。
     */
    if (typeof this.route === 'function') {
      try {
        if (this.route(msg, { scope, peerId, text })) { this.log.trace(`ROUTE ${scope}:${peerId} → 交给同凭证的另一个机器人`); return; }
      } catch (e) { this.log.warn(`分流判断出错（按自己处理继续）：${e.message}`); }
    }

    /**
     * ⓪ 自身回声：平台有可能把**机器人自己发的消息**也推回来（SDK 的 InboundMessage 里
     *    专门有 `senderIsBot` 这个字段，就说明这是真实存在的情况）。
     *    不挡的后果很严重：它会回自己 → 再被推回来 → **自己跟自己无限对话**，还会白烧额度。
     *    旧插件有这道闸，我第一版漏了 —— 补上，并且留痕（不是静默丢）。
     */
    if (msg.senderIsBot) {
      this.stats.skipped++;
      this.stats.selfEcho++;
      this.log.trace(`DROP self-echo msgId=${msg.messageId || '?'}（这是机器人自己发的消息被推回来了）`);
      return;
    }

    // ① 去重：同一条消息（同 msgId）在窗口内只处理一次
    const mid = msg.messageId;
    if (mid) {
      const prev = this.seen.get(mid);
      const now = Date.now();
      if (prev && now - prev < this.dedupeWindowMs) {
        this.stats.duplicates++;
        this.stats.skipped++;
        this.log.trace(`DROP duplicate msgId=${mid}（${Math.round((now - prev) / 1000)} 秒前已经处理过同一条）`);
        return;
      }
      this.seen.set(mid, now);
      if (this.seen.size > 2000) {                       // 别让这张表无限长
        for (const [k, t] of this.seen) if (now - t > this.dedupeWindowMs) this.seen.delete(k);
        while (this.seen.size > 2000) this.seen.delete(this.seen.keys().next().value);
      }
    }

    const allow = scope === 'group' ? this.cfg.groupAllow : this.cfg.c2cAllow;
    if (Array.isArray(allow) && allow.length > 0 && !allow.includes(peerId)) {
      this.stats.skipped++;
      this.log.trace(`SKIP access peer=${peerId}（不在白名单里）`);
      return;
    }

    const mentioned = msg.rawEventType === 'GROUP_AT_MESSAGE_CREATE'
      || (Array.isArray(msg.mentions) && msg.mentions.some((m) => m && m.is_you === true));
    if (scope === 'group' && this.cfg.mentionRequired && !mentioned) {
      this.stats.skipped++;
      this.log.trace(`SKIP no-mention peer=${peerId} rawType=${msg.rawEventType || '?'}（群里没 @ 它）`);
      return;
    }
    if (!text) {
      this.stats.skipped++;
      this.log.trace(`SKIP empty peer=${peerId}（清洗后是空的）`);
      return;
    }

    /**
     * ★ 自定义指令层（2026-10-15 加，老板问"为什么不能让我创建机器人专用指令"）。
     *
     * 放在**限流之前**：指令是最便宜的动作（回一句固定话 / 报个状态），
     * 不该被"发太快"挡住 —— 但去重、白名单、@ 门控仍然在前面生效（那些是安全和防刷的底线）。
     */
    if (this.#handleCommand(msg, scope, peerId, text)) return;

    // ② 限流：同一个对话对象一分钟内最多 N 条（默认 8）。超了就**明确拒绝**并说明，
    //    免得一路打到 QQ 的接口限额、变成一堆 400（用户那边看到的就是"没反应"）。
    const rlKey = `${scope}:${peerId}`;
    const nowTs = Date.now();
    const hits = (this.rate.get(rlKey) || []).filter((t) => nowTs - t < 60000);
    if (hits.length >= this.rateLimitPerMin) {
      this.stats.rateLimited++;
      this.stats.skipped++;
      this.rate.set(rlKey, hits);
      this.log.trace(`DROP rate-limited peer=${rlKey}（这一分钟已 ${hits.length} 条，上限 ${this.rateLimitPerMin}）`);
      const last = this.rateAckAt.get(rlKey) || 0;
      if (nowTs - last > 30000) {           // 30 秒内只提醒一次，别把限流本身变成刷屏
        this.rateAckAt.set(rlKey, nowTs);
        this.#ack(msg, { kind: 'ratelimited', limit: this.rateLimitPerMin }).catch(() => {});
      }
      return;
    }
    hits.push(nowTs);
    this.rate.set(rlKey, hits);
    // 顺手清一下这张表：只在访问时清会留着一堆早已过期的空壳（对话对象多了会慢慢涨）
    if (this.rate.size > 500) {
      for (const [k, arr] of this.rate) {
        const live = arr.filter((t) => nowTs - t < 60000);
        if (!live.length) this.rate.delete(k); else this.rate.set(k, live);
      }
    }

    const ac = new AbortController();
    const task = { ctx: msg, replyTarget: msg.replyTarget, scope, peerId, text, receivedAt: Date.now(), ac, onTimeout: () => { try { ac.abort(); } catch { /* ignore */ } } };
    this.queue.push(`${scope}:${peerId}`, task).catch((e) => this.log.error(`入队失败：${e && e.message}`));
  }

  /** 需要给对方一个回执（排队中/超时/拒绝/出错）—— 每个都发，不静默 */
  async #ack(ctx, info) {
    if (!ctx || !ctx.replyTarget) return;
    const say = {
      queued: (d) => `收到，上一条还在处理，这条排在第 ${d} 位 —— 处理完我马上答。`,
      timeout: () => '⚠️ 这一轮我处理太久了，先中断了（避免一直卡住）。你重发一次，我重新来。',
      rejected: (d) => `⚠️ 排队的消息太多了（已经 ${d} 条），这条先不排了 —— 等我处理完再发。`,
      error: (m) => `⚠️ 这条我没处理成功（${String(m).slice(0, 60)}）。你重发一次通常就好了。`,
      ratelimited: (lim) => `⚠️ 你发得有点快，我先喘口气 —— 一分钟最多处理 ${lim} 条，过一会儿再说。`,
    }[info.kind];
    if (!say) return;
    try {
      await this.#send(ctx.replyTarget, say(info.depth ?? info.ms ?? info.message ?? ''));
      this.log.trace(`ACK ${info.kind} peer=${this.#peerOf(ctx)}`);
    } catch (e) {
      this.log.warn(`回执发送失败（${info.kind}）：${e && e.message}`);
    }
  }

  #peerOf(ctx) {
    const m = ctx && ctx.message ? ctx.message : ctx;
    const scope = m.kind === 'group' ? 'group' : 'c2c';
    return `${scope}:${scope === 'group' ? (m.groupOpenid || m.senderId) : m.senderId}`;
  }

  systemPrompt() {
    const base = this.cfg.persona || '你是一个中文 AI 助手，回答简洁、直接、有用。';
    return `${base}\n\n【环境】你现在通过 QQ 机器人在跟人对话（机器人 id：${this.cfg.id}）。` +
      `群聊里只有被 @ 时你才会看到消息。回答不要用 Markdown 标题，尽量短，能一句话说清就别写三段。`;
  }

  /** 真正干活：进模型 → 回消息 */
  async #handle(task) {
    const { scope, peerId, text } = task;
    const key = `${scope}:${peerId}`;
    this.log.trace(`PROCESSING peer=${key} text=${JSON.stringify(text.slice(0, 120))}`);

    this.sessions.append(this.cfg.id, scope, peerId, 'user', text);

    // 太长就顺手压一下（留最近 N 轮 + 一行摘要 + 关键词，不丢上下文）；
    // 老板要求的「关闭时压缩」在 main.mjs 的退出钩子里做。
    if (this.sessions.load(this.cfg.id, scope, peerId).items.length > (this.cfg.historyTurns || 12) * 4) {
      const c = this.sessions.compactNow(this.cfg.id, scope, peerId);
      this.log.info(`会话自动压缩：${c.before} → ${c.after} 条`);
    }
    // 指令带来的额外提示（例如 /问 xxx → "先按这个提示理解，再回答："）
    if (task.extraPrompt && messages.length) {
      const last = messages[messages.length - 1];
      messages[messages.length - 1] = { role: last.role, content: task.extraPrompt + '\n' + last.content };
    }
    // 把这句话也传进去 —— 命中「以前某次对话」的关键词时，会临时带上那次的压缩记录（用完即回原位）
    const messages = this.sessions.messages(this.cfg.id, scope, peerId, this.systemPrompt(), text);

    /**
     * ★ dsh 通道：上下文由 **DSH 自己的会话**维护（每个对话对象一个），
     *   所以只在**第一次**说话时把人格提示词附带进去，之后靠 --session-id 续聊。
     */
    const isDsh = this.channel.kind === 'dsh';
    let dshSessionId = null;
    if (isDsh) {
      dshSessionId = this.dshSessions.get(key) || null;
      if (!dshSessionId) {
        messages[messages.length - 1] = { role: 'user', content: `${this.systemPrompt()}\n\n${text}` };
        this.log.trace(`DSH-SESSION new peer=${key}（第一次说话，附带人格提示词）`);
      }
    }

    this.stats.modelCalls++;
    const r = await chat(this.channel, messages, {
      signal: task.ac ? task.ac.signal : undefined,
      dshSessionId,
      modelOverride: this.#modelOverride(),   // 面板上给这个机器人选的模型（没选就是 null = 跟随默认）
    });
    if (r.fellBackToDefault) { this.stats.modelFallbacks++; this.log.warn('面板上钉住的模型不可用 → 这次退回 DSH 默认模型'); }
    this.stats.modelMsTotal += r.ms;
    if (r.usage && r.usage.total_tokens) this.stats.tokensTotal += r.usage.total_tokens;

    if (r.error) {
      this.stats.lastError = String(r.error.message);
      this.log.error(`模型调用失败 peer=${key}：${r.error.message}`);
      throw r.error;
    }
    if (isDsh && r.sessionId && r.sessionId !== dshSessionId) {
      this.dshSessions.set(key, r.sessionId);
      this.#saveDshSessions();
      this.log.trace(`DSH-SESSION saved peer=${key} id=${r.sessionId}`);
    }

    this.sessions.append(this.cfg.id, scope, peerId, 'assistant', r.text);
    const parts = splitText(r.text);
    for (const p of parts) {
      await this.#send(task.replyTarget, p);   // repliesOut 在 #send 里统一累加
    }
    this.stats.lastReplyAt = Date.now();
    this.log.trace(`SENT peer=${key} 段数=${parts.length} 字符=${r.text.length} 用时=${(r.ms / 1000).toFixed(1)}s`);
  }

  /**
   * 别名还是占位名（"我的机器人"）时，**自动改用平台上的名字** ——
   * 老板要的"默认机器人的名字/头像跟现在这个一致"就靠它（头像是平台给的，面板本来就跟着走）。
   * 只改本地显示名，不动平台、不动用户自己填过的别名。
   */
  maybeAdoptPlatformName(platformName) {
    const placeholder = !this.cfg.alias || this.cfg.alias === this.cfg.id || this.cfg.alias === '我的机器人';
    if (!placeholder || !platformName) return false;
    this.cfg.alias = String(platformName).slice(0, 40);
    this.log?.info?.(`显示名用平台上的：${this.cfg.alias}`);
    return true;
  }
  status() {
    const up = this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0;
    return {
      id: this.cfg.id,
      running: this.running,
      channel: this.channel.id,
      // 实际用的模型（通道的；面板上钉了就是钉的那个）
      model: this.cfg.model || this.channel.model,
      // 面板上**钉住**的模型（空 = 跟随 DSH/通道默认 → 免费插件的自动轮切照常生效）
      modelPinned: this.cfg.model || null,
      // 凭据齐不齐（首次向导靠它决定弹不弹；只回真假，不回值）
      credentialsReady: !!(this.cfg._appId && this.cfg._appSecret),
      uptimeSec: up,
      restarts: this.restarts,
      ...this.stats,
      lastMessageSecAgo: this.stats.lastMessageAt ? Math.round((Date.now() - this.stats.lastMessageAt) / 1000) : null,
      lastReplySecAgo: this.stats.lastReplyAt ? Math.round((Date.now() - this.stats.lastReplyAt) / 1000) : null,
      lastGatewayUpSecAgo: this.stats.lastGatewayUpAt ? Math.round((Date.now() - this.stats.lastGatewayUpAt) / 1000) : null,
      queue: this.queue.snapshot(),
    };
  }
}
