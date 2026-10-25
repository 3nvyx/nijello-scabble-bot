// Live terminal dashboard for a training run. Run it on the machine doing
// the training (it reads that machine's /proc and nvidia-smi):
//
//   node src/dashboard.ts --run runs/main
//   ssh -t asus@<gx10-tailscale-ip> 'cd ~/scrabblebot-evo && node src/dashboard.ts --run runs/main'

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cpus, hostname, loadavg, totalmem } from "node:os";
import { latencyStats, peakAge } from "./latency.ts";

const runArg = process.argv.indexOf("--run");
const RUN = runArg >= 0 ? process.argv[runArg + 1]! : "runs/main";
const root = new URL("..", import.meta.url).pathname;

const ESC = "\x1b[";
const bold = (s: string) => `${ESC}1m${s}${ESC}0m`;
const dim = (s: string) => `${ESC}2m${s}${ESC}0m`;
const green = (s: string) => `${ESC}32m${s}${ESC}0m`;
const yellow = (s: string) => `${ESC}33m${s}${ESC}0m`;
const cyan = (s: string) => `${ESC}36m${s}${ESC}0m`;
const red = (s: string) => `${ESC}31m${s}${ESC}0m`;

function bar(frac: number, width: number): string {
  const f = Math.max(0, Math.min(1, frac));
  const full = Math.round(f * width);
  const color = f > 0.85 ? green : f > 0.4 ? yellow : dim;
  return color("█".repeat(full)) + dim("░".repeat(width - full));
}

function pct(x: number): string {
  return `${(100 * x).toFixed(1)}%`;
}

