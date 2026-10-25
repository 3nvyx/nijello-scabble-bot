// CMA-ES (Hansen, "The CMA Evolution Strategy: A Tutorial", 2016), plain
// (mu/mu_w, lambda) form. Minimises f; callers pass -fitness.

import { Rng } from "./rng.ts";

export interface CmaState {
  n: number;
  lambda: number;
  mean: number[];
  sigma: number;
  C: number[][];
  pc: number[];
  ps: number[];
  gen: number;
  evals: number;
  rngSeed: number;
}

export class Cma {
  readonly n: number;
  readonly lambda: number;
  readonly mu: number;
  readonly weights: number[];
  readonly mueff: number;
  readonly cc: number;
  readonly cs: number;
  readonly c1: number;
  readonly cmu: number;
  readonly damps: number;
  readonly chiN: number;
  mean: number[];
  sigma: number;
  C: number[][];
  pc: number[];
  ps: number[];
  B: number[][] = [];
  D: number[] = [];
  gen = 0;
  evals = 0;
  private eigenGen = -1;
  private rng: Rng;
  private rngSeed: number;

  constructor(mean: number[], sigma: number, lambda: number, seed: number) {
    const n = mean.length;
    this.n = n;
    this.lambda = lambda;
    this.mu = Math.floor(lambda / 2);
    const raw = Array.from({ length: this.mu }, (_, i) => Math.log(this.mu + 0.5) - Math.log(i + 1));
    const sum = raw.reduce((a, b) => a + b, 0);
    this.weights = raw.map((w) => w / sum);
    this.mueff = 1 / this.weights.reduce((a, w) => a + w * w, 0);
    const me = this.mueff;
    this.cc = (4 + me / n) / (n + 4 + (2 * me) / n);
    this.cs = (me + 2) / (n + me + 5);
    this.c1 = 2 / ((n + 1.3) ** 2 + me);
    this.cmu = Math.min(1 - this.c1, (2 * (me - 2 + 1 / me)) / ((n + 2) ** 2 + me));
    this.damps = 1 + 2 * Math.max(0, Math.sqrt((me - 1) / (n + 1)) - 1) + this.cs;
    this.chiN = Math.sqrt(n) * (1 - 1 / (4 * n) + 1 / (21 * n * n));
    this.mean = [...mean];
    this.sigma = sigma;
    this.C = identity(n);
    this.pc = new Array(n).fill(0);
    this.ps = new Array(n).fill(0);
    this.rngSeed = seed;
    this.rng = new Rng(seed);
    this.updateEigen();
  }

  static restore(s: CmaState): Cma {
    const c = new Cma(s.mean, s.sigma, s.lambda, s.rngSeed + s.gen * 7777);
    c.C = s.C.map((r) => [...r]);
    c.pc = [...s.pc];
    c.ps = [...s.ps];
    c.gen = s.gen;
    c.evals = s.evals;
    c.updateEigen();
    return c;
  }

  state(): CmaState {
    return {
      n: this.n,
      lambda: this.lambda,
      mean: this.mean,
      sigma: this.sigma,
      C: this.C,
      pc: this.pc,
      ps: this.ps,
      gen: this.gen,
      evals: this.evals,
      rngSeed: this.rngSeed,
    };
  }

