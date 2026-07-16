// permissions.js - in-memory handoff between a Claude hook and the panel UI.
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const SWEEP_INTERVAL_MS = 10 * 1000;

class PermissionStore {
  constructor(onUpdate, options = {}) {
    this.requests = new Map();
    this.onUpdate = onUpdate || (() => {});
    this.ttlMs = options.ttlMs || DEFAULT_TTL_MS;
    this._sweepTimer = setInterval(() => this._sweep(), SWEEP_INTERVAL_MS);
    if (typeof this._sweepTimer.unref === "function") this._sweepTimer.unref();
  }

  dispose() {
    clearInterval(this._sweepTimer);
  }

  add(request) {
    this._sweep();
    const existing = this.requests.get(request.req_id);
    if (existing) return existing;

    const item = {
      ...request,
      decision: null,
      receivedAt: Date.now(),
    };
    this.requests.set(item.req_id, item);
    this._emit();
    return item;
  }

  resolve(reqId, decision) {
    this._sweep();
    if (decision !== "allow" && decision !== "deny") return false;
    const item = this.requests.get(reqId);
    if (!item) return false;
    if (item.decision !== null) return item.decision === decision;

    item.decision = decision;
    item.resolvedAt = Date.now();
    this._emit();
    return true;
  }

  get(reqId) {
    this._sweep();
    return this.requests.get(reqId) || null;
  }

  snapshot() {
    this._sweep();
    return this._pendingSnapshot();
  }

  _pendingSnapshot() {
    return [...this.requests.values()]
      .filter((item) => item.decision === null)
      .map(({ receivedAt, resolvedAt, decision, ...item }) => item);
  }

  _sweep() {
    const now = Date.now();
    let changed = false;
    for (const [reqId, item] of this.requests) {
      if (now - item.receivedAt >= this.ttlMs) {
        this.requests.delete(reqId);
        changed = true;
      }
    }
    if (changed) this._emit();
  }

  _emit() {
    this.onUpdate(this._pendingSnapshot());
  }
}

module.exports = { PermissionStore, DEFAULT_TTL_MS };
