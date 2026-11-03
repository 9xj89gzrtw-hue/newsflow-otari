/**
 * Per-user budgets, on top of the per-run budget.
 *
 * `Budget` in otari.mjs stops one run from overspending. It cannot stop one
 * person from starting a hundred runs, because it dies with the request. This
 * store is the other half: a window per user, keyed by `X-User-Id`, a browser
 * session cookie, or a hash of the address, checked before the work starts.
 *
 * The reservation is taken before the first model call and corrected to the
 * actual usage afterwards, so two requests racing for the last of a budget
 * cannot both pass the check.
 */

export class UserBudgetError extends Error {
  constructor(message, { retryAfterSeconds = 60, snapshot = null } = {}) {
    super(message);
    this.name = "UserBudgetError";
    this.retryAfterSeconds = retryAfterSeconds;
    this.snapshot = snapshot;
  }
}

const clean = (n, fallback) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback);

export class UserBudgetStore {
  /**
   * @param {object} o
   * @param {number} [o.maxTokens]  tokens one user may spend in a window
   * @param {number} [o.maxRuns]    runs one user may start in a window
   * @param {number} [o.windowMs]   how long a window lasts
   * @param {() => number} [o.now]  injectable clock, so tests are not slow
   */
  constructor({ maxTokens = 60000, maxRuns = 6, windowMs = 60 * 60 * 1000, now = () => Date.now() } = {}) {
    this.maxTokens = clean(maxTokens, 60000);
    this.maxRuns = clean(maxRuns, 6);
    this.windowMs = clean(windowMs, 60 * 60 * 1000);
    this.now = now;
    this.users = new Map();
  }

  _entry(userId) {
    const at = this.now();
    let entry = this.users.get(userId);
    if (!entry || at >= entry.resetAt) {
      entry = { tokens: 0, runs: 0, resetAt: at + this.windowMs };
      this.users.set(userId, entry);
    }
    return entry;
  }

  /** What is left, without touching anything. */
  snapshot(userId) {
    const entry = this._entry(userId);
    return {
      userId,
      tokens: entry.tokens,
      runs: entry.runs,
      maxTokens: this.maxTokens,
      maxRuns: this.maxRuns,
      remainingTokens: Math.max(0, this.maxTokens - entry.tokens),
      remainingRuns: Math.max(0, this.maxRuns - entry.runs),
      resetAt: new Date(entry.resetAt).toISOString(),
      windowMs: this.windowMs
    };
  }

  /**
   * Take the estimated cost of a run before it starts. Throws instead of
   * returning false so a caller cannot forget to check the result.
   * @returns {{commit:(usedTokens:number)=>object, release:()=>void, snapshot:object}}
   */
  reserve(userId, { tokens = 0, runs = 1 } = {}) {
    const entry = this._entry(userId);
    const before = this.snapshot(userId);
    if (entry.runs + runs > this.maxRuns) {
      throw new UserBudgetError(
        `this user has started ${entry.runs} of ${this.maxRuns} runs in the current window`,
        { retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - this.now()) / 1000)), snapshot: before }
      );
    }
    if (entry.tokens + tokens > this.maxTokens) {
      throw new UserBudgetError(
        `this run needs ${tokens} tokens and the user has ${Math.max(0, this.maxTokens - entry.tokens)} left`,
        { retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - this.now()) / 1000)), snapshot: before }
      );
    }

    const reserved = { tokens: Math.max(0, Math.floor(tokens)), runs };
    entry.tokens += reserved.tokens;
    entry.runs += reserved.runs;

    return {
      commit: (usedTokens) => {
        const actual = Math.max(0, Math.floor(Number(usedTokens) || 0));
        entry.tokens = Math.max(0, entry.tokens - reserved.tokens + actual);
        return this.snapshot(userId);
      },
      release: () => {
        entry.tokens = Math.max(0, entry.tokens - reserved.tokens);
        entry.runs = Math.max(0, entry.runs - reserved.runs);
        return this.snapshot(userId);
      },
      snapshot: this.snapshot(userId)
    };
  }

  /** Drop windows that have already reset, so a long-lived process does not
   *  keep one entry per visitor for ever. */
  sweep() {
    const at = this.now();
    let dropped = 0;
    for (const [userId, entry] of this.users) {
      if (at >= entry.resetAt) {
        this.users.delete(userId);
        dropped += 1;
      }
    }
    return dropped;
  }
}
