// Censored (Tobit) linear regression: y* = w.x + sigma * eps, eps ~ N(0, 1).
// Each observation is either exact (y* = y) or censored from above
// (y* <= c). Used to fit live bots' bids: the winner's bid is public, a
// loser's is only known to be at most the price paid.

export interface Obs {
  x: ArrayLike<number>;
  y: number; // exact value, or the upper bound when censored
  censored: boolean;
}

export interface TobitFit {
  w: number[];
  sigma: number;
  logLik: number; // mean per observation
}

const LOG_SQRT_2PI = 0.5 * Math.log(2 * Math.PI);

// log(erfc(x)) for x >= 0 (Numerical Recipes erfcc, relative error < 1.2e-7),
// computed in log space so it doesn't underflow far in the tail.
function logErfcPos(x: number): number {
  const t = 1 / (1 + 0.5 * x);
  const poly =
    -1.26551223 +
    t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 +
      t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))));
  return Math.log(t) - x * x + poly;
}

// log Phi(u), the standard normal log CDF.
export function logNormCdf(u: number): number {
  const x = -u / Math.SQRT2;
  if (x >= 0) return Math.log(0.5) + logErfcPos(x);
  return Math.log(1 - 0.5 * Math.exp(logErfcPos(-x)));
}

// phi(u) / Phi(u), the inverse Mills ratio, stable for very negative u.
function mills(u: number): number {
  return Math.exp(-0.5 * u * u - LOG_SQRT_2PI - logNormCdf(u));
}

// Maximum likelihood by full-batch Adam on (w, log sigma), with a small
// ridge penalty so a bot with few observations still gets a sane fit.
export function fitTobit(obs: Obs[], dim: number, iters = 1500, ridge = 1e-3): TobitFit {
  const exact = obs.filter((o) => !o.censored);
  const w = new Array<number>(dim).fill(0);
  w[0] = exact.length ? exact.reduce((a, o) => a + o.y, 0) / exact.length : 0;
  let s = 0; // log sigma
  const m = new Array<number>(dim + 1).fill(0);
  const v = new Array<number>(dim + 1).fill(0);
  const g = new Array<number>(dim + 1).fill(0);
  const lr = 0.05;
  const n = Math.max(1, obs.length);
  let ll = 0;
  for (let it = 1; it <= iters; it++) {
    g.fill(0);
    ll = 0;
    const sigma = Math.exp(s);
    for (const o of obs) {
      let mu = 0;
      for (let i = 0; i < dim; i++) mu += w[i]! * o.x[i]!;
      let dMu: number;
      let dS: number;
      if (o.censored) {
        const u = (o.y - mu) / sigma;
        ll += logNormCdf(u);
        const r = mills(u);
        dMu = -r / sigma;
        dS = -r * u;
      } else {
        const z = (o.y - mu) / sigma;
        ll += -s - LOG_SQRT_2PI - 0.5 * z * z;
        dMu = z / sigma;
        dS = -1 + z * z;
      }
      for (let i = 0; i < dim; i++) g[i]! += dMu * o.x[i]!;
      g[dim]! += dS;
    }
    // Ascend the mean log-likelihood minus the ridge penalty (not on the intercept).
    for (let i = 0; i <= dim; i++) {
      let gi = g[i]! / n;
      if (i > 0 && i < dim) gi -= ridge * w[i]!;
      m[i] = 0.9 * m[i]! + 0.1 * gi;
      v[i] = 0.999 * v[i]! + 0.001 * gi * gi;
      const step = (lr * (m[i]! / (1 - 0.9 ** it))) / (Math.sqrt(v[i]! / (1 - 0.999 ** it)) + 1e-8);
      if (i < dim) w[i]! += step;
      else s += step;
    }
  }
  return { w, sigma: Math.exp(s), logLik: ll / n };
}
