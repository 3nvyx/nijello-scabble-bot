// Read-only access to the live server's public tables over SpacetimeDB's
// HTTP SQL API, with an anonymous identity (what the website itself sees).

const HOST = "https://maincloud.spacetimedb.com";
const DB = "scrabblebot";

export type Row = Record<string, unknown>;

export async function anonToken(): Promise<string> {
  const r = await fetch(`${HOST}/v1/identity`, { method: "POST" });
  return ((await r.json()) as { token: string }).token;
}

export async function sql(token: string, query: string): Promise<Row[]> {
  const r = await fetch(`${HOST}/v1/database/${DB}/sql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain" },
    body: query,
  });
  if (!r.ok) throw new Error(`${query}: HTTP ${r.status} ${await r.text()}`);
  const [res] = (await r.json()) as {
    schema: { elements: { name: { some: string } }[] };
    rows: unknown[][];
  }[];
  const cols = res!.schema.elements.map((e) => e.name.some);
  return res!.rows.map((row) => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

// SATS sum values arrive as [variantIndex, payload].
export const tag = (v: unknown): number => (v as [number, unknown])[0];
export const some = (v: unknown): number | undefined => {
  const [t, x] = v as [number, unknown];
  return t === 0 ? Number(x) : undefined;
};

