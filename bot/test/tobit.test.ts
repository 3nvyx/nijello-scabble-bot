import assert from "node:assert/strict";
import { test } from "node:test";
import { Rng } from "../src/rng.ts";
import { fitTobit, logNormCdf, type Obs } from "../src/tobit.ts";

test("logNormCdf matches known values and stays finite in the tail", () => {
  assert.ok(Math.abs(logNormCdf(0) - Math.log(0.5)) < 1e-6);
  assert.ok(Math.abs(Math.exp(logNormCdf(1.959964)) - 0.975) < 1e-6);
  assert.ok(Math.abs(Math.exp(logNormCdf(-1.959964)) - 0.025) < 1e-6);
  // log Phi(-30) = about -454.3; a naive log(Phi) would be -Infinity.
  assert.ok(Math.abs(logNormCdf(-30) + 454.32) < 0.05);
});

test("fitTobit recovers weights and noise when most observations are censored", () => {
  // Like auction data: the winner's bid is exact, losers only bounded above.
  const rng = new Rng(7);
  const trueW = [1.0, 2.0, -0.5];
  const sigma = 0.5;
  const obs: Obs[] = [];
  for (let k = 0; k < 24000; k++) {
    const x = [1, rng.float() * 2, rng.float()];
    const y = trueW[0]! * x[0]! + trueW[1]! * x[1]! + trueW[2]! * x[2]! + sigma * rng.normal();
    const bound = 2 + 3 * rng.float();
    obs.push(y <= bound ? { x, y: bound, censored: true } : { x, y, censored: false });
  }
  assert.ok(obs.filter((o) => o.censored).length > 12000, "test should be mostly censored");
  // Across seeds at 6000 observations the intercept's spread is about 0.05
  // (two thirds censored); at 24000 it is about 0.025, so 0.1 is 4 SD.
  const fit = fitTobit(obs, 3, 800, 0);
  fit.w.forEach((w, i) => assert.ok(Math.abs(w - trueW[i]!) < 0.1, `w${i} ${w} vs ${trueW[i]}`));
  assert.ok(Math.abs(fit.sigma - sigma) < 0.05, `sigma ${fit.sigma}`);
});
