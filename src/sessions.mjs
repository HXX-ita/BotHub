/**
 * sessions.mjs —— 会话存储：每个机器人、每个对话对象（群/私聊）一份历史。
 *
 * 落盘格式（**都在 BotHub 自己的 data\ 里**，不依赖 DSH 的任何文件 —— 老板明确要求：
 * "通过机器人得到的记录默认存在机器人软件的文件里而不是 dsh 的文件里，不会因为 dsh 的改动就出现记忆缺失"）：
 *   · `data/sessions/<botId>/<scope>__<peerId>.jsonl`         当前会话（一行一条 { role, text, at }）
 *   · `data/sessions/<botId>/<scope>__<peerId>.memory.json`   压缩档案（最近 3 次会话 + 关键词）
 *
 * 记忆规矩（2026-10-15 老板定的）：
 *   ① **只有用户主动要新会话才开新会话**（`/新会话`）—— 空闲再久也不算新会话（原来 30 分钟空闲就重置，已去掉）。
 *   ② **应用关闭时压缩**当前会话：摘要 + 关键词；下次启动照样记得。
 *   ③ 每个对话对象只保留**最近 3 次**压缩会话，更早的丢掉。
 *   ④ **关键词召回**：用户消息命中某次压缩会话的关键词，才把那段摘要塞进这一次的上下文；
 *      用完就回原位、不进当前会话，下次还得再触发。
 *
 * 规矩：写盘失败只记日志，绝不让对话因为存不了历史而失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA, appendLog, stamp } from './util.mjs';

const dirFor = (botId) => path.join(DATA, 'sessions', botId);
const fileFor = (botId, scope, peerId) =>
  path.join(dirFor(botId), `${scope}__${peerId.replace(/[^\w.-]/g, '_')}.jsonl`);
const memoryFor = (botId, scope, peerId) =>
  path.join(dirFor(botId), `${scope}__${peerId.replace(/[^\w.-]/g, '_')}.memory.json`);

/**
 * 关键词抽取（不引分词库，够用就好）。
 *
 * ⛔ 第一版是坏的，记下来免得再犯：滑窗取 2~4 字、按"频次降序 + 长度降序"排，
 *    结果抽出的是「我周末去 / 末去钓鱼 / 在城东那」这种**跨词边界的碎片**，
 *    真正有用的「钓鱼 / 水库」反而被挤掉 —— 召回自然失败（实测"提到钓鱼召不回"）。
 *
 * 现在：① **只取 2~3 字**；② 首尾是虚词（我/的/了/在/是/就…）的候选**直接丢**；
 *      ③ 排序**优先短的**（短词更可能在别处重现）；④ 3 字词要求出现 ≥ 2 次。
 * 只从**对方说过的话**里抽（关键词该是"他提过的事"，不是我说的）。
 */
const STOP = new Set(['这个', '那个', '什么', '怎么', '可以', '不是', '就是', '我们', '你们', '他们', '自己', '现在', '时候', '一下', '还是', '因为', '所以', '但是', '如果', '已经', '一个', '好的', '谢谢', '请问', '然后', '这样', '那样', '没有', '知道', '觉得', '应该', '需要', '可能', '今天', 'the', 'and', 'for', 'you', 'are', 'that', 'this', 'with', 'have']);
/** 单字虚词：出现在候选词的**开头或结尾**就丢掉这个词（"我周末" "末去钓" 这种碎片） */
const EDGE_STOP = new Set('我的了在是你他她它和与就都也很还这那有不没会要上下去来对把被给让吧呢吗啊哦嗯好个之其并且但而所以为之所'.split(''));

