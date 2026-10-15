/**
 * queue.mjs —— 每个对话对象一条串行队列。**这是今天最关键的一处修复。**
 *
 * 【为什么要重写这部分】DSH 那个插件用的是 `concurrencyGuard({strategy:'merge'})`：
 * 同一个群/同一个人，上一轮没结束时新消息被**静默缓存**，中途一句话都不回，
 * 而且 `maxProcessingMs` 默认 **30 分钟**。老板的实际体验就是"@ 它没反应"——
 * 消息没丢，但看上去跟坏了没区别。**没有反馈的等待等于故障。**
 *
 * 这里的规矩（每条都对应一次踩坑）：
 *   ① 排队**立刻回执**："上一条还在处理，这条排第 N 位"（同一个人 30 秒内只回一次，免得刷屏）
 *   ② 处理有**硬上限**（默认 5 分钟）：超时就中断、释放锁、明确告诉对方"这轮超时了，重发一次"
 *   ③ 无论成功/失败/异常/超时，锁**一定**释放（finally + 超时兜底两重）
 *   ④ 队列满了**明确拒绝**并说明，绝不静默丢弃
 *   ⑤ 每一步（入队/出队/开始/结束/超时/放弃）都留痕
 */
import { stamp } from './util.mjs';

export class PeerQueue {
  /**
   * @param {object} o
   * @param {(task)=>Promise<void>} o.runner 真正干活的函数（收一条消息并处理完）
   * @param {(info)=>void} o.onAck          需要回执时调用（排队中/超时/放弃都走它）
   * @param {object} o.log                  日志器
   */
  constructor({ name, runner, onAck, log, maxQueue = 20, maxProcessingMs = 5 * 60 * 1000, ackThrottleMs = 30000 }) {
    this.name = name;
    this.runner = runner;
    this.onAck = onAck || (() => {});
    this.log = log;
    this.maxQueue = maxQueue;
    this.maxProcessingMs = maxProcessingMs;
    this.ackThrottleMs = ackThrottleMs;
    this.lanes = new Map(); // peerKey -> { busy, queue: [], lastAckAt, activeSince }
    this.stats = { received: 0, processed: 0, acked: 0, rejected: 0, timedOut: 0, failed: 0 };
  }

  lane(key) {
    let l = this.lanes.get(key);
    if (!l) { l = { key, busy: false, queue: [], lastAckAt: 0, activeSince: 0 }; this.lanes.set(key, l); }
    return l;
  }

  /**
   * 投递一条消息。永远不会抛异常给调用方（入站处理不许因为队列问题炸掉）。
   * @returns {Promise<'processed'|'queued'|'rejected'>}
   */
  async push(key, task) {
    const l = this.lane(key);
    this.stats.received++;

    if (l.busy) {
      if (l.queue.length >= this.maxQueue) {
        this.stats.rejected++;
        this.log.trace(`DROP queue-full peer=${key} depth=${l.queue.length} max=${this.maxQueue}`);
        try { await this.onAck(task.ctx, { kind: 'rejected', depth: l.queue.length }); } catch { /* ignore */ }
        return 'rejected';
      }
      l.queue.push(task);
      this.log.trace(`QUEUED peer=${key} depth=${l.queue.length}`);
      // ① 立刻回执（节流，避免连发几条时刷屏）
      const now = Date.now();
      if (now - l.lastAckAt > this.ackThrottleMs) {
        l.lastAckAt = now;
        this.stats.acked++;
        try { await this.onAck(task.ctx, { kind: 'queued', depth: l.queue.length }); } catch { /* ignore */ }
      }
      return 'queued';
    }

    l.busy = true;
    l.activeSince = Date.now();
    await this.#drain(l, task);
    return 'processed';
  }

  async #drain(l, task) {
    let current = task;
    // 串行处理这一条 + 队列里排着的（一条一条来，同一个人不会被两个回合同时改上下文）
    for (;;) {
      const started = Date.now();
      let timer = null;
      const timedOut = Symbol('timeout');
      try {
        this.log.trace(`START peer=${l.key} since=${stamp(new Date(started))} waiting=${l.queue.length}`);
        const result = await Promise.race([
          this.runner(current),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(timedOut), current.maxProcessingMs || this.maxProcessingMs);
          }),
        ]);
        if (result === timedOut) {
          this.stats.timedOut++;
          this.log.error(`超时：peer=${l.key} 超过 ${Math.round((current.maxProcessingMs || this.maxProcessingMs) / 1000)}s 仍未处理完 —— 中断并释放锁`);
          try { current.onTimeout?.(); } catch { /* ignore */ }
          try { await this.onAck(current.ctx, { kind: 'timeout', ms: Date.now() - started }); } catch { /* ignore */ }
        } else {
          this.stats.processed++;
          this.log.trace(`DONE peer=${l.key} 用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
        }
      } catch (e) {
        this.stats.failed++;
        this.log.error(`处理异常：peer=${l.key} ${e && e.message}`);
        this.log.trace(`ERROR peer=${l.key} ${String(e && e.stack || e).slice(0, 400).replace(/\s+/g, ' ')}`);
        try { await this.onAck(current.ctx, { kind: 'error', message: String(e && e.message) }); } catch { /* ignore */ }
      } finally {
        if (timer) clearTimeout(timer);
      }

      const next = l.queue.shift();
      if (!next) {
        // ③ 一定释放
        l.busy = false;
        l.activeSince = 0;
        if (!l.queue.length) this.lanes.delete(l.key);
        return;
      }
      this.log.trace(`DEQUEUE peer=${l.key} 剩余=${l.queue.length}`);
      current = next;
    }
  }

  snapshot() {
    const lanes = [...this.lanes.values()].map((l) => ({
      peer: l.key,
      busy: l.busy,
      depth: l.queue.length,
      activeSec: l.activeSince ? Math.round((Date.now() - l.activeSince) / 1000) : 0,
    }));
    return { ...this.stats, lanes, busyLanes: lanes.filter((x) => x.busy).length, queued: lanes.reduce((n, x) => n + x.depth, 0) };
  }
}