  private updateEigen(): void {
    // Enforce symmetry, then decompose C = B diag(D^2) B^T.
    const n = this.n;
    for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) this.C[i]![j] = this.C[j]![i]!;
    const [vals, vecs] = jacobiEigen(this.C);
    this.D = vals.map((v) => Math.sqrt(Math.max(v, 1e-20)));
    this.B = vecs;
    this.eigenGen = this.gen;
  }

  ask(): number[][] {
    const lazyGap = Math.max(1, Math.floor(1 / ((this.c1 + this.cmu) * this.n * 10)));
    if (this.gen - this.eigenGen >= lazyGap) this.updateEigen();
    const out: number[][] = [];
    for (let k = 0; k < this.lambda; k++) {
      const z = Array.from({ length: this.n }, () => this.rng.normal());
      const y = this.mulBD(z);
      out.push(this.mean.map((m, i) => m + this.sigma * y[i]!));
    }
    return out;
  }

  private mulBD(z: number[]): number[] {
    const n = this.n;
    const dz = z.map((v, i) => v * this.D[i]!);
    const y = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = 0; j < n; j++) s += this.B[i]![j]! * dz[j]!;
      y[i] = s;
    }
    return y;
  }

  // C^{-1/2} v = B diag(1/D) B^T v
  private invSqrtC(v: number[]): number[] {
    const n = this.n;
    const t = new Array(n).fill(0);
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += this.B[i]![j]! * v[i]!;
      t[j] = s / this.D[j]!;
    }
    const out = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = 0; j < n; j++) s += this.B[i]![j]! * t[j]!;
      out[i] = s;
    }
    return out;
  }

  // xs and their costs (lower is better).
  tell(xs: number[][], costs: number[]): void {
    const n = this.n;
    const order = costs.map((c, i) => [c, i] as const).sort((a, b) => a[0] - b[0]);
    const sel = order.slice(0, this.mu).map(([, i]) => xs[i]!);
    const old = this.mean;
    const mean = new Array(n).fill(0);
    sel.forEach((x, k) => {
      for (let i = 0; i < n; i++) mean[i] += this.weights[k]! * x[i]!;
    });
    const step = mean.map((m, i) => (m - old[i]!) / this.sigma);
    const cInvStep = this.invSqrtC(step);
    const csf = Math.sqrt(this.cs * (2 - this.cs) * this.mueff);
    this.ps = this.ps.map((p, i) => (1 - this.cs) * p + csf * cInvStep[i]!);
    const psNorm = Math.sqrt(this.ps.reduce((a, b) => a + b * b, 0));
    this.gen++;
    this.evals += xs.length;
    const hsig =
      psNorm / Math.sqrt(1 - (1 - this.cs) ** (2 * this.gen)) / this.chiN < 1.4 + 2 / (n + 1) ? 1 : 0;
    const ccf = Math.sqrt(this.cc * (2 - this.cc) * this.mueff);
    this.pc = this.pc.map((p, i) => (1 - this.cc) * p + hsig * ccf * step[i]!);
    const ys = sel.map((x) => x.map((v, i) => (v - old[i]!) / this.sigma));
    const a = 1 - this.c1 - this.cmu;
    const hfix = (1 - hsig) * this.cc * (2 - this.cc);
    for (let i = 0; i < n; i++) {
      for (let j = i; j < n; j++) {
        let rankMu = 0;
        for (let k = 0; k < ys.length; k++) rankMu += this.weights[k]! * ys[k]![i]! * ys[k]![j]!;
        const v =
          a * this.C[i]![j]! +
          this.c1 * (this.pc[i]! * this.pc[j]! + hfix * this.C[i]![j]!) +
          this.cmu * rankMu;
        this.C[i]![j] = v;
        this.C[j]![i] = v;
      }
    }
    this.sigma *= Math.exp((this.cs / this.damps) * (psNorm / this.chiN - 1));
    this.mean = mean;
  }
}

function identity(n: number): number[][] {
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
}

// Cyclic Jacobi eigenvalue method for a symmetric matrix. Returns
// eigenvalues and a matrix whose columns are the eigenvectors.
export function jacobiEigen(M: number[][]): [number[], number[][]] {
  const n = M.length;
  const a = M.map((r) => [...r]);
  const v = identity(n);
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i]![j]! ** 2;
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p]![q]!;
        if (Math.abs(apq) < 1e-300) continue;
        const theta = (a[q]![q]! - a[p]![p]!) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k]![p]!;
          const akq = a[k]![q]!;
          a[k]![p] = c * akp - s * akq;
          a[k]![q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p]![k]!;
          const aqk = a[q]![k]!;
          a[p]![k] = c * apk - s * aqk;
          a[q]![k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k]![p]!;
          const vkq = v[k]![q]!;
          v[k]![p] = c * vkp - s * vkq;
          v[k]![q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return [a.map((r, i) => r[i]!), v];
}