export function extractKeywords(text, limit = 8) {
  const s = String(text || '');
  const freq = new Map();
  const seen = (w) => freq.set(w, (freq.get(w) || 0) + 1);
  /**
   * ② 段内**不重叠贪心**：同一段里先挑高频的 2 字词，跟它重叠的候选直接丢。
   *    "钓到三条鲫鱼" → 钓到 / 三条 / 鲫鱼（不再出现 到三、条鲫 这种碎片）。
   */
  const picked = [];
  for (const m of s.matchAll(/[\u4e00-\u9fa5]{2,8}/g)) {
    const seg = m[0];
    const cands = [];
    for (let i = 0; i + 2 <= seg.length; i++) cands.push({ w: seg.slice(i, i + 2), i, n: 2 });
    for (let i = 0; i + 3 <= seg.length; i++) {
      const w = seg.slice(i, i + 3);
      if (!EDGE_STOP.has(w[0]) && !EDGE_STOP.has(w[2]) && !STOP.has(w)) cands.push({ w, i, n: 3 });
    }
    const ok = (c) => c.w.length >= 2 && !STOP.has(c.w) && !EDGE_STOP.has(c.w[0]) && !EDGE_STOP.has(c.w[c.w.length - 1]);
    const used = [];
    // **先 2 字、再 3 字**（2 字更可能在别处重现，列表也更好看）—— 第一版按长的优先，
    // 结果展示出一堆「末去钓 / 钓到三」这种 3 字碎片。
    for (const c of cands.filter(ok).sort((a, b) => a.n - b.n || a.i - b.i)) {
      if (used.some((u) => c.i < u.i + u.n && u.i < c.i + c.n)) continue;    // 与已选的重叠 → 丢
      used.push(c);
      picked.push(c.w);
      seen(c.w);
    }
  }
  for (const m of s.toLowerCase().matchAll(/[a-z0-9][a-z0-9_.-]{2,}/g)) {
    if (!STOP.has(m[0])) seen(m[0]);
  }
  const ranked = [...freq.entries()]
    .filter(([w, n]) => (w.length === 2 || n >= 2) && (w.match(/[\u4e00-\u9fa5]/) ? true : w.length >= 3))
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
    .map(([w]) => w);
  // ③ 兜底补位：8 个名额如果被短碎片占满、把后面更有意义的词挤掉，就按"出场顺序"再补进来
  const extra = picked.filter((w) => !ranked.includes(w));
  return [...ranked, ...extra].slice(0, Math.max(limit, 12));
}

export class SessionStore {
  constructor({ historyTurns = 12, idleTimeoutMin = 30, keepSessions = 3 } = {}) {
    this.historyTurns = historyTurns;
    this.idleMs = idleTimeoutMin * 60 * 1000;   // ⚠️ 保留字段只为兼容旧配置，**不再用来判定新会话**
    this.keepSessions = keepSessions;           // 每个对话对象保留几次压缩会话（老板定：3）
    this.cache = new Map(); // key -> { items: [], lastAt }
    this.stats = { loaded: 0, trimmed: 0, archived: 0, recalled: 0, compacted: 0 };
  }

  key(scope, peerId) { return `${scope}__${peerId}`; }

  load(botId, scope, peerId) {
    const k = this.key(scope, peerId);
    if (this.cache.has(k)) return this.cache.get(k);
    let items = [];
    try {
      items = fs.readFileSync(fileFor(botId, scope, peerId), 'utf8')
        .split(/\r?\n/).filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    } catch { /* 第一次对话，没有文件很正常 */ }
    const entry = { items, lastAt: items.length ? (items[items.length - 1].at || 0) : 0 };
    this.cache.set(k, entry);
    this.stats.loaded++;
    return entry;
  }

  /** 空闲超时则当新会话（老的留在文件里，不清） */
  isStale(entry) {
    return entry.lastAt > 0 && Date.now() - entry.lastAt > this.idleMs;
  }

  append(botId, scope, peerId, role, text) {
    const entry = this.load(botId, scope, peerId);
    const rec = { role, text, at: Date.now() };
    entry.items.push(rec);
    entry.lastAt = rec.at;
    const max = this.historyTurns * 2;
    if (entry.items.length > max) {
      entry.items = entry.items.slice(-max);
      this.stats.trimmed++;
    }
    try {
      fs.mkdirSync(dirFor(botId), { recursive: true });
      fs.appendFileSync(fileFor(botId, scope, peerId), JSON.stringify(rec) + '\r\n', 'utf8');
    } catch (e) {
      appendLog('app.log', `[${stamp()}] WARN  会话写盘失败（不影响对话）：${e.message}`);
    }
  }