function dur(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h${String(m).padStart(2, "0")}m${String(s % 60).padStart(2, "0")}s`;
}

let lastCpu: number[][] | null = null;
function cpuUsage(): number[] {
  try {
    const lines = readFileSync("/proc/stat", "utf8").split("\n").filter((l) => /^cpu\d+ /.test(l));
    const now = lines.map((l) => l.trim().split(/\s+/).slice(1).map(Number));
    const prev = lastCpu;
    lastCpu = now;
    if (!prev) return now.map(() => 0);
    return now.map((v, i) => {
      const p = prev[i] ?? v;
      const idle = v[3]! + v[4]! - (p[3]! + p[4]!);
      const total = v.reduce((a, b) => a + b, 0) - p.reduce((a, b) => a + b, 0);
      return total > 0 ? 1 - idle / total : 0;
    });
  } catch {
    return [];
  }
}

function memInfo(): { used: number; total: number } {
  try {
    const t = readFileSync("/proc/meminfo", "utf8");
    const get = (k: string) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(t)?.[1] ?? 0) * 1024;
    return { used: get("MemTotal") - get("MemAvailable"), total: get("MemTotal") };
  } catch {
    return { used: 0, total: totalmem() };
  }
}

interface Gpu {
  name: string;
  util: number;
  memUsed: number;
  memTotal: number;
  temp: number;
  power: number;
}
function gpuInfo(): Gpu[] {
  try {
    const out = execFileSync(
      "nvidia-smi",
      ["--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw", "--format=csv,noheader,nounits"],
      { encoding: "utf8", timeout: 3000 },
    );
    return out
      .trim()
      .split("\n")
      .map((l) => {
        const [name, util, mu, mt, temp, power] = l.split(",").map((x) => x.trim());
        return { name: name!, util: Number(util) / 100, memUsed: Number(mu), memTotal: Number(mt), temp: Number(temp), power: Number(power) };
      });
  } catch {
    return [];
  }
}

// Line chart of ys in a width x height grid of text cells.
function chart(series: { ys: number[]; mark: string; color: (s: string) => string }[], width: number, height: number): string[] {
  const all = series.flatMap((s) => s.ys).filter(Number.isFinite);
  if (all.length === 0) return [dim("  (no data yet)")];
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (hi - lo < 1e-9) {
    hi += 0.01;
    lo -= 0.01;
  }
  const grid: string[][] = Array.from({ length: height }, () => Array(width).fill(" "));
  for (const s of series) {
    const n = s.ys.length;
    if (n === 0) continue;
    for (let x = 0; x < width; x++) {
      if (n === 1 && x > 0) break;
      const i = n === 1 ? 0 : Math.round((x * (n - 1)) / (width - 1));
      const y = s.ys[i]!;
      if (!Number.isFinite(y)) continue;
      const row = height - 1 - Math.round(((y - lo) / (hi - lo)) * (height - 1));
      grid[row]![x] = s.color(s.mark);
    }
  }
  return grid.map((r, i) => {
    const v = hi - ((hi - lo) * i) / (height - 1);
    const label = i === 0 || i === height - 1 || i === Math.floor(height / 2) ? v.toFixed(3).padStart(7) : " ".repeat(7);
    return `${dim(label)} ${dim("│")}${r.join("")}`;
  });
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function render(): void {
  const cols = Math.max(80, process.stdout.columns ?? 100);
  const W = Math.min(cols - 12, 110);
  const st = readJson(`${RUN}/status.json`);
  const field = readJson(`${root}data/field.json`);
  const lines: string[] = [];
  const now = Date.now();
  lines.push(bold(cyan(" SCRABBLEBOT EVOLUTION ")) + dim(` ${hostname()} · ${RUN} · ${new Date().toLocaleTimeString()}`));
  lines.push(dim("─".repeat(Math.min(cols, 120))));

  if (!st) {
    lines.push(yellow(`  waiting for ${RUN}/status.json (the first generation writes it)`));
  } else {
    const elapsed = st.elapsedMs + (now - Date.parse(st.updatedAt));
    const left = Date.parse(st.deadline) - now;
    const stale = now - Date.parse(st.updatedAt) > 5 * 60_000;
    const state = st.finished ? green("FINISHED") : stale ? red("STALLED?") : green("RUNNING");
    lines.push(
      `  ${bold("Status")} ${state}   ${bold("Generation")} ${bold(String(st.gen))}   ` +
        `${bold("Elapsed")} ${dur(elapsed)}   ${bold("Left")} ${st.finished ? "-" : dur(left)}`,
    );
    const gens = st.history as any[];
    const avgRate = st.totalGames / Math.max(1, elapsed / 1000);
    const k = Math.min(10, gens.length - 1);
    const perGen = k > 0 ? (gens.at(-1).t - gens.at(-1 - k).t) / k : 0;
    lines.push(
      `  ${bold("Games played")} ${bold(st.totalGames.toLocaleString())}   ${bold("Speed")} ${st.gamesPerSec.toFixed(0)} games/s now, ` +
        `${avgRate.toFixed(0)} avg   ${bold("Per generation")} ${st.lambda} candidates × ${st.gamesPerCandidate} games` +
        (perGen ? `, ${(perGen / 1000).toFixed(1)} s` : ""),
    );
    lines.push(`  ${bold("Search step σ")} ${st.sigma.toFixed(3)}   ${bold("Hall of fame")} ${st.hofSize} past champions`);
    lines.push("");

    const bench = st.bench as any[];
    if (bench.length) {
      const b0 = bench[0];
      const b = bench.at(-1);
      lines.push(bold("  How good is the bot")+ dim(`  (benchmark at generation ${b.gen}; first row = generation ${b0.gen})`));
      const row = (label: string, key: string, note: string) => {
        if (!b[key]) return;
        const w = b[key].win;
        const w0 = b0[key]?.win ?? NaN;
        const d = w - w0;
        const ds = Number.isFinite(d) ? (d >= 0 ? green(`+${(100 * d).toFixed(1)}`) : red((100 * d).toFixed(1))) : "";
        lines.push(
          `   ${label.padEnd(30)} win ${pct(w).padStart(6)} ${bar(w, 20)} ${ds.padEnd(16)} ` +
            `place ${b[key].place.toFixed(3)}  score ${b[key].score.toFixed(1).padStart(6)}  ${dim(note)}`,
        );
      };
      row("vs REAL FIELD (top + market)", "vsField", "the training target");
      row("vs 5 top-live-bot models", "vsTop", "fitted per live bot");
      row("vs 5 real-field models", "vsMarket", "bids drawn from live data");
      row("vs 5 copies of gen-0 bot", "vsDefault", "fair share = 16.7%");
      row("vs league (past champions)", "vsLeague", "self-play field");
      row("vs 5 server sims", "vsSims", "lobby filler bots");
      row("vs 5 starter-kit bots", "vsStarter", "untuned teams");
      if (st.peak)
        lines.push(
          `   ${bold("Peak vs field")} gen ${st.peak.gen}: win ${pct(st.peak.win)}, place ${st.peak.place.toFixed(3)} ` +
            dim("(confirmed on 3000 fresh games; this is what best.json and the live bot use)"),
        );
      const pa = peakAge(st);
      if (pa)
        lines.push(
          `   ${bold("Improvement rate")} ` +
            (pa.gensSince > 0
              ? yellow(`no confirmed improvement for ${pa.gensSince} generations (${dur(pa.trainMsSince)} of training)`)
              : green("new peak this generation")),
        );
      if (b.perBot?.length) {
        lines.push(dim("   Head to head vs 5 copies of each top live bot's model:"));
        const cells = b.perBot.map((p: any) => `${p.name.slice(0, 13).padEnd(13)} ${pct(p.win).padStart(6)}`);
        for (let i = 0; i < cells.length; i += 4) lines.push("     " + cells.slice(i, i + 4).join("   "));
      }
      lines.push("");
    }

    lines.push(bold("  Improvement") + dim("  fitness per generation: ") + green("● mean of candidates") + dim("  ") + yellow("● best candidate"));
    lines.push(...chart([
      { ys: gens.map((g) => g.fitBest), mark: "•", color: yellow },
      { ys: gens.map((g) => g.fitMean), mark: "●", color: green },
    ], W, 9));
    if (bench.length > 1) {
      lines.push(bold("  Win rate vs real field") + dim("  ") + green("● field (top + market)") + dim("  ") + cyan("● top-bot models"));
      const series = [
        { ys: bench.map((b) => b.vsField?.win ?? b.vsMarket?.win ?? NaN), mark: "●", color: green },
        { ys: bench.map((b) => b.vsTop?.win ?? NaN), mark: "•", color: cyan },
      ];
      lines.push(...chart(series, W, 6));
    }
    lines.push("");
  }

  const mon = readJson(`${root}runs/monitor/status.json`);
  if (mon) {
    const r = mon.record;
    // The monitor rewrites its status every 30 s; an old file means it died
    // and every field below is stale.
    const age = Date.now() - Date.parse(mon.updatedAt);
    const state =
      age > 120_000 ? red(`monitor not running (status ${dur(age)} old)`) : mon.connected ? green("ONLINE") : red("OFFLINE");
    lines.push(
      bold(`  Live bot ${mon.bot}`) + `  ${state}` + (mon.inMatch ? `  in match ${mon.inMatch}` : dim("  in lobby")) +
        `   ${bold(String(r.wins))} wins in ${r.matches} real matches  avg place ${r.avgPlace.toFixed(2)}  avg score ${r.avgScore.toFixed(0)}  last 10: ${r.last10Wins} wins`,
    );
    const recent = (mon.recent ?? []).slice(-8);
    if (recent.length)
      lines.push(
        "   " +
          recent
            .map((m: any) => (m.place === 1 ? green : m.place === 2 ? yellow : red)(`#${m.match} ${m.place}/${m.players} ${m.score}`))
            .join(dim(" · ")),
      );
    const lat = latencyStats(`${root}live/${mon.bot}.log`);
    if (lat)
      lines.push(
        dim("   Decision time ") +
          `median ${lat.medianMs} ms, p99 ${lat.p99Ms} ms, max ${lat.maxMs} ms` +
          dim(` of a 1000 ms auction · late bids `) +
          (lat.late ? yellow(`${lat.late} of ${lat.decisions}`) : green(`0 of ${lat.decisions}`)),
      );
    for (const a of mon.alerts ?? []) lines.push(`   ${red("!")} ${a}`);
    const llm = mon.llm;
    if (llm.model !== "off")
      lines.push(
      dim(`   ${llm.model} on GPU: `) + (llm.available ? green("ready") : yellow("downloading / not loaded")) +
        (llm.note ? dim(`  review of match ${llm.lastMatch}:`) : ""),
    );
    if (llm.note)
      for (const l of String(llm.note).split("\n").filter((x: string) => x.trim()).slice(0, 4))
        lines.push(`     ${l.slice(0, Math.min(cols, 120) - 6)}`);
    lines.push("");
  }

  const usage = cpuUsage();
  const avg = usage.length ? usage.reduce((a, b) => a + b, 0) / usage.length : 0;
  const mem = memInfo();
  const gpus = gpuInfo();
  lines.push(bold("  Machine") + dim(`  ${cpus()[0]?.model ?? ""} · ${usage.length} cores · load ${loadavg().map((x) => x.toFixed(1)).join(" ")}`));
  lines.push(`   CPU  ${bar(avg, 40)} ${pct(avg)}`);
  const perRow = 10;
  for (let i = 0; i < usage.length; i += perRow)
    lines.push("        " + usage.slice(i, i + perRow).map((u, k) => `${dim(String(i + k).padStart(2))} ${bar(u, 6)}`).join(" "));
  lines.push(`   RAM  ${bar(mem.used / mem.total, 40)} ${(mem.used / 2 ** 30).toFixed(1)} / ${(mem.total / 2 ** 30).toFixed(0)} GiB`);
  for (const g of gpus) {
    const memTxt = Number.isFinite(g.memTotal) ? `${(g.memUsed / 1024).toFixed(1)}/${(g.memTotal / 1024).toFixed(0)} GiB` : "unified memory";
    lines.push(`   GPU  ${bar(g.util, 40)} ${pct(g.util)}  ${g.name} · ${memTxt} · ${g.temp}°C · ${Number.isFinite(g.power) ? g.power.toFixed(0) + " W" : ""}`);
  }
  if (gpus.length === 0) lines.push(dim("   GPU  (nvidia-smi not available here)"));
  lines.push("");

  lines.push(bold("  Spare capacity"));
  const idleCores = usage.filter((u) => u < 0.5).length;
  const tips: string[] = [];
  if (idleCores > 1) tips.push(`${idleCores} cores under 50% busy: raise --workers, or run a second seed in parallel for a better final pick`);
  else tips.push("CPU is saturated by the evolution run: good, nothing left on the table there");
  if (gpus.every((g) => g.util < 0.2))
    tips.push("GPU idle: train a value network on the millions of simulated racks, or batch Monte Carlo letter values on CUDA");
  tips.push(`${((mem.total - mem.used) / 2 ** 30).toFixed(0)} GiB RAM free: room for a big endgame word-set cache or a larger hall of fame`);
  tips.push("Always-on host: run the live bot here 24/7 to climb the ELO ladder and log real opponents");
  for (const t of tips) lines.push(`   ${dim("·")} ${t}`);

  if (field?.leaderboard?.length) {
    lines.push("");
    lines.push(bold("  Live field") + dim(`  top real bots by rating on scrabblebot.spacetimedb.com (${field.matches} matches, fetched ${new Date(field.fetchedAt).toLocaleTimeString()})`));
    for (const b of field.leaderboard.slice(0, 10))
      lines.push(`   ${b.name.slice(0, 18).padEnd(18)} rating ${String(b.rating ?? "?").padStart(4)}  avg ${b.avgScore.toFixed(1).padStart(6)}  place ${b.avgPlace.toFixed(2)}  win ${pct(b.winRate).padStart(6)}  ${dim(`${b.matches} matches`)}`);
  }

  process.stdout.write(`${ESC}H${ESC}2J` + lines.join("\n") + "\n");
}

if (!existsSync(RUN)) console.log(`run directory ${RUN} not found yet; waiting...`);
cpuUsage();
render();
setInterval(render, 2000);
