// Builds a snapshot of the Higgsfield API catalog: every endpoint (mode) with its
// JSON input schema, description, output type and price. Pages are parsed as data
// (a small JS-literal tokenizer), never executed.
import { writeFileSync } from "node:fs";

const OUT = process.argv[2];
if (!OUT) throw new Error("usage: node scrape_catalog.mjs <out.json>");

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

async function listModes() {
  let url = "https://dash.higgsfield.ai/api/v2/pricing/models/?page=1&page_size=50";
  const models = [];
  while (url) {
    const j = await getJson(url);
    models.push(...(j.results ?? []));
    url = j.next;
  }
  return models.flatMap((m) =>
    (m.modes ?? []).map((x) => ({
      endpoint: x.slug,
      family: m.title,
      mode: x.variant_title ?? null,
      company: m.company?.name ?? null,
      output: x.output_type ?? m.output_types?.[0] ?? null,
      availability: x.availability_state ?? m.availability_state,
      price: x.pricing?.primary
        ? `${x.pricing.primary.qualifier === "from" ? "from " : ""}${x.pricing.primary.amount} ${x.pricing.primary.currency}/${x.pricing.primary.unit}`
        : null,
    })),
  );
}

/* ---- safe JS object literal -> value (seroval output subset) ---- */
function parseLiteral(src) {
  let i = 0;
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  const skipRef = () => { // $R[12]=
    const m = /^\$R\[\d+\]=/.exec(src.slice(i, i + 16));
    if (m) i += m[0].length;
  };
  function str() {
    const q = src[i++];
    let out = "";
    while (i < src.length) {
      const c = src[i++];
      if (c === q) return out;
      if (c !== "\\") { out += c; continue; }
      const e = src[i++];
      if (e === "n") out += "\n";
      else if (e === "t") out += "\t";
      else if (e === "r") out += "\r";
      else if (e === "b") out += "\b";
      else if (e === "f") out += "\f";
      else if (e === "x") { out += String.fromCharCode(parseInt(src.slice(i, i + 2), 16)); i += 2; }
      else if (e === "u") { out += String.fromCharCode(parseInt(src.slice(i, i + 4), 16)); i += 4; }
      else out += e;
    }
    throw new Error("unterminated string");
  }
  function value() {
    ws(); skipRef(); ws();
    const c = src[i];
    if (c === "{") {
      i++; const obj = {};
      for (;;) {
        ws();
        if (src[i] === "}") { i++; return obj; }
        let key;
        if (src[i] === '"' || src[i] === "'") key = str();
        else { const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i)); if (!m) throw new Error(`bad key at ${i}`); key = m[0]; i += key.length; }
        ws(); if (src[i++] !== ":") throw new Error(`expected : at ${i}`);
        obj[key] = value();
        ws(); if (src[i] === ",") i++;
      }
    }
    if (c === "[") {
      i++; const arr = [];
      for (;;) {
        ws();
        if (src[i] === "]") { i++; return arr; }
        arr.push(value());
        ws(); if (src[i] === ",") i++;
      }
    }
    if (c === '"' || c === "'") return str();
    if (src.startsWith("!0", i)) { i += 2; return true; }
    if (src.startsWith("!1", i)) { i += 2; return false; }
    if (src.startsWith("null", i)) { i += 4; return null; }
    if (src.startsWith("void 0", i)) { i += 6; return null; }
    if (src.startsWith("$R[", i)) { const m = /^\$R\[\d+\]/.exec(src.slice(i)); i += m[0].length; return null; }
    const num = /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(src.slice(i));
    if (num) { i += num[0].length; return Number(num[0]); }
    throw new Error(`unexpected '${src.slice(i, i + 20)}' at ${i}`);
  }
  return value();
}

function literalAfter(src, key) {
  const k = src.indexOf(key);
  if (k < 0) return null;
  return src.slice(k + key.length);
}

function stringField(src, key) {
  const rest = literalAfter(src, key);
  if (!rest || rest[0] !== '"') return null;
  return parseLiteral(rest.slice(0, rest.length)); // parses the leading string only
}

async function modeDetails(endpoint) {
  const html = await (await fetch(`https://open.higgsfield.ai/models/${endpoint}/api-reference`)).text();
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const src = scripts.find((s) => s.includes("input_schema:"));
  if (!src) return { error: "no schema" };
  const schemaSrc = literalAfter(src, "input_schema:");
  // parseLiteral reads exactly one value and ignores the rest of the text.
  const schema = parseLiteral(schemaSrc);
  let description = null;
  const d = /(?:^|[,{])description:("(?:[^"\\]|\\.)*")/.exec(src.slice(src.indexOf("variant_title:")));
  if (d) description = parseLiteral(d[1]);
  let docs = null;
  const md = src.indexOf("markdown_docs:");
  if (md >= 0 && src[md + 14] === '"') {
    const m = /^"(?:[^"\\]|\\.)*"/.exec(src.slice(md + 14));
    if (m) docs = parseLiteral(m[0]);
  }
  return { schema, description, docs };
}

const modes = await listModes();
const out = [];
for (let i = 0; i < modes.length; i += 6) {
  const batch = await Promise.all(
    modes.slice(i, i + 6).map(async (m) => {
      try { return { ...m, ...(await modeDetails(m.endpoint)) }; }
      catch (e) { return { ...m, error: String(e.message ?? e) }; }
    }),
  );
  out.push(...batch);
}
out.sort((a, b) => a.endpoint.localeCompare(b.endpoint));
writeFileSync(OUT, JSON.stringify({ fetched_at: new Date().toISOString(), modes: out }, null, 0));
console.log(JSON.stringify({
  total: out.length,
  errors: out.filter((o) => o.error).map((o) => `${o.endpoint}: ${o.error}`),
  withDocs: out.filter((o) => o.docs).length,
  docsChars: out.reduce((n, o) => n + (o.docs?.length ?? 0), 0),
}));