  /**
   * ⚠️ 2026-10-15 起**不再**用"空闲多久"判定新会话（老板："只有用户主动让机器人开启新会话，才会开启新会话"）。
   * 保留这个方法只是为了别再有人误用；现在它永远返回 false。
   */
  isStale() { return false; }

  /** 组装给模型的 messages（system + 关键词召回的历史 + 当前会话） */
  messages(botId, scope, peerId, systemPrompt, incomingText = '') {
    const entry = this.load(botId, scope, peerId);
    const items = entry.items;                       // ← 不再有"空闲就丢上下文"
    const recalled = incomingText ? this.recall(botId, scope, peerId, incomingText) : [];
    const msgs = [{ role: 'system', content: systemPrompt }];
    if (recalled.length) {
      this.stats.recalled++;
      const note = recalled.map((r) => `【${new Date(r.endedAt).toLocaleString('zh-CN')} 那次对话的压缩记录（关键词：${r.keywords.join('、')}）】\n${r.summary}`).join('\n\n');
      msgs.push({
        role: 'system',
        content: `对方这句话提到了以前的事，下面是**那次对话的压缩记录**，请结合它回答；`
          + `这段记录只是一次性参考，不要把它当成"现在正在进行的对话"。\n\n${note}`,
      });
    }
    return [...msgs, ...items.map((i) => ({ role: i.role === 'assistant' ? 'assistant' : 'user', content: i.text }))];
  }

  reset(botId, scope, peerId) {
    this.cache.delete(this.key(scope, peerId));
    try { fs.rmSync(fileFor(botId, scope, peerId), { force: true }); } catch { /* ignore */ }
  }

  // ─────────────────────────────────────────────────────────────
  //  记忆档案：压缩会话 + 关键词 + 关键词召回
  // ─────────────────────────────────────────────────────────────
  loadMemory(botId, scope, peerId) {
    try {
      const j = JSON.parse(fs.readFileSync(memoryFor(botId, scope, peerId), 'utf8'));
      return { archives: Array.isArray(j.archives) ? j.archives : [], current: j.current || null };
    } catch { return { archives: [], current: null }; }
  }

  saveMemory(botId, scope, peerId, mem) {
    try {
      fs.mkdirSync(dirFor(botId), { recursive: true });
      fs.writeFileSync(memoryFor(botId, scope, peerId), JSON.stringify(mem, null, 2), 'utf8');
      return true;
    } catch (e) {
      appendLog('app.log', `[${stamp()}] WARN  记忆档案写盘失败（不影响对话）：${e.message}`);
      return false;
    }
  }

