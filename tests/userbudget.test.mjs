import { test } from "node:test";
import assert from "node:assert/strict";
import { UserBudgetStore, UserBudgetError } from "../lib/userBudget.mjs";

test("a reservation is counted before the work starts, and corrected after it", () => {
  const store = new UserBudgetStore({ maxTokens: 1000, maxRuns: 2, windowMs: 60000, now: () => 0 });
  const reservation = store.reserve("alice", { tokens: 600, runs: 1 });
  assert.equal(store.snapshot("alice").tokens, 600);
  assert.equal(store.snapshot("alice").remainingRuns, 1);

  reservation.commit(420);
  const after = store.snapshot("alice");
  assert.equal(after.tokens, 420);
  assert.equal(after.runs, 1);
});

test("two racing requests cannot both spend the last of a budget", () => {
  const store = new UserBudgetStore({ maxTokens: 1000, maxRuns: 5, windowMs: 60000, now: () => 0 });
  store.reserve("bob", { tokens: 800 });
  assert.throws(
    () => store.reserve("bob", { tokens: 400 }),
    (err) => err instanceof UserBudgetError && /tokens and the user has 200 left/.test(err.message)
  );
});

test("the run limit is per user, not per request", () => {
  const store = new UserBudgetStore({ maxTokens: 1e6, maxRuns: 2, windowMs: 60000, now: () => 0 });
  store.reserve("carol");
  store.reserve("carol");
  assert.throws(
    () => store.reserve("carol"),
    (err) => err instanceof UserBudgetError && /2 of 2 runs/.test(err.message)
  );
  // another user is untouched
  assert.equal(store.snapshot("dave").remainingRuns, 2);
});

test("a refused request says how long to wait, and the window then reopens", () => {
  let at = 1000;
  const store = new UserBudgetStore({ maxTokens: 1e6, maxRuns: 1, windowMs: 60000, now: () => at });
  store.reserve("erin");
  let wait = 0;
  try {
    store.reserve("erin");
  } catch (err) {
    wait = err.retryAfterSeconds;
  }
  assert.equal(wait, 60);

  at += 60001;
  const after = store.snapshot("erin");
  assert.equal(after.runs, 0);
  assert.equal(after.remainingRuns, 1);
  assert.equal(store.reserve("erin").snapshot.runs, 1);
});

test("releasing a failed run gives the budget back", () => {
  const store = new UserBudgetStore({ maxTokens: 1000, maxRuns: 2, windowMs: 60000, now: () => 0 });
  const reservation = store.reserve("frank", { tokens: 700, runs: 1 });
  reservation.release();
  const after = store.snapshot("frank");
  assert.equal(after.tokens, 0);
  assert.equal(after.runs, 0);
});

test("sweep drops expired windows only", () => {
  let at = 0;
  const store = new UserBudgetStore({ maxTokens: 1000, maxRuns: 2, windowMs: 1000, now: () => at });
  store.reserve("gone");
  at = 2000;
  store.reserve("fresh");
  assert.equal(store.sweep(), 1);
  assert.equal(store.users.has("gone"), false);
  assert.equal(store.users.has("fresh"), true);
});