  /** 把一串记录压成"摘要 + 关键词" */
  #digest(items) {
    const lines = items.map((i) => {
      const who = i.role === 'assistant' ? '我' : '对方';
      return `${who}: ${String(i.text || '').replace(/\s+/g, ' ').slice(0, 80)}`;
    });
    const userText = items.filter((i) => i.role !== 'assistant').map((i) => i.text).join(' ');
    return {
      summary: lines.join('\n').slice(0, 2000),
      keywords: extractKeywords(userText, 8),
      turns: items.length,
      startedAt: items[0]?.at || Date.now(),
      endedAt: items[items.length - 1]?.at || Date.now(),
    };
  }

  /**
   * **主动开新会话**：把当前会话压成档案（带关键词）塞进记忆，当前会话清空。
   * 只保留最近 `keepSessions` 个档案（老板定：3）。
   */
  startNew(botId, scope, peerId) {
    const items = this.readAll(botId, scope, peerId);
    if (!items.length) return { archived: null, reason: '当前没有对话内容' };
    const d = this.#digest(items);
    const mem = this.loadMemory(botId, scope, peerId);
    mem.archives.push({ id: `s${Date.now().toString(36)}`, ...d });
    while (mem.archives.length > this.keepSessions) mem.archives.shift();   // 只留最近 3 次
    mem.current = null;
    this.saveMemory(botId, scope, peerId, mem);
    this.rewrite(botId, scope, peerId, []);      // 清空当前会话（档案已经存好了）
    this.stats.archived++;
    return { archived: d, kept: mem.archives.length };
  }

  /**
   * **压缩当前会话**（应用关闭时、或当前会话太长时）：保留最近 N 轮，更早的压成一行摘要 + 抽关键词，
   * 关键词记进记忆档案的 `current`。**不清空** —— 下次启动接着用（老板："下次启动的时候也都能记住"）。
   */
  compactNow(botId, scope, peerId, keepTurns = this.historyTurns) {
    const all = this.readAll(botId, scope, peerId);
    if (all.length <= Math.max(2, keepTurns)) return { before: all.length, after: all.length, keywords: [] };
    const keep = Math.max(2, keepTurns);
    const old = all.slice(0, all.length - keep);
    const recent = all.slice(-keep);
    const d = this.#digest(old);
    const items = [{ role: 'user', text: `（更早的 ${old.length} 条对话已压缩）${d.summary.replace(/\n/g, ' / ').slice(0, 1200)}`, at: old[0].at || Date.now(), digest: true }, ...recent];
    this.rewrite(botId, scope, peerId, items);
    const mem = this.loadMemory(botId, scope, peerId);
    mem.current = { ...d, compressedAt: Date.now() };
    this.saveMemory(botId, scope, peerId, mem);
    this.stats.compacted++;
    return { before: all.length, after: items.length, keywords: d.keywords };
  }

  /**
   * **关键词召回**：这条消息提到了哪次压缩会话？
   *
   * ⛔ 第一版是"拿消息抽关键词、再跟档案关键词比对"，实测**召不回**（两边抽出来的碎片不一样）。
   *    第二版改成"拿档案关键词去消息里找"，还是漏 —— 因为**没有分词器**时，档案里存的可能是
   *    「去钓」而对方问的是「钓鱼」，字面对不上（同一个词被切成了不同的碎片）。
   *    ✅ 现在方向是：**拿这次消息里抽出的词，去那次的「摘要原文」里找**（`summary.includes(词)`）。
   *       摘要原文里有"…去钓鱼了…"，所以问"钓鱼"必然命中 —— 不依赖两头切得一样。
   * 只看命中分最高的 1 段（带多了会撑爆上下文、还会串味）。
   * 每次调用都是**现算**的，所以"用完回原位、下次还得再触发"是天然的。
   */
  recall(botId, scope, peerId, text) {
    const t = String(text || '');
    if (t.length < 2) return [];
    const mem = this.loadMemory(botId, scope, peerId);
    const pool = [...mem.archives];
    if (mem.current) pool.push(mem.current);
    const hitWords = extractKeywords(t, 6);
    const scored = pool.map((a) => {
      const kws = a.keywords || [];
      const summary = String(a.summary || '');
      const inSummary = hitWords.filter((h) => h.length >= 2 && summary.includes(h)).length;   // ← 主判据
      const direct = kws.filter((k) => t.includes(k)).length;                                   // 档案词直接出现在消息里
      const soft = kws.filter((k) => hitWords.some((h) => h === k || k.includes(h) || h.includes(k))).length;
      return { ...a, score: inSummary * 2 + direct * 2 + soft, matched: [...new Set([...hitWords.filter((h) => summary.includes(h)), ...kws.filter((k) => t.includes(k))])].slice(0, 4) };
    }).filter((a) => a.score > 0).sort((a, b) => b.score - a.score);
    return scored.slice(0, 1);
  }

  /** 面板/维护页用：这个机器人的记忆概况（每个对话对象几个档案、关键词都是啥） */
  memoryOverview(botId) {
    const out = [];
    for (const f of this.list(botId)) {
      if (!f.file.endsWith('.memory.json')) continue;
      const base = f.file.replace('.memory.json', '');
      const [scope, ...peer] = base.split('__');
      let mem = { archives: [], current: null };
      try { mem = JSON.parse(fs.readFileSync(path.join(dirFor(botId), f.file), 'utf8')); } catch { /* ignore */ }
      out.push({
        peer: peer.join('__'), scope, archives: (mem.archives || []).length,
        keywords: (mem.archives || []).map((a) => (a.keywords || []).slice(0, 6).join('/')),
        currentKeywords: (mem.current?.keywords || []).slice(0, 6),
      });
    }
    return out;
  }

  /** 面板用：这个机器人有几个人/群在聊 */
  list(botId) {
    try {
      return fs.readdirSync(dirFor(botId)).map((f) => {
        const st = fs.statSync(path.join(dirFor(botId), f));
        return { file: f, bytes: st.size, updatedAt: st.mtimeMs };
      }).sort((a, b) => b.updatedAt - a.updatedAt);
    } catch { return []; }
  }

  /**
   * ── 维护用的三个方法（老板要求"能对会话上下文做清理压缩"）──
   *
   * ⚠️ 为什么要专门做：文件是**只追加**的，而模型只看到最近 N 轮 ——
   *    于是"模型不看的旧历史"在磁盘上无限堆积。压缩 = 把文件重写成"摘要 + 最近 N 轮"。
   */
  /**
   * 统计：每个对话文件的条数/字节，以及总共多大。
   * ⚠️ 方法名不能叫 `stats` —— 构造函数里已经有一个 `this.stats` 计数器，会把它盖掉（第一次就栽在这）。
   */
  overview(botId) {
    let totalBytes = 0, totalLines = 0;
    const peers = [];
    for (const f of this.list(botId)) {
      let lines = 0;
      try { lines = fs.readFileSync(path.join(dirFor(botId), f.file), 'utf8').split(/\r?\n/).filter(Boolean).length; } catch { /* ignore */ }
      totalBytes += f.bytes; totalLines += lines;
      peers.push({ file: f.file, lines, bytes: f.bytes, updatedAt: f.updatedAt });
    }
    return { peers, totalBytes, totalLines, keepTurns: this.historyTurns };
  }

  /** 读出一个对话的全部记录 */
  readAll(botId, scope, peerId) {
    try {
      return fs.readFileSync(fileFor(botId, scope, peerId), 'utf8')
        .split(/\r?\n/).filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    } catch { return []; }
  }

  /** 直接重写一个对话的历史（压缩/清理都用它）。items 会同步进内存缓存。 */
  rewrite(botId, scope, peerId, items) {
    fs.mkdirSync(dirFor(botId), { recursive: true });
    const body = items.map((i) => JSON.stringify(i)).join('\r\n');
    fs.writeFileSync(fileFor(botId, scope, peerId), body ? body + '\r\n' : '', 'utf8');
    this.cache.set(this.key(scope, peerId), {
      items: items.slice(),
      lastAt: items.length ? (items[items.length - 1].at || Date.now()) : 0,
    });
    return items.length;
  }

  /**
   * 压缩一个对话：保留最近 keepTurns 轮；更早的**每条取前 60 字**拼成一行摘要放在最前面。
   * （要"用模型总结"的智能压缩在 main.mjs 里做 —— 那需要模型通道，不属于存储层。）
   */
  compact(botId, scope, peerId, keepTurns = this.historyTurns) {
    const all = this.readAll(botId, scope, peerId);
    const keep = Math.max(2, keepTurns * 2);
    if (all.length <= keep) return { before: all.length, after: all.length, saved: 0 };
    const old = all.slice(0, all.length - keep);
    const recent = all.slice(-keep);
    const digest = old.map((i) => {
      const who = i.role === 'assistant' ? '我' : '对方';
      return `${who}: ${String(i.text || '').replace(/\s+/g, ' ').slice(0, 60)}`;
    }).join(' / ').slice(0, 1200);
    const items = [{ role: 'user', text: `（更早的 ${old.length} 条对话已压缩成摘要）${digest}`, at: old[0].at || Date.now(), digest: true }, ...recent];
    this.rewrite(botId, scope, peerId, items);
    return { before: all.length, after: items.length, saved: all.length - items.length };
  }

  /** 清空（一个对话 / 整个机器人 / 全部） */
  clear(botId, peerFile = null) {
    let n = 0;
    const files = peerFile ? [peerFile] : this.list(botId).map((x) => x.file);
    for (const f of files) {
      try { fs.rmSync(path.join(dirFor(botId), f), { force: true }); n++; } catch { /* ignore */ }
      for (const k of [...this.cache.keys()]) if (f.startsWith(k)) this.cache.delete(k);
    }
    return n;
  }
}
