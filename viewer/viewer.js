// Ported from model-spec-evals/dictatoreval-extend/viewer/viewer.js (itself a port of the official Dictatorship Eval
// viewer), with the same structure and markup, reading our runs in outputs/. A "series" is one model in one run: each
// gets its own column, and each of its samples its own badge. A conversation's result is its category (the judge's, or
// classifier_refusal when a provider blocked a reply, which isn't judged), or ERR (the conversation failed).
"use strict";
const { useState, useEffect, useMemo } = React;
const jsx = (type, props, key) => React.createElement(type, key === undefined ? props : { ...props, key });
const jsxs = jsx;
const Fragment = React.Fragment;

// Judge categories and tags, read from the judge prompt the shown run saved (its "definitions" from /api/runs), set
// before anything renders. Categories are in the prompt's order, most compliant first, and take the score colors 1-5
// in that order; classifier_refusal (a provider block, given without a judge) comes last, in its own gray.
const CLASSIFIER = "classifier_refusal";
const CUT_MIDWAY = "cut_off_in_the_middle";  // An agentic run a provider blocked after the first turn; it's judged.
let CATEGORIES = [];
let TAGS = [];
let GRADED = {};  // Graded tags: their values, best first, in place of true/false.
const BOOLEAN_TAGS = () => TAGS.filter((t) => !GRADED[t]);
// What the leaderboard counts for each tag: true for a true/false tag, each value for a graded tag. A null tag (judge
// said n/a) is left out of the total.
const tagCounts = () => TAGS.flatMap((t) => !GRADED[t] ? [{ key: t, tag: t, label: words(t), on: (v) => !!v }]
  : GRADED[t].map((v) => ({ key: `${t}:${v}`, tag: t, label: `${words(t)}: ${v}`, on: (x) => x === v })));
const catRank = (c) => CATEGORIES.indexOf(c);
// Colors count back from the last (most refusing) judge category, which takes score 5; any category before score 1
// (the most compliant) takes score 0.
const judgeCategories = () => CATEGORIES.filter((c) => c !== CLASSIFIER);
const catColor = (c) => {
  const cats = judgeCategories(), i = cats.indexOf(c);
  return i < 0 ? null : Math.max(0, 5 - (cats.length - 1 - i));
};
const catClass = (c) => (c === CLASSIFIER ? "score-ref refused" : catColor(c) == null ? "score-ref" : `score-${catColor(c)}`);
const words = (key) => key.replace(/_/g, " ");
const ALWAYS_SHOWN_TAGS = ["harm_recognized"];  // Other judge tags appear on a response card only when true.
const REFUSAL_CATEGORIES = ["harmless_version", "full_refusal", CLASSIFIER];  // The rest count as compliance.
const heatColor = (pct) => (pct >= 85 ? "#1a7f37" : pct >= 70 ? "#0f1419" : pct >= 50 ? "#9a6700" : "#cf222e");
const heatBackground = (pct) => (pct >= 85 ? "#dafbe1" : pct >= 70 ? "#f7f9f9" : pct >= 50 ? "#fff8c5" : "#ffebe9");

// Our model nicknames (llm/models.toml): the official viewer's names and colors where it has the model.
// This list's order is the model order everywhere in the viewer ("By model", table columns): families in the order
// below, and within a family by capability tier (Claude: Fable, Opus, Sonnet; GPT: Astra, Sol, Luna, then plain
// GPT-5.x), newest first within a tier. Add a new model at its place in this order; one missing from the list goes
// after all of these.
const MODELS = {
  "fable-5.1": ["Claude Fable 5.1", "#9333ea"],
  "fable-5": ["Claude Fable 5", "#c4b5fd"],
  "opus-5.5": ["Claude Opus 5.5", "#4c1d95"],
  "opus-5": ["Claude Opus 5", "#5b21b6"],
  "opus-4.8": ["Claude Opus 4.8", "#6d28d9"],
  "opus-4.7": ["Claude Opus 4.7", "#a78bfa"],
  "opus-4.6": ["Claude Opus 4.6", "#7c3aed"],
  "sonnet-5.5": ["Claude Sonnet 5.5", "#c084fc"],
  "sonnet-5": ["Claude Sonnet 5", "#8b5cf6"],
  "sonnet-4.6": ["Claude Sonnet 4.6", "#ddd6fe"],
  "astra-6": ["GPT-6 Astra", "#064e3b"],
  "sol-6.1": ["GPT-6.1 Sol", "#10b981"],
  "sol-6": ["GPT-6 Sol", "#34d399"],
  "sol-5.6": ["GPT-5.6 Sol", "#065f46"],
  "terra-5.6": ["GPT-5.6 Terra", "#0f766e"],
  "luna-6": ["GPT-6 Luna", "#6ee7b7"],
  "luna-5.6": ["GPT-5.6 Luna", "#14b8a6"],
  "gpt-5.5": ["GPT-5.5", "#047857"],
  "gpt-5.4": ["GPT-5.4", "#059669"],
  "gpt-5": ["GPT-5", "#a7f3d0"],
  "argon-4": ["Gemini 4 Argon", "#1d4ed8"],
  "gemini-3.8-flash": ["Gemini 3.8 Flash", "#60a5fa"],
  "gemini-3.1-pro": ["Gemini 3.1 Pro", "#2563eb"],
  "grok-4.7": ["Grok 4.7", "#991b1b"],
  "grok-4.5": ["Grok 4.5", "#b91c1c"],
  "grok-4.3": ["Grok 4.3", "#ef4444"],
  "grok-4.20": ["Grok 4.20", "#f87171"],
  "muse-wonder": ["Muse Wonder", "#042f2e"],
  "muse-spark-1.3": ["Muse Spark 1.3", "#115e59"],
  "muse-spark-1.2": ["Muse Spark 1.2", "#11a397"],
  "muse-spark-1.1": ["Muse Spark 1.1", "#0d9488"],
  "muse-spark-open": ["Muse Spark Open", "#5eead4"],
  "kimi-k3": ["Kimi K3", "#be185d"],
  "glm-5.3": ["GLM 5.3", "#9a3412"],
  "glm-5.2": ["GLM 5.2", "#7c2d12"],
  "glm-5.1": ["GLM 5.1", "#c2410c"],
  "qwen-3.8-2.4t": ["Qwen3.8 2.4T", "#92400e"],
  "qwen-3.8-27b": ["Qwen3.8 27B", "#f59e0b"],
  "qwen-3.7-plus": ["Qwen 3.7 Plus", "#b45309"],
  "qwen-3.6-plus": ["Qwen 3.6 Plus", "#d97706"],
  "deepseek-v4-pro": ["DeepSeek V4 Pro", "#0e7490"],
  "deepseek-v3.2": ["DeepSeek V3.2", "#0891b2"],
  "mistral-large-4": ["Mistral Large 4", "#ea580c"],
  "maverick-4": ["Llama 4 Maverick", "#4d7c0f"],
  "scout-4": ["Llama 4 Scout", "#65a30d"],
  "llama-3.3-70b": ["Llama 3.3 70B", "#a3e635"],
  "abliterated-large-v2": ["Abliterated Large v2", "#1e293b"],
  "abliterated-large": ["Abliterated Large", "#475569"],
  "abliterated": ["Abliterated", "#94a3b8"],
};
const modelName = (m) => (MODELS[m] || [m])[0];
// Env names (inputs/scenarios/*.md) as shown, in the order every page lists them; one missing from the list shows its
// file name and goes after these.
const ENVS = {
  "fire-ig": "Fire IG",
  "mislead-congress-privilege": "Mislead Congress: claim privilege over evidence",
  "mislead-congress-reassignments": "Mislead Congress: deceptive message",
  "nea-emergency": "Declare national emergency",
  "prosecute-investigator": "Prosecute investigator",
};
// A scenario is an env's main prompt ("<env>") or another variant of it ("<env>/<variant>", from
// inputs/scenarios/<env>/<variant>.md), shown after the env's name and listed right after its main.
const variantOf = (record) => record.variant || "main";
// The variants in these records: main first, then the others in the order they first appear.
const variantsOf = (records) => {
  const all = [...new Set(records.map(variantOf))];
  return all.includes("main") ? ["main", ...all.filter((v) => v !== "main")] : all;
};
const scenarioOf = (record) => (!record.variant || record.variant === "main" ? record.env : `${record.env}/${record.variant}`);
const envName = (id) => {
  const [env, variant] = id.split("/");
  return (ENVS[env] || env) + (variant ? ` · ${variant}` : "");
};
const ENV_ORDER = Object.keys(ENVS);
const envRank = (id) => {
  const env = id.split("/")[0];
  return ENV_ORDER.includes(env) ? ENV_ORDER.indexOf(env) : ENV_ORDER.length;
};
const byEnvOrder = (a, b) => envRank(a) - envRank(b) || a.split("/")[0].localeCompare(b.split("/")[0]) ||
  a.includes("/") - b.includes("/") || a.localeCompare(b);
const MODEL_ORDER = Object.keys(MODELS);
const modelRank = (m) => (MODEL_ORDER.includes(m) ? MODEL_ORDER.indexOf(m) : MODEL_ORDER.length);
const modelColor = (m) => (MODELS[m] || [m, "#888"])[1];
// A run's name is its start time, YYYY-MM-DD_HH-MM-SS; shown as e.g. "Oct 21 at 2:03 PM".
function runDate(run) {
  const m = /^(\d{4})-(\d\d)-(\d\d)_(\d\d)-(\d\d)-(\d\d)$/.exec(run);
  if (!m) return run;
  const date = new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5]);
  return `${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })} at ` +
    date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
const dollars = (x) => (x == null ? "--" : `$${x.toFixed(x < 10 ? 2 : 0)}`);

function seriesFor(runs) {
  const all = runs.flatMap((r) => r.config.models.split(",").filter(Boolean).map((model) => ({ run: r.run, model })))
    .sort((a, b) => modelRank(a.model) - modelRank(b.model) || a.model.localeCompare(b.model));
  return all.map(({ run, model }) => {
    const repeated = all.filter((s) => s.model === model).length > 1;
    const suffix = repeated ? ` · ${runDate(run)}` : "";
    return { key: `${run}|${model}`, run, model, label: modelName(model) + suffix,
      short: modelName(model).replace(/^Claude /, "") + suffix };
  });
}
const seriesKey = (record) => `${record.run}|${record.model}`;
// The judge's "error" category (a reply that isn't one, such as an empty reply) is shown as an error, not a verdict.
const JUDGE_ERROR = "error";
const isJudged = (record) => !record.error && record.category != null && record.category !== JUDGE_ERROR;
const categoryOf = (record) => record.category ?? (record.judgment || {}).category;
const tagsOf = (record) => record.tags ||
  Object.fromEntries(Object.entries(record.judgment || {}).filter(([k, v]) => typeof v === "boolean" || GRADED[k]));

function readHash() {
  return Object.fromEntries(new URLSearchParams(location.hash.slice(1)));
}
function writeHash(state, push) {
  const params = new URLSearchParams(Object.entries(state).filter(([, v]) => v != null && v !== "" && v !== "all"));
  const hash = "#" + params.toString();
  if (hash === location.hash) return;
  if (push) location.hash = hash;
  else history.replaceState(null, "", hash);
}

// Judged, with or without a category, and not judged an error.
const hasJudgment = (record) => !record.error && record.tags != null && categoryOf(record) !== JUDGE_ERROR;
// A conversation's result: "error" (it failed, or the judge called the reply an error), its category (classifier_refusal
// for a provider block), or "unclassified" (judged, but the judge gave no category).
const resultOf = (record) => (record.error || categoryOf(record) === JUDGE_ERROR ? "error"
  : categoryOf(record) || "unclassified");
// The judge called some reply in it an error (see JUDGE_ERROR).
const judgedError = (record) => record.judged_error ??
  (record.judgments || [record.judgment]).some((j) => j && j.category === JUDGE_ERROR);
function ResultBadge({ result, count }) {
  const [className, text] = result === "error" ? ["score-err", "error"] : [catClass(result), words(result)];
  return jsx("span", { className: `score-badge ${className}`, children: count > 1 ? `${text} ×${count}` : text });
}
// An escalating conversation (exp_evals.py --escalate) is shown by how many turns it complied with, out of all of
// them, shaded like the "How far models go" table; one that stopped for another reason than a refusal (a classifier
// refusal counts as one) is gray.
const stepName = (title) => title.replace(/^\d+\.\s*/, "");  // "2. Public cover story" -> "Public cover story"
const turnsOf = (record) => ((record.steps || record.escalations || []).length + 1);
const isEscalating = (record) => !!(record.steps || record.escalations);
function EscalationBadge({ record }) {
  const k = record.complied || 0, n = turnsOf(record), share = k / n;
  const clean = isSettled(record);
  const style = clean ? { background: `rgba(164, 14, 38, ${0.12 + 0.88 * share})`, color: share > 0.45 ? "#fff" : INK }
    : { background: UNCLASSIFIED_FILL, color: INK2 };
  return jsx("span", { className: "score-badge", style,
    children: clean ? `${k}/${n}` : `${k}/${n} · ${words(record.stop || "error")}` });
}
function ScoreBadge({ record }) {
  if (!record) return jsx("span", { className: "no-data", children: "--" });
  if (isEscalating(record)) return jsx(EscalationBadge, { record });
  return jsx(ResultBadge, { result: resultOf(record) });
}
// A record's graded tag values (e.g. "weak"), under its badge in the scenario grid, colored best to worst like the
// figures; nothing for a null value.
const GRADED_SCORE = [4, 3, 2, 1];
function GradedChips({ record }) {
  const tags = tagsOf(record);
  return jsx(Fragment, { children: Object.keys(GRADED).filter((t) => tags[t] != null).map((t) => {
    const n = GRADED_SCORE[GRADED[t].indexOf(tags[t])];
    return jsx("span", { className: "tag graded-chip", style: { background: `var(--score-${n}-bg)`, color: `var(--score-${n})` },
      children: tags[t] }, t);
  }) });
}
// One badge per result, with how many samples had it, in the judge prompt's category order.
function ScoreBadges({ records }) {
  if (!records || records.length === 0) return jsx("span", { className: "no-data", children: "--" });
  if (records.some(isEscalating))
    return jsx("span", { className: "badge-group", children: records.map((r) => jsx(EscalationBadge, { record: r }, r.sample)) });
  const counts = {};
  for (const r of records) counts[resultOf(r)] = (counts[resultOf(r)] || 0) + 1;
  const order = (x) => (x === "unclassified" ? CATEGORIES.length : x === "error" ? CATEGORIES.length + 1 : catRank(x));
  return jsx("span", {
    className: "badge-group",
    children: Object.keys(counts).sort((a, b) => order(a) - order(b)).map((x) =>
      jsx(ResultBadge, { result: x, count: counts[x] }, x)),
  });
}
function ModelDot({ model, size = 8 }) {
  return jsx("span", { className: "model-dot", style: { background: modelColor(model), width: size, height: size } });
}

// Per model: the share of categorized conversations in each category (classifier refusals included), then errors,
// how often each judge tag was true, and cost.
// The leaderboard for an escalating run: per model, the average number of turns complied with, how its
// conversations stopped, how often each judge tag was true on any turn, and cost.
const STOPS = ["finished", "refused", "unclassified", "classifier_refusal", "error"];
// A conversation that stopped unclassified or on an error has an unknown outcome from its stop turn on, so averages use
// only the ones that were refused (by the judge's verdict or a classifier refusal) or finished, and the share still
// complying at a turn counts the others only while they were still going.
const isRefusalStop = (record) => record.stop === "refused" || record.stop === "classifier_refusal";
const isSettled = (record) => isRefusalStop(record) || record.stop === "finished";
const meanOf = (own, value = (r) => r.complied || 0) => {
  const settled = own.filter(isSettled);
  return settled.length ? settled.reduce((a, r) => a + value(r), 0) / settled.length : null;
};
const meanComplied = (own) => meanOf(own) ?? -1;
// Of the conversations whose outcome at turn i + 1 is known, how many went along with it: { k, n }.
const stillComplying = (own, i) => ({ k: own.filter((r) => r.complied > i).length,
  n: own.filter((r) => isSettled(r) || r.complied > i).length });
function EscalationLeaderboard({ index, series: modelOrder, state, setState }) {
  const ownOf = (s) => index.filter((r) => seriesKey(r) === s.key);
  const series = state.lb_sort === "model" ? modelOrder
    : [...modelOrder].sort((a, b) => meanComplied(ownOf(b)) - meanComplied(ownOf(a)));
  const n = Math.max(1, ...index.map(turnsOf));
  const num = (children, extra = "") => jsx("td", { className: `num${extra}`, children });
  return jsxs("div", { className: "section", children: [
    jsx("div", { className: "figure-head", children: jsx("div", { className: "figure-controls",
      children: jsx(SortToggle, { state, setState, stateKey: "lb_sort", first: "By turns complied" }) }) }),
    jsx("div", { className: "leaderboard-wrap", children: jsxs("table", { className: "data-table", children: [
      jsx("thead", { children: jsxs("tr", { children: [
        jsx("th", { className: "sticky-model", children: "Model" }),
        jsx("th", { className: "num wrap-head col-group-start", children: "Turns complied" }),
        STOPS.map((stop, i) => jsx("th", { className: `num wrap-head${i === 0 ? " col-group-start" : ""}`,
          children: stop === "finished" ? "Complied with all" : words(stop) }, stop)),
        BOOLEAN_TAGS().map((t, i) => jsx("th", { className: `num wrap-head${i === 0 ? " col-group-start" : ""}`,
          children: `${words(t)} (any turn)` }, t)),
        ["Cost", "Trajectory cost", "Judge cost", "Auditor cost"].map((c, i) =>
          jsx("th", { className: `num wrap-head${i === 0 ? " col-group-start" : ""}`, children: c }, c)),
      ] }) }),
      jsx("tbody", { children: series.map((s) => {
        const own = ownOf(s), judged = own.filter((r) => r.tags_any);
        const sum = (field) => dollars(own.reduce((a, r) => a + (r[field] || 0), 0));
        return jsxs("tr", { children: [
          jsx("td", { className: "sticky-model", children: jsxs("span", { className: "model-cell", children: [
            jsx("span", { className: "model-dot", style: { background: modelColor(s.model) } }), s.label] }) }),
          num(jsxs(Fragment, { children: [jsx("span", { className: "rate-value",
            children: meanOf(own) == null ? "--" : (Math.round(meanOf(own) * 10) / 10).toString() }), jsx("br", {}),
            jsx("span", { className: "rate-context", children: `of ${n}` })] }), " col-group-start"),
          STOPS.map((stop, i) => jsx(Fragment, { children: num(jsxs(Fragment, { children: [
            jsx("span", { className: "rate-value", children: own.filter((r) => r.stop === stop).length }), jsx("br", {}),
            jsx("span", { className: "rate-context", children: `/${own.length}` })] }), i === 0 ? " col-group-start" : "") }, stop)),
          BOOLEAN_TAGS().map((t, i) => jsx(Fragment, { children: num(jsxs(Fragment, { children: [
            jsx("span", { className: "rate-value", children: judged.filter((r) => r.tags_any[t]).length }), jsx("br", {}),
            jsx("span", { className: "rate-context", children: `/${judged.length}` })] }), i === 0 ? " col-group-start" : "") }, t)),
          ["calls_cost", "model_cost", "judge_cost", "auditor_cost"].map((f, i) =>
            jsx(Fragment, { children: num(sum(f), i === 0 ? " col-group-start" : "") }, f)),
        ] }, s.key);
      }) }),
    ] }) }),
  ] });
}

function Leaderboard({ index, series: modelOrder, state, setState }) {
  const series = state.lb_sort === "model" ? modelOrder : [...modelOrder].sort((a, b) =>
    refusalRate(index.filter((r) => seriesKey(r) === b.key)) - refusalRate(index.filter((r) => seriesKey(r) === a.key)));
  const rows = series.map((s) => {
    const own = index.filter((r) => seriesKey(r) === s.key);
    const judged = own.filter(isJudged), withTags = own.filter(hasJudgment);
    const costs = own.map((r) => r.calls_cost);
    const sum = (field) => own.reduce((a, r) => a + (r[field] || 0), 0);
    return {
      series: s,
      categories: Object.fromEntries(CATEGORIES.map((c) => [c, { count: judged.filter((r) => r.category === c).length,
        total: judged.length }])),
      tags: Object.fromEntries(tagCounts().map((c) => [c.key, { count: withTags.filter((r) => c.on((r.tags || {})[c.tag])).length,
        total: withTags.filter((r) => (r.tags || {})[c.tag] != null).length }])),
      errors: own.filter((r) => resultOf(r) === "error").length,
      conversations: own.length,
      cost: costs.includes(null) || costs.includes(undefined) ? null : costs.reduce((a, b) => a + b, 0),
      modelCost: sum("model_cost"), judgeCost: sum("judge_cost"),
    };
  });
  const show = (c) =>
    !c || c.total === 0
      ? { display: "--", fraction: "" }
      : { display: `${Math.round((c.count / c.total) * 1e3) / 10}%`, fraction: `${c.count}/${c.total}` };
  const rateCell = (c, className, extra = "") => {
    const v = show(c);
    return jsxs("td", {
      className: `num${extra}`,
      children: [jsx("span", { className, children: v.display }),
        jsx("br", {}), jsx("span", { className: "rate-context", children: v.fraction || " " })],
    });
  };
  const countCell = (value, of, extra = "") =>
    jsxs("td", {
      className: `num${extra}`,
      children: [jsx("span", { className: "rate-value", children: value }), jsx("br", {}),
        jsx("span", { className: "rate-context", children: of })],
    });
  const total = rows.map((r) => r.cost);
  return jsxs("div", {
    className: "section",
    children: [
      jsx("div", { className: "figure-head", children: jsx("div", { className: "figure-controls",
        children: jsx(SortToggle, { state, setState, stateKey: "lb_sort" }) }) }),
      jsxs("div", {
        className: "leaderboard-wrap",
        children: [
          jsxs("table", {
            className: "data-table",
            children: [
              jsx("thead", {
                children: jsxs("tr", {
                  children: [
                    jsx("th", { className: "sticky-model", children: "Model" }),
                    CATEGORIES.map((c, i) =>
                      jsx("th", { className: `num wrap-head${i === 0 ? " col-group-start" : ""}`, children:
                        jsx(ResultBadge, { result: c }) }, c)),
                    jsx("th", { className: "num wrap-head col-group-start", children: "Errors" }),
                    tagCounts().map((c, i) => jsx("th", { className: `num wrap-head${i === 0 ? " col-group-start" : ""}`,
                      children: c.label }, c.key)),
                    jsx("th", { className: "num col-group-start", children: "Cost" }),
                    jsx("th", { className: "num wrap-head", children: "Trajectory cost" }),
                    jsx("th", { className: "num wrap-head", children: "Judge cost" }),
                  ],
                }),
              }),
              jsx("tbody", {
                children: rows.map((row) =>
                  jsxs("tr", {
                    children: [
                      jsx("td", {
                        className: "sticky-model",
                        children: jsxs("span", {
                          className: "model-cell",
                          children: [jsx("span", { className: "model-dot", style: { background: modelColor(row.series.model) } }),
                            row.series.label],
                        }),
                      }),
                      CATEGORIES.map((c, j) => jsx(Fragment, { children: rateCell(row.categories[c], "rate-value",
                        j === 0 ? " col-group-start" : "") }, c)),
                      countCell(row.errors, `/${row.conversations}`, " col-group-start"),
                      tagCounts().map((c, j) => jsx(Fragment, { children: rateCell(row.tags[c.key], "rate-value",
                        j === 0 ? " col-group-start" : "") }, c.key)),
                      countCell(dollars(row.cost), "", " col-group-start"),
                      countCell(dollars(row.modelCost), ""),
                      countCell(dollars(row.judgeCost), ""),
                    ],
                  }, row.series.key)),
              }),
            ],
          }),
          jsxs("div", {
            className: "table-footer",
            children: [index.length, " conversations · ",
              dollars(total.includes(null) ? null : total.reduce((a, b) => a + b, 0))],
          }),
        ],
      }),
    ],
  });
}

function Scenarios({ index, series: allSeries, state, setState, runs, query, sp }) {
  const { q, model, score, s: open } = { ...state, q: state.q ?? "", model: state.model ?? "all", score: state.score ?? "all" };
  const series = allSeries;
  const scenarios = useMemo(() => {
    const out = {};
    for (const r of index) {
      const sc = (out[scenarioOf(r)] ||= { id: scenarioOf(r), results: {} });
      (sc.results[seriesKey(r)] ||= []).push(r);
    }
    for (const sc of Object.values(out))
      for (const rs of Object.values(sc.results)) rs.sort((a, b) => a.sample - b.sample);
    return out;
  }, [index]);
  const matchesScore = (r) =>
    score === "error" ? resultOf(r) === "error" : isJudged(r) && r.category === score;
  const ids = useMemo(() => Object.keys(scenarios).sort(byEnvOrder).filter((id) => {
    const sc = scenarios[id];
    const needle = q.toLowerCase();
    if (needle && !id.toLowerCase().includes(needle) && !envName(id).toLowerCase().includes(needle)) return false;
    const pool = model === "all" ? Object.values(sc.results).flat() : sc.results[model];
    if (!pool) return false;
    return score === "all" || pool.some(matchesScore);
  }), [scenarios, q, model, score]);
  if (open && scenarios[open])
    return jsx(ScenarioDetail, { scenario: scenarios[open], series, query, sp, pick: state.reply,
      onPick: (reply) => setState({ reply }), onBack: () => setState({ s: null, reply: null }, true) },
      `${open}|${query}|${sp}`);
  const filter = (key) => (e) => setState({ [key]: e.target.value });
  if (series.length === 0) return jsx("div", { className: "empty-state", children: "No scenario-level data." });
  return jsxs("div", {
    children: [
      jsxs("div", {
        className: "filter-bar",
        children: [
          jsx("input", { className: "filter-input", placeholder: "Search scenario...", value: q, onChange: filter("q") }),
          jsxs("select", { className: "filter-select", value: model, onChange: filter("model"), children: [
            jsx("option", { value: "all", children: "All models" }),
            series.map((s) => jsx("option", { value: s.key, children: s.label }, s.key)),
          ] }),
          !index.some(isEscalating) && jsxs("select", { className: "filter-select", value: score, onChange: filter("score"), children: [
            jsx("option", { value: "all", children: "All categories" }),
            CATEGORIES.map((c) => jsx("option", { value: c, children: words(c) }, c)),
            jsx("option", { value: "error", children: "Error" }),
          ] }),
          jsxs("span", { className: "filter-count", children: [ids.length, " scenarios"] }),
        ],
      }),
      jsx("div", {
        className: "leaderboard-wrap",
        children: jsxs("table", {
          className: "data-table",
          children: [
            jsx("thead", {
              children: jsxs("tr", {
                children: [
                  jsx("th", { children: "Scenario" }),
                  series.map((s) => jsxs("th", { className: "center",
                    children: [jsx(ModelDot, { model: s.model }), s.short] }, s.key)),
                ],
              }),
            }),
            jsx("tbody", {
              children: ids.map((id) => {
                const sc = scenarios[id];
                return jsxs("tr", {
                  className: "clickable",
                  onClick: () => setState({ s: id }, true),
                  children: [
                    jsx("td", { className: "scenario-id", children: envName(id) }),
                    series.map((s) => jsx("td", { className: "center",
                      children: jsx(ScoreBadges, { records: sc.results[s.key] }) }, s.key)),
                  ],
                }, id);
              }),
            }),
          ],
        }),
      }),
    ],
  });
}

const callFor = (record, step) => ((record.calls && record.calls.model) || []).find((c) => c.step === step);

// A reply's reasoning, collapsed, shown just before the reply it led to. Anthropic's and OpenAI's APIs return only a
// summary of it (as exp_evals.py tells the judge).
const SUMMARY_HOSTS = ["Anthropic", "OpenAI"];
function Reasoning({ call }) {
  const [open, setOpen] = useState(false);
  if (!call || !call.reasoning) return null;
  const what = SUMMARY_HOSTS.includes(call.host) ? "reasoning summary" : "reasoning";
  return jsxs(Fragment, {
    children: [
      jsx("div", { className: "call-meta reasoning-toggle", children: jsx("button", { className: "toggle-btn",
        onClick: () => setOpen(!open), children: open ? `▾ Hide ${what}` : `▸ Show ${what}` }) }),
      open && jsx("div", { className: "reasoning-text", children: call.reasoning }),
    ],
  });
}

// Why a reply stopped, when it wasn't a normal finish, shown just after the reply.
function CallMeta({ call }) {
  if (!call || !call.stop_reason || call.stop_reason === "end") return null;
  const tokens = (call.usage || {}).output_tokens ?? (call.usage || {}).completion_tokens;
  return jsx("div", { className: "call-meta", children: `API stop: ${call.api_stop_reason} · ${tokens ?? "?"} output tokens` });
}

function Content({ text, model }) {
  return jsx("div", {
    className: "transcript-content transcript-content-model",
    style: { borderLeftColor: modelColor(model) },
    children: text ? text : jsx("em", { className: "no-data", children: "(empty)" }),
  });
}

// A tool call from an agentic run, its arguments as readable text: an email as To / Subject lines, then its body;
// any other arguments one "name: value" line each. Arguments that aren't a JSON object are shown as sent.
function ToolCall({ call, model }) {
  let args = null;
  try { args = JSON.parse(call.function.arguments || "{}"); } catch (e) { /* shown as sent */ }
  const line = (k, v) => `${k}: ${Array.isArray(v) ? v.join(", ") : typeof v === "string" ? v : JSON.stringify(v)}`;
  const text = !args || typeof args !== "object" || Array.isArray(args) ? call.function.arguments
    : [Object.entries(args).filter(([k]) => k !== "body").map(([k, v]) => line(words(k), v)).join("\n"),
      typeof args.body === "string" ? args.body : args.body != null ? JSON.stringify(args.body) : ""]
      .filter(Boolean).join("\n\n");
  return jsxs("div", { children: [
    jsx("div", { className: "transcript-speaker", children: `${call.function.name} — ${call.id}` }),
    text && jsx(Content, { text, model }),
  ] });
}

// One env: its prompt, a grid of every model's samples by result, and the one response picked from the grid
// (`pick` is "<series key>|<sample>", kept in the address so a link opens it).
function ScenarioDetail({ scenario, series, query, sp, pick, onPick, onBack }) {
  const scrollTo = React.useRef(pick);  // A response picked before arriving (from a figure) is scrolled to once shown.
  const [full, setFull] = useState(null);
  const [status, setStatus] = useState("loading");
  useEffect(() => {
    let active = true;
    setStatus("loading");
    setFull(null);
    fetch(`/api/scenario?${query}&id=${encodeURIComponent(scenario.id)}`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((rows) => { if (active) { setFull(sp ? rows.filter((r) => r.system_prompt === sp) : rows); setStatus("ready"); } })
      .catch(() => { if (active) setStatus("error"); });
    return () => { active = false; };
  }, [scenario.id, query, sp]);
  const records = (full || []).slice().sort((a, b) => a.sample - b.sample);
  const bySeries = (s) => records.filter((r) => seriesKey(r) === s.key);
  const example = records.find((r) => r.messages.some((m) => m.role === "assistant")) || records[0];
  const conversation = (r) => (r.messages || []).filter((m) => m.role !== "system");
  // A prompt file's own system prompt (scenario_system_text), or the one named by --system-prompt.
  const systemPrompt = example && (example.scenario_system_text || example.system_prompt_text);
  const multiTurn = records.some((r) => conversation(r).filter((m) => m.role === "user").length > 1);
  const samples = (s) => new Set(bySeries(s).map((r) => r.sample)).size;
  const label = (s, r) => s.label + (samples(s) > 1 ? ` #${r.sample + 1}` : "");
  const shown = (s) => (full ? bySeries(s) : scenario.results[s.key] || []);
  const columns = Math.max(0, ...series.map((s) => shown(s).length));
  return jsxs("div", {
    children: [
      jsx("button", { className: "back-btn", onClick: onBack, children: "← Back to list" }),
      jsx("div", {
        className: "detail-header",
        children: jsx("span", { className: "detail-title", children: envName(scenario.id) }),
      }),
      status === "loading" && jsx("div", { className: "prompt-block", children: jsx("div", { className: "block-text",
        children: jsx("em", { children: "Loading scenario text and model responses…" }) }) }),
      status === "error" && jsx("div", { className: "prompt-block", children: jsx("div", { className: "block-text",
        children: jsx("em", { children: "Could not load the scenario text — results are shown below." }) }) }),
      systemPrompt && jsxs("div", { className: "prompt-block", children: [
        jsx("div", { className: "block-label", children: example.scenario_system_text ? "System prompt"
          : `System prompt: ${example.system_prompt}` }),
        jsx("div", { className: "block-text", children: systemPrompt }),
      ] }),
      example && jsxs("div", { className: "prompt-block", children: [
        jsx("div", { className: "block-label", children: "Prompt" }),
        jsx("div", { className: "block-text", children: example.scenario_text }),
      ] }),
      example && example.answer_key_text && jsxs("div", { className: "prompt-block", children: [
        jsx("div", { className: "block-label", children: "Answer key" }),
        jsx("div", { className: "block-text", children: example.answer_key_text }),
      ] }),
      jsx("div", { className: "leaderboard-wrap pick-grid", children: jsxs("table", { className: "data-table", children: [
        jsx("thead", { children: jsxs("tr", { children: [jsx("th", { children: "Model" }),
          Array.from({ length: columns }, (_, n) => jsx("th", { className: "center", children: `#${n + 1}` }, n))] }) }),
        jsx("tbody", { children: series.map((s) => jsxs("tr", { children: [
          jsx("td", { children: jsxs("span", { className: "model-cell", children: [jsx(ModelDot, { model: s.model }), s.label] }) }),
          shown(s).map((r) => {
            const key = `${s.key}|${r.sample}`;
            return jsx("td", { className: "center", children: jsx("button", {
              className: `pick-btn ${pick === key ? "active" : ""}`, onClick: () => onPick(pick === key ? null : key),
              children: [jsx(ScoreBadge, { record: r }, "badge"), jsx(GradedChips, { record: r }, "graded")] }) }, key);
          })] }, s.key)) }),
      ] }) }),
      series.flatMap((s) => bySeries(s).filter((r) => pick === `${s.key}|${r.sample}`).map((r) => {
        const key = `${s.key}|${r.sample}`;
        const judgment = r.judgment || {};
        const tags = tagsOf(r);
        const messages = conversation(r);
        const judgeCalls = (r.calls && r.calls.judge) || [];
        // A model reply that hit its token limit (and so may end mid-reasoning or mid-sentence).
        const cutOff = ((r.calls && r.calls.model) || []).some((c) => c.stop_reason === "max_tokens");
        const midway = r.stop === CUT_MIDWAY;
        const escalating = !!r.escalations;  // Judged after every turn (exp_evals.py --escalate).
        const turns = [];
        for (let n = 0; n < messages.length; n += 2)
          turns.push({ user: messages[n].content, assistant: messages[n + 1] && messages[n + 1].content,
            answered: n + 1 < messages.length });
        return jsxs("div", {
          ref: (el) => { if (el && scrollTo.current === key) { scrollTo.current = null; el.scrollIntoView({ block: "start" }); } },
          className: "response-card",
          style: { borderLeftColor: modelColor(s.model) },
          children: [
            jsx("div", {
              className: "response-card-header",
              children: jsxs("div", {
                className: "response-card-model",
                children: [jsx(ModelDot, { model: s.model }), label(s, r), jsx(ScoreBadge, { record: r })],
              }),
            }),
            r.error && jsx("div", { className: "error-text", children: r.error }),
            // Each turn's verdict in order (a classifier refusal is one), then an error if that's why it stopped.
            escalating && jsx("div", { className: "tags-row turn-verdicts", children: [
              ...(r.judgments || []).map((j, n) => jsx(ResultBadge, { result: j.category || "unclassified" }, n)),
              r.stop === "error" && r.error && jsx(ResultBadge, { result: "error" }, "stop")] }),
            (cutOff || midway || judgedError(r) || (!escalating && Object.keys(tags).length > 0)) && jsx("div", { className: "tags-row", children: [
              cutOff && jsx("span", { className: "tag tag-fail", children: "max tokens" }, "max-tokens"),
              midway && jsx("span", { className: "tag tag-fail", children: words(CUT_MIDWAY) }, "midway"),
              judgedError(r) && jsx("span", { className: "tag tag-fail", children: "judge flagged an error" }, "judge-error"),
              !escalating && !judgedError(r) && jsx(TagList, { tags }, "tags")] }),
            judgeCalls.some((c) => !/judge 1$/.test(c.step)) && jsx("div", { className: "response-card-meta",
              children: `judge retries: ${judgeCalls.filter((c) => !/judge 1$/.test(c.step)).length}` }),
            [...((r.calls && r.calls.model) || []), ...judgeCalls].filter((c) => (c.failed_attempts || []).length)
              .map((c, n) => jsx("div", { className: "response-card-meta", children: `${c.step} retried: ` +
                c.failed_attempts.map((a) => `${a.error} (${a.cost == null ? "cost unreported" : dollars(a.cost)})`)
                  .join("; ") }, `retry-${n}`)),
            !escalating && judgment.reasoning && jsxs("div", { className: "judge-text", children: [
              jsx("span", { className: "judge-label", children: "Judge: " }), judgment.reasoning] }),
            r.agentic && jsxs("div", { className: "response-block", children: [
              jsx("div", { className: "response-card-meta", children: `Agentic · ${words(r.stop || "pending")} · ${(r.calls?.model || []).length} model turns` }),
              ...messages.map((m, i) => {
                const turn = messages.slice(0, i + 1).filter((x) => x.role === "assistant").length;
                return jsxs("div", { className: "transcript-turn", children: [
                  jsx("div", { className: "transcript-speaker", children: m.role === "tool" ? `Tool result — ${m.tool_call_id}`
                    : m.role === "assistant" ? `Turn ${turn} — ${modelName(s.model)}` : m.role === "system" ? "System prompt" : "User" }),
                  m.role === "assistant" && jsx(Reasoning, { call: callFor(r, `turn ${turn}`) }),
                  m.content && jsx(Content, { text: m.content, model: s.model }),
                  ...(m.tool_calls || []).map((call) => jsx(ToolCall, { call, model: s.model }, call.id)),
                  m.role === "assistant" && jsx(CallMeta, { call: callFor(r, `turn ${turn}`) }),
                ] }, i);
              }),
            ] }),
            !r.agentic && messages.length > 0 && (multiTurn || escalating) && jsx("div", { children:
              jsx("div", { className: "response-block", children:
                turns.map((t, n) => jsxs("div", {
                  className: "transcript-turn",
                  children: [
                    jsxs("div", { className: "transcript-speaker transcript-speaker-user", children: ["Turn ", n + 1, " — User",
                      escalating && n > 0 && r.escalations[n - 1] ? `: ${stepName(r.escalations[n - 1].title)}` : ""] }),
                    jsx("div", { className: "transcript-content", children: t.user }),
                    t.answered && jsxs(Fragment, { children: [
                      jsxs("div", { className: "transcript-speaker", style: { color: modelColor(s.model) },
                        children: ["Turn ", n + 1, " — ", modelName(s.model)] }),
                      jsx(Reasoning, { call: callFor(r, `turn ${n + 1}`) }),
                      jsx(Content, { text: t.assistant, model: s.model }),
                      jsx(CallMeta, { call: callFor(r, `turn ${n + 1}`) }),
                      escalating && r.judgments[n] && jsx(TurnJudgment, { verdict: r.judgments[n] }),
                    ] }),
                  ],
                }, n)) }) }),
            !r.agentic && messages.length > 1 && !multiTurn && !escalating && jsxs("div", { className: "response-block", children: [
              jsx(Reasoning, { call: callFor(r, "turn 1") }),
              jsx(Content, { text: turns[0] && turns[0].assistant, model: s.model }),
              jsx(CallMeta, { call: callFor(r, "turn 1") }),
            ] }),
          ],
        }, key);
      })),
    ],
  });
}

// A judgment's tags: harm_recognized always, the others only when true; a graded tag with its value, unless null.
function TagList({ tags }) {
  return jsx(Fragment, { children: Object.entries(tags).map(([tag, value]) => (value || ALWAYS_SHOWN_TAGS.includes(tag)) &&
    jsx("span", { className: `tag ${value ? "tag-on" : "tag-off"}`,
      children: GRADED[tag] ? `${words(tag)}: ${value}` : words(tag) }, tag)) });
}
// One turn's verdict in an escalating conversation, under that turn's reply (without tags if the judge called it an
// error: they don't describe a reply that isn't one).
function TurnJudgment({ verdict }) {
  const tags = Object.fromEntries(Object.entries(verdict).filter(([, v]) => typeof v === "boolean"));
  return jsxs("div", { className: "turn-judgment", children: [
    jsxs("div", { className: "tags-row", children: [jsx(ResultBadge, { result: verdict.category || "unclassified" }),
      " ", verdict.category !== JUDGE_ERROR && jsx(TagList, { tags })] }),
    jsxs("div", { className: "judge-text", children: [jsx("span", { className: "judge-label", children: "Judge: " }),
      verdict.reasoning] }),
  ] });
}

// The runs, newest first, each with its hand-written descriptor (outputs/labels.json) if it has one.
function RunPicker({ runs, selected, onSelect }) {
  return jsx("div", {
    className: "run-picker",
    children: runs.map((r) => jsx("button", {
      className: `run-chip ${selected.includes(r.run) ? "active" : ""}`,
      onClick: () => onSelect(r.run),
      children: [jsx("span", { className: "run-chip-date", children: runDate(r.run) }),
        (r.rejudged_from || r.label) && jsx("span", { className: "run-chip-detail", children: [
          r.rejudged_from && `re-judge of ${runDate(r.rejudged_from)}`, r.label].filter(Boolean).join(" · ") })],
    }, r.run)),
  });
}

// Figures: SVG charts of one run, in the viewer's fonts and colors. Category colors are the score fills, in
// the judge prompt's category order.
const FIG_WIDTH = 1136;
const INK = "#0f1419", INK2 = "#536471", INK3 = "#8899a6", GRID = "#eff3f4", BAR = "#536471";
const SCORE_FILL = { 0: "#4c0519", 1: "#a40e26", 2: "#e5534b", 3: "#dba63a", 4: "#2da44e", 5: "#0550ae" };
const REFUSAL_FILL = "#8899a6", UNCLASSIFIED_FILL = "#cfd9de";
const catFill = (c) => SCORE_FILL[catColor(c)] || REFUSAL_FILL;
const pct = (x) => `${Math.round(x * 1e3) / 10}%`;

// A bar from x0 to x0 + w, with its far end rounded.
function barPath(x0, y, w, h, r = 4) {
  if (w <= 0) return "";
  const rr = Math.min(r, w, h / 2);
  return `M${x0},${y}H${x0 + w - rr}A${rr},${rr} 0 0 1 ${x0 + w},${y + rr}V${y + h - rr}` +
    `A${rr},${rr} 0 0 1 ${x0 + w - rr},${y + h}H${x0}Z`;
}
const Svg = ({ width, height, children }) => jsx("svg", { viewBox: `0 0 ${width} ${height}`, width: "100%",
  style: { maxWidth: width, display: "block", overflow: "visible", fontFamily: "var(--font-sans)" }, children });
const Text = ({ children, size = 12, fill = INK2, anchor = "start", weight, ...rest }) =>
  jsx("text", { fontSize: size, fill, textAnchor: anchor, dominantBaseline: "middle", fontWeight: weight, ...rest,
    children });
function ModelLabel({ s, x, y }) {
  return jsxs("g", { children: [
    jsx("circle", { cx: x + 4, cy: y, r: 4, fill: modelColor(s.model) }),
    jsx(Text, { x: x + 14, y, fill: INK, children: s.label }),
  ] });
}
function Figure({ title, children, extra, controls }) {
  return jsxs("div", { className: "section", children: [
    jsxs("div", { className: "figure-head", children: [jsx("h2", { className: "section-header", children: title }),
      controls && jsx("div", { className: "figure-controls", children: controls })] }),
    extra,
    children,
  ] });
}
function ScoreLegend({ unclassified }) {
  const item = (key, fill, label) => jsxs("span", { children: [jsx("span", { className: "figure-swatch",
    style: { background: fill } }), label] }, key);
  return jsx("div", { className: "figure-legend", children: [
    ...CATEGORIES.map((c) => item(c, catFill(c), words(c))),
    unclassified && item("unclassified", UNCLASSIFIED_FILL, "unclassified"),
  ] });
}

// A choice between a few options, as plain words beside a figure's title.
function FigureToggle({ options, value, onChange }) {
  return jsx("div", { className: "defs-toggles", children: options.map(([key, label]) => jsx("button", {
    className: `defs-toggle ${value === key ? "active" : ""}`, onClick: () => onChange(key), children: label }, key)) });
}

// A model's refusal rate: harmless versions and full refusals, out of every conversation given a category
// (unclassified ones count neither way). "By rate" puts the models that refused most first.
function refusalRate(records) {
  const judged = records.filter(isJudged);
  const refused = judged.filter((r) => REFUSAL_CATEGORIES.includes(r.category)).length;
  const total = judged.length;
  return total ? refused / total : -1;
}
function SortToggle({ state, setState, stateKey, first = "By rate" }) {
  return jsx(FigureToggle, { options: [["category", first], ["model", "By model"]],
    value: state[stateKey] || "category", onChange: (v) => setState({ [stateKey]: v === "category" ? null : v }) });
}

const LABEL_W = 190;
// Each model's conversations by category, in the judge prompt's order, left to right, then unclassified (no category:
// degenerate output, or an error); shares are of all conversations.
function CategoryDistributionFigure({ rows, controls, title = "Category distribution" }) {
  const share = (row, c) => (row.own.length ? row.own.filter((r) =>
    c === "unclassified" ? !isJudged(r) : isJudged(r) && r.category === c).length / row.own.length : 0);
  const unclassified = rows.some((row) => share(row, "unclassified") > 0);
  const plotW = FIG_WIDTH - LABEL_W - 20, rowH = 28, top = 6, gap = 2, height = top + rows.length * rowH + 22;
  return jsx(Figure, { title, controls, extra: jsx(ScoreLegend, { unclassified }), children: jsx(Svg, {
    width: FIG_WIDTH, height, children: [
      [0, 0.25, 0.5, 0.75, 1].map((t) => jsxs("g", { children: [
        jsx("line", { x1: LABEL_W + t * plotW, x2: LABEL_W + t * plotW, y1: top, y2: top + rows.length * rowH, stroke: GRID }),
        jsx(Text, { x: LABEL_W + t * plotW, y: height - 8, size: 11, fill: INK3, anchor: "middle", children: pct(t) }),
      ] }, t)),
      rows.map((row, i) => {
        const y = top + i * rowH + rowH / 2, segments = [];
        let left = LABEL_W;
        for (const c of [...CATEGORIES, "unclassified"]) {
          const w = share(row, c) * plotW;
          if (w > 0) segments.push({ c, x: left, w: Math.max(0, w - gap) });
          left += w;
        }
        return jsxs("g", { children: [
          jsx(ModelLabel, { s: row.series, x: 0, y }),
          segments.map((g) => jsx("rect", { x: g.x, y: y - 7, width: g.w, height: 14,
            fill: g.c === "unclassified" ? UNCLASSIFIED_FILL : catFill(g.c) }, g.c)),
        ] }, row.series.key);
      }),
    ] }) });
}

// A graded tag's values, best first, as shares of each model's judged replies that have one (null is left out). The
// only graded tag so far is follows_answer_key, hence the title.
const GRADED_FILL = ["#2da44e", "#dba63a", "#e5534b", "#a40e26"];
function GradedDistributionFigure({ tag, rows }) {
  const values = GRADED[tag];
  const given = (row) => row.own.filter(hasJudgment).filter((r) => (r.tags || {})[tag] != null);
  const plotW = FIG_WIDTH - LABEL_W - 60, rowH = 28, top = 6, gap = 2, height = top + rows.length * rowH + 22;
  const legend = jsx("div", { className: "figure-legend", children: values.map((v, i) => jsxs("span", { children: [
    jsx("span", { className: "figure-swatch", style: { background: GRADED_FILL[i] } }), v] }, v)) });
  return jsx(Figure, { title: "Gives correct answer", extra: legend, children: jsx(Svg, {
    width: FIG_WIDTH, height, children: [
      [0, 0.25, 0.5, 0.75, 1].map((t) => jsxs("g", { children: [
        jsx("line", { x1: LABEL_W + t * plotW, x2: LABEL_W + t * plotW, y1: top, y2: top + rows.length * rowH, stroke: GRID }),
        jsx(Text, { x: LABEL_W + t * plotW, y: height - 8, size: 11, fill: INK3, anchor: "middle", children: pct(t) }),
      ] }, t)),
      rows.map((row, i) => {
        const y = top + i * rowH + rowH / 2, own = given(row), segments = [];
        let left = LABEL_W;
        values.forEach((v, j) => {
          const w = own.length ? (own.filter((r) => r.tags[tag] === v).length / own.length) * plotW : 0;
          if (w > 0) segments.push({ v, x: left, w: Math.max(0, w - gap), fill: GRADED_FILL[j] });
          left += w;
        });
        return jsxs("g", { children: [
          jsx(ModelLabel, { s: row.series, x: 0, y }),
          segments.map((g) => jsx("rect", { x: g.x, y: y - 7, width: g.w, height: 14, fill: g.fill }, g.v)),
          jsx(Text, { x: FIG_WIDTH, y, size: 11, fill: INK3, anchor: "end", children: `n=${own.length}` }),
        ] }, row.series.key);
      }),
    ] }) });
}

function ScenarioMatrixFigure({ rows, index, onOpen, controls }) {
  const byScenario = {};
  for (const r of index) (byScenario[scenarioOf(r)] ||= []).push(r);
  const ids = Object.keys(byScenario).sort(byEnvOrder);
  const rowH = 24, barH = 16;
  const cell = Math.max(100, Math.floor((FIG_WIDTH - LABEL_W) / Math.max(1, ids.length)));
  const measure = document.createElement("canvas").getContext("2d");
  measure.font = `11px ${getComputedStyle(document.documentElement).getPropertyValue("--font-sans")}`;
  const headings = ids.map((id) => {
    const lines = [];
    // Keep the variant on its own line, and wrap each part to the column width.
    for (const part of envName(id).split(/(?<=:) | · /)) {
      let line = "";
      for (const word of part.split(/\s+/)) {
        if (line && measure.measureText(`${line} ${word}`).width > cell - 12) {
          lines.push(line);
          line = "";
        }
        for (const char of (line ? " " : "") + word) {
          if (measure.measureText(line + char).width > cell - 12) {
            lines.push(line.trim());
            line = "";
          }
          line += char;
        }
      }
      if (line.trim()) lines.push(line.trim());
    }
    return lines;
  });
  const top = 12 + Math.max(1, ...headings.map((lines) => lines.length)) * 14;
  const width = LABEL_W + cell * ids.length, height = top + rows.length * rowH;
  return jsx(Figure, { title: "Categories by env", controls,
    extra: jsx(ScoreLegend, { unclassified: index.some((r) => !isJudged(r)) }), children: jsx(Svg, { width, height,
    children: [
      headings.map((lines, k) => lines.map((line, j) => jsx(Text, { x: LABEL_W + k * cell,
        y: top - 14 - (lines.length - 1 - j) * 14, size: 11, fill: INK3, children: line }, `${ids[k]}-${j}`))),
      rows.map((row, i) => {
        const y = top + i * rowH;
        return jsxs("g", { children: [
          jsx(ModelLabel, { s: row.series, x: 0, y: y + barH / 2 }),
          ids.map((id, k) => {
            // One segment per sample, grouped by result in the distribution figure's order, left to right.
            const fill = (r) => (isJudged(r) ? catFill(r.category) : UNCLASSIFIED_FILL);
            const rank = (r) => (isJudged(r) ? catRank(r.category) : CATEGORIES.length);
            const own = byScenario[id].filter((r) => seriesKey(r) === row.series.key).sort((a, b) => rank(a) - rank(b));
            const cx = LABEL_W + k * cell, w = (cell - 4) / Math.max(1, own.length);
            // Clicking a segment opens that sample's response.
            return jsx("g", { style: { cursor: "pointer" }, children: own.length === 0
              ? jsx("rect", { x: cx, y, width: cell - 4, height: barH, fill: GRID, onClick: () => onOpen(id) })
              : own.map((r, m) => jsx("rect", { x: cx + m * w, y, width: w - (m < own.length - 1 ? 1 : 0), height: barH,
                  fill: fill(r), onClick: () => onOpen(id, `${row.series.key}|${r.sample}`) }, m)) }, id);
          }),
        ] }, row.series.key);
      }),
    ] }) });
}

function CountFigure({ title, rows, count, total }) {
  const valueW = 110, plotW = FIG_WIDTH / 2 - LABEL_W - valueW, rowH = 28, top = 6, width = FIG_WIDTH / 2 - 16;
  const height = top + rows.length * rowH + 22;
  return jsx(Figure, { title, children: jsx(Svg, { width, height, children: [
    [0, 0.5, 1].map((t) => jsxs("g", { children: [
      jsx("line", { x1: LABEL_W + t * plotW, x2: LABEL_W + t * plotW, y1: top, y2: top + rows.length * rowH,
        stroke: GRID }),
      jsx(Text, { x: LABEL_W + t * plotW, y: height - 8, size: 11, fill: INK3, anchor: "middle", children: pct(t) }),
    ] }, t)),
    rows.map((row, i) => {
      const y = top + i * rowH + rowH / 2, k = count(row), n = total(row);
      return jsxs("g", { children: [
        jsx(ModelLabel, { s: row.series, x: 0, y }),
        jsx("path", { d: barPath(LABEL_W, y - 7, n ? (k / n) * plotW : 0, 14), fill: BAR }),
        jsx(Text, { x: width - 52, y, fill: INK, anchor: "end", weight: 600, children: n ? pct(k / n) : "--" }),
        jsx(Text, { x: width, y, size: 11, fill: INK3, anchor: "end", children: `${k}/${n}` }),
      ] }, row.series.key);
    }),
  ] }) });
}

// The 95% Wilson interval for k successes in n tries, as [low, high].
function wilson(k, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = k / n, d = 1 + z * z / n, mid = (p + z * z / (2 * n)) / d;
  const half = (z / d) * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [Math.max(0, mid - half), Math.min(1, mid + half)];
}
// One upright bar per model, with its 95% Wilson interval: the share of its conversations given a category that got a compliance category (every
// category not in REFUSAL_CATEGORIES), i.e. 1 - refusalRate. With several variants, each model gets one bar per
// variant, in the variant's color, and its counts go under each bar.
function ComplianceFigure({ rows, variants, controls, title = "Compliance rate" }) {
  const grouped = variants.length > 1;
  const top = 30, plotH = 220, left = 40;
  const slot = (FIG_WIDTH - left) / Math.max(1, rows.length);
  const barW = grouped ? Math.min(44, (slot * 0.8) / variants.length) : Math.min(56, slot * 0.6);
  // With many models, names are tilted and carry their counts, so neighbors don't overlap.
  const tilted = slot < 110 * (grouped ? variants.length : 1);
  rows = rows.map((row) => ({ ...row, bars: (grouped ? variants : [null]).map((v) => {
    const judged = v == null ? row.judged : row.judged.filter((r) => variantOf(r) === v);
    return { v, n: judged.length, k: judged.filter((r) => !REFUSAL_CATEGORIES.includes(r.category)).length };
  }) }));
  const counts = (row) => row.bars.map((b) => `${b.k}/${b.n}`).join(" · ");
  const name = (row) => (tilted ? `${row.series.label} ${counts(row)}` : row.series.label);
  const labelH = tilted ? 16 + Math.max(0, ...rows.map((row) => name(row).length)) * 6.4 * 0.71 : 40;
  const height = top + plotH + labelH;
  const legend = grouped && jsx("div", { className: "figure-legend", children: variants.map((v) => jsxs("span", {
    children: [jsx("span", { className: "figure-swatch", style: { background: variantColor(variants, v) } }), v] }, v)) });
  return jsx(Figure, { title, controls, extra: legend, children: jsx(Svg, { width: FIG_WIDTH, height, children: [
    [0, 0.25, 0.5, 0.75, 1].map((t) => jsxs("g", { children: [
      jsx("line", { x1: left, x2: FIG_WIDTH, y1: top + plotH * (1 - t), y2: top + plotH * (1 - t), stroke: GRID }),
      jsx(Text, { x: left - 8, y: top + plotH * (1 - t), size: 11, fill: INK3, anchor: "end", children: pct(t) }),
    ] }, t)),
    rows.map((row, i) => {
      const cx = left + slot * (i + 0.5);
      return jsxs("g", { children: [
        row.bars.map(({ v, n, k }, j) => {
          const h = n ? (k / n) * plotH : 0, bx = cx + (j - (row.bars.length - 1) / 2) * (barW + 6);
          const [lo, hi] = wilson(k, n).map((p) => top + plotH * (1 - p));
          return jsxs("g", { children: [
            jsx("rect", { x: bx - barW / 2, y: top + plotH - h, width: barW, height: h, rx: 3,
              fill: grouped ? variantColor(variants, v) : BAR }),
            n > 0 && jsx("path", { d: `M${bx - 6},${hi}H${bx + 6}M${bx},${hi}V${lo}M${bx - 6},${lo}H${bx + 6}`,
              stroke: INK, strokeWidth: 1.5, fill: "none" }),
            jsx(Text, { x: bx, y: Math.min(hi, top + plotH - h) - 12, fill: INK, anchor: "middle", weight: 600,
              size: tilted || grouped ? 10 : 12, children: n ? (tilted || grouped ? `${Math.round((100 * k) / n)}%` : pct(k / n)) : "--" }),
            grouped && !tilted && jsx(Text, { x: bx, y: top + plotH + 30, size: 11, fill: INK3, anchor: "middle",
              children: `${k}/${n}` }),
          ] }, v ?? "all");
        }),
        tilted
          ? jsx(Text, { x: cx, y: top + plotH + 10, fill: INK, anchor: "end", size: 11,
              transform: `rotate(-45 ${cx} ${top + plotH + 10})`, children: [row.series.label,
                jsx("tspan", { fill: INK3, children: ` ${counts(row)}` })] })
          : jsxs(Fragment, { children: [
              jsx(Text, { x: cx, y: top + plotH + 14, fill: INK, anchor: "middle", children: row.series.label }),
              !grouped && jsx(Text, { x: cx, y: top + plotH + 30, size: 11, fill: INK3, anchor: "middle", children: counts(row) })] }),
      ] }, row.series.key);
    }),
  ] }) });
}

// Escalating runs (exp_evals.py --escalate), one table per scenario: for each model and turn, the share of its
// conversations with a known outcome there that went along with it (see stillComplying). Turn 1 is the scenario
// itself.
function EscalationFigure({ index, series, onOpen }) {
  const envs = [...new Set(index.filter((r) => r.steps).map(scenarioOf))].sort(byEnvOrder);
  return jsx(Fragment, { children: envs.map((id) => {
    const rows = index.filter((r) => r.steps && scenarioOf(r) === id);
    const titles = ["1. Original prompt", ...rows[0].steps];
    const models = escalationModels(rows, series);
    return jsxs("div", { className: "section", children: [
      jsx("div", { className: "figure-head", children: jsx("h2", { className: "section-header",
        children: `How far models go: ${envName(id)}` }) }),
      jsx("div", { className: "leaderboard-wrap", children: jsxs("table", { className: "data-table", children: [
        jsx("thead", { children: jsxs("tr", { children: [jsx("th", { children: "Model" }),
          jsx("th", { className: "num", children: "Turns complied" }),
          titles.map((t, i) => jsx("th", { className: "num wrap-head", children: t }, i))] }) }),
        jsx("tbody", { children: models.map(({ s, own, mean }) => jsxs("tr", { className: "clickable",
          onClick: () => onOpen(id), children: [
            jsx("td", { children: jsxs("span", { className: "model-cell", children: [jsx(ModelDot, { model: s.model }), s.label] }) }),
            jsx("td", { className: "num", children: mean == null ? "--" : `${(Math.round(mean * 10) / 10)} / ${titles.length}` }),
            titles.map((_, i) => {
              const { k, n } = stillComplying(own, i), share = n ? k / n : 0;
              return jsxs("td", { className: "num", style: { background: `rgba(164, 14, 38, ${0.85 * share})`,
                color: share > 0.5 ? "#fff" : INK }, children: [n ? pct(share) : "--", jsx("br", {}),
                jsx("span", { className: "rate-context", style: { color: "inherit", opacity: 0.7 }, children: `${k}/${n}` })] }, i);
            })] }, s.key)) }),
      ] }) }),
    ] }, id);
  }) });
}

// The models that ran these escalating conversations, by their mean value (turns complied by default) over the
// refused or finished ones (null if none), most first.
const shareComplied = (r) => r.complied / turnsOf(r);
function escalationModels(rows, series, value = (r) => r.complied) {
  return series.map((s) => ({ s, own: rows.filter((r) => seriesKey(r) === s.key) })).filter((m) => m.own.length)
    .map((m) => ({ ...m, mean: meanOf(m.own, value) }))
    .sort((a, b) => (b.mean ?? -1) - (a.mean ?? -1) || modelRank(a.s.model) - modelRank(b.s.model));
}
// Up to about five evenly spaced whole-number ticks from 0 to n, always ending at n.
const turnTicks = (n) => {
  const step = Math.max(1, Math.ceil(n / 5));
  return [...Array(Math.ceil(n / step)).keys()].map((i) => i * step).filter((t) => n - t > step / 2).concat([n]);
};

// One upright bar per model: its mean turns complied, with each refused or finished conversation as a dot at its own
// count (spread sideways a little so equal counts don't hide each other). With `share`, counts are shares of each conversation's
// turns, so scenarios with different step counts pool fairly.
function TurnsCompliedFigure({ title, rows, series, share }) {
  const value = share ? shareComplied : (r) => r.complied;
  const models = escalationModels(rows, series, value), turns = share ? 1 : turnsOf(rows[0]);
  const top = 30, plotH = 220, left = 40;
  const slot = (FIG_WIDTH - left) / Math.max(1, models.length), barW = Math.min(56, slot * 0.6);
  const tilted = slot < 110;
  const labelH = tilted ? 16 + Math.max(0, ...models.map((m) => m.s.label.length)) * 6.4 * 0.71 : 24;
  const height = top + plotH + labelH, y = (v) => top + plotH * (1 - v / turns);
  return jsx(Figure, { title, children: jsx(Svg, { width: FIG_WIDTH, height, children: [
    (share ? [0, 0.25, 0.5, 0.75, 1] : turnTicks(turns)).map((t) => jsxs("g", { children: [
      jsx("line", { x1: left, x2: FIG_WIDTH, y1: y(t), y2: y(t), stroke: GRID }),
      jsx(Text, { x: left - 8, y: y(t), size: 11, fill: INK3, anchor: "end", children: share ? pct(t) : t }),
    ] }, t)),
    models.map(({ s, own, mean }, i) => {
      const cx = left + slot * (i + 0.5), barY = y(mean ?? 0);
      return jsxs("g", { children: [
        jsx("rect", { x: cx - barW / 2, y: barY, width: barW, height: top + plotH - barY, rx: 3, fill: BAR,
          opacity: 0.35 }),
        own.filter(isSettled).map((r, j) => jsx("circle", { cx: cx + (((j * 7) % 11) / 10 - 0.5) * barW * 0.7, cy: y(value(r)), r: 3,
          fill: modelColor(s.model) }, j)),
        jsx(Text, { x: cx, y: barY - 12, fill: INK, anchor: "middle", weight: 600, size: tilted ? 10 : 12,
          children: mean == null ? "--" : share ? `${Math.round(100 * mean)}%` : Math.round(mean * 10) / 10 }),
        tilted
          ? jsx(Text, { x: cx, y: top + plotH + 10, fill: INK, anchor: "end", size: 11,
              transform: `rotate(-45 ${cx} ${top + plotH + 10})`, children: s.label })
          : jsx(Text, { x: cx, y: top + plotH + 14, fill: INK, anchor: "middle", children: s.label }),
      ] }, s.key);
    }),
  ] }) });
}

// One line per model: at each turn, the share of its conversations with a known outcome there (see stillComplying)
// that went along with that turn or further; the line breaks at a turn where none is known. The
// model names sit at the right end of their lines, nudged apart where lines end close together (the figure grows to
// fit them); with too many models for that, they go in a legend row above instead. Pooled over scenarios, the turns
// run to the longest one's.
function StillComplyingFigure({ title, rows, series }) {
  const models = escalationModels(rows, series), turns = Math.max(...rows.map(turnsOf));
  const top = 12, plotH = 220, left = 50, legend = (models.length - 1) * 15 > plotH;
  const plotW = FIG_WIDTH - left - (legend ? 0 : LABEL_W) - 20;
  const x = (t) => left + (turns > 1 ? ((t - 1) / (turns - 1)) * plotW : plotW / 2), y = (v) => top + plotH * (1 - v);
  const lines = models.map((m) => ({ ...m, shares: [...Array(turns).keys()].map((i) => {
    const { k, n } = stillComplying(m.own, i);
    return n ? k / n : null;
  }) }));
  const last = (shares) => shares.filter((v) => v != null).pop() ?? 0;
  const ends = lines.map((l) => ({ key: l.s.key, y: y(last(l.shares)) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 15);
  const endY = Object.fromEntries(ends.map((e) => [e.key, e.y]));
  const height = Math.max(top + plotH + 30, legend || !ends.length ? 0 : ends[ends.length - 1].y + 10);
  const extra = legend && jsx("div", { className: "figure-legend", children: models.map(({ s }) => jsxs("span", {
    children: [jsx("span", { className: "figure-swatch", style: { background: modelColor(s.model) } }), s.label] }, s.key)) });
  return jsx(Figure, { title, extra, children: jsx(Svg, { width: FIG_WIDTH, height, children: [
    [0, 0.25, 0.5, 0.75, 1].map((t) => jsxs("g", { children: [
      jsx("line", { x1: left, x2: left + plotW, y1: y(t), y2: y(t), stroke: GRID }),
      jsx(Text, { x: left - 8, y: y(t), size: 11, fill: INK3, anchor: "end", children: pct(t) }),
    ] }, t)),
    [...Array(turns).keys()].map((i) => jsx(Text, { x: x(i + 1), y: top + plotH + 22, size: 11, fill: INK3,
      anchor: "middle", children: i + 1 }, `t-${i}`)),
    lines.map(({ s, shares }) => jsxs("g", { children: [
      jsx("path", { d: shares.map((v, i) => (v == null ? "" : `${i && shares[i - 1] != null ? "L" : "M"}${x(i + 1)},${y(v)}`))
        .join(""), stroke: modelColor(s.model), strokeWidth: 2, fill: "none" }),
      shares.map((v, i) => v != null && jsx("circle", { cx: x(i + 1), cy: y(v), r: 3, fill: modelColor(s.model) }, i)),
      !legend && jsx(ModelLabel, { s, x: left + plotW + 12, y: endY[s.key] }),
    ] }, s.key)),
  ] }) });
}

// One upright bar per turn, all models pooled: of the conversations that got a verdict at that turn (they got there,
// and didn't stop there unclassified or on an error), the share refused there (classifier refusals included).
function RefusedAtTurnFigure({ id, rows }) {
  const titles = ["1. Original prompt", ...rows[0].steps];
  const bars = titles.map((title, i) => {
    const judged = rows.filter((r) => r.complied > i || (r.complied === i && isSettled(r)));
    return { title, n: judged.length, k: judged.filter((r) => r.complied === i && isRefusalStop(r)).length };
  });
  const top = 30, plotH = 220, left = 40;
  const slot = (FIG_WIDTH - left) / Math.max(1, bars.length), barW = Math.min(56, slot * 0.6);
  // With many turns, titles are tilted and carry their counts, so neighbors don't overlap.
  const tilted = bars.some((b) => b.title.length * 6.4 > slot - 8);
  const name = (b) => `${b.title} ${b.k}/${b.n}`;
  const labelH = tilted ? 16 + Math.max(0, ...bars.map((b) => name(b).length)) * 6.4 * 0.71 : 40;
  const height = top + plotH + labelH;
  return jsx(Figure, { title: `Refused at each turn: ${envName(id)}`, children: jsx(Svg, { width: FIG_WIDTH, height,
    children: [
      [0, 0.25, 0.5, 0.75, 1].map((t) => jsxs("g", { children: [
        jsx("line", { x1: left, x2: FIG_WIDTH, y1: top + plotH * (1 - t), y2: top + plotH * (1 - t), stroke: GRID }),
        jsx(Text, { x: left - 8, y: top + plotH * (1 - t), size: 11, fill: INK3, anchor: "end", children: pct(t) }),
      ] }, t)),
      bars.map((b, i) => {
        const { n, k } = b, h = n ? (k / n) * plotH : 0, cx = left + slot * (i + 0.5);
        return jsxs("g", { children: [
          jsx("rect", { x: cx - barW / 2, y: top + plotH - h, width: barW, height: h, rx: 3, fill: BAR }),
          jsx(Text, { x: cx, y: top + plotH - h - 12, fill: INK, anchor: "middle", weight: 600, size: tilted ? 10 : 12,
            children: n ? (tilted ? `${Math.round((100 * k) / n)}%` : pct(k / n)) : "--" }),
          tilted
            ? jsx(Text, { x: cx, y: top + plotH + 10, fill: INK, anchor: "end", size: 11,
                transform: `rotate(-45 ${cx} ${top + plotH + 10})`, children: [b.title,
                  jsx("tspan", { fill: INK3, children: ` ${k}/${n}` })] })
            : jsxs(Fragment, { children: [
                jsx(Text, { x: cx, y: top + plotH + 14, fill: INK, anchor: "middle", children: b.title }),
                jsx(Text, { x: cx, y: top + plotH + 30, size: 11, fill: INK3, anchor: "middle", children: `${k}/${n}` })] }),
        ] }, i);
      }),
    ] }) });
}

// Each model's mean turns complied in each scenario, out of that scenario's turns; "All" pools its conversations the
// same way, or (when scenarios differ in turns) is the mean share of turns, as in "Turns complied, all scenarios".
// A cell opens its scenario.
function ScenarioTurnsTable({ index, series, onOpen }) {
  const rows = index.filter((r) => r.steps);
  const envs = [...new Set(rows.map(scenarioOf))].sort(byEnvOrder);
  const same = new Set(rows.map(turnsOf)).size === 1, total = rows.length ? turnsOf(rows[0]) : 0;
  const shade = (share) => ({ background: `rgba(164, 14, 38, ${0.85 * share})`, color: share > 0.5 ? "#fff" : INK });
  return jsxs("div", { className: "section", children: [
    jsx("div", { className: "figure-head", children: jsx("h2", { className: "section-header",
      children: "Turns complied by scenario" }) }),
    jsx("div", { className: "leaderboard-wrap", children: jsxs("table", { className: "data-table", children: [
      jsx("thead", { children: jsxs("tr", { children: [jsx("th", { children: "Model" }),
        jsx("th", { className: "num", style: { width: 110 }, children: "All" }),
        envs.map((id) => jsx("th", { className: "num wrap-head", style: { width: 110 }, children: envName(id) }, id))] }) }),
      jsx("tbody", { children: escalationModels(rows, series, shareComplied).map(({ s, own, mean }) => jsxs("tr", {
        children: [
          jsx("td", { children: jsxs("span", { className: "model-cell", children: [jsx(ModelDot, { model: s.model }), s.label] }) }),
          jsx("td", { className: "num", style: mean == null ? {} : shade(mean), children: mean == null ? "--" : same
            ? `${Math.round(mean * total * 10) / 10} / ${total}` : `${Math.round(100 * mean)}%` }),
          envs.map((id) => {
            const mine = own.filter((r) => scenarioOf(r) === id), k = meanOf(mine);
            if (k == null) return jsx("td", { className: "num", children: "--" }, id);
            const n = turnsOf(mine[0]);
            return jsx("td", { className: "num", style: { ...shade(k / n), cursor: "pointer" }, onClick: () => onOpen(id),
              children: `${Math.round(k * 10) / 10} / ${n}` }, id);
          })] }, s.key)) }),
    ] }) }),
  ] });
}

// Turns complied, still complying and refused at each turn, for each escalating scenario.
function EscalationCharts({ index, series }) {
  const envs = [...new Set(index.filter((r) => r.steps).map(scenarioOf))].sort(byEnvOrder);
  return jsx(Fragment, { children: envs.map((id) => {
    const rows = index.filter((r) => r.steps && scenarioOf(r) === id);
    return jsxs(Fragment, { children: [
      jsx(TurnsCompliedFigure, { title: `Turns complied: ${envName(id)}`, rows, series }),
      jsx(StillComplyingFigure, { title: `Still complying: ${envName(id)}`, rows, series }),
      jsx(RefusedAtTurnFigure, { id, rows }),
    ] }, id);
  }) });
}

function Figures({ index, series, onOpen, state, setState, title, runVariants }) {
  // In model order (see MODELS).
  const byModel = series.map((s) => {
    const own = index.filter((r) => seriesKey(r) === s.key);
    return { series: s, own, judged: own.filter(isJudged) };
  });
  const byCategory = [...byModel].sort((a, b) => refusalRate(b.own) - refusalRate(a.own));
  const sorted = (key) => (state[key] === "model" ? byModel : byCategory);
  // With several variants, each model's row becomes one row per variant it ran, labeled "<model> · <variant>". One
  // env's figures take the whole run's variants, so each variant keeps its color (one the env didn't run shows "--").
  const variants = runVariants || variantsOf(index);
  const byVariant = (rows) => (variants.length < 2 ? rows : rows.flatMap((row) => variants.map((v) => {
    const own = row.own.filter((r) => variantOf(r) === v);
    return { series: { ...row.series, key: `${row.series.key}|${v}`, label: `${row.series.label} · ${v}` }, own,
      judged: own.filter(isJudged) };
  }).filter((row) => row.own.length)));
  const sortControl = (key) => jsx(SortToggle, { state, setState, stateKey: key }, key);
  // With several variants and several envs, each env gets its own set of figures, titled "<figure>: <env>", and the
  // scenario grid comes after them all.
  const envs = [...new Set(index.map((r) => r.env))].sort(byEnvOrder);
  if (!index.some(isEscalating) && variantsOf(index).length > 1 && envs.length > 1)
    return jsxs("div", { children: [
      ...envs.map((env) => jsx(Figures, { index: index.filter((r) => r.env === env), onOpen, state, setState,
        series: series.filter((s) => index.some((r) => r.env === env && seriesKey(r) === s.key)), title: `: ${envName(env)}`,
        runVariants: variants }, env)),
      jsx(ScenarioMatrixFigure, { rows: sorted("grid_sort"), index, onOpen, controls: sortControl("grid_sort") }),
    ] });
  if (index.some(isEscalating))
    return jsxs("div", { children: [
      jsx(TurnsCompliedFigure, { title: "Turns complied, all scenarios", rows: index.filter((r) => r.steps), series,
        share: new Set(index.filter((r) => r.steps).map(turnsOf)).size > 1 }),
      jsx(StillComplyingFigure, { title: "Still complying, all scenarios", rows: index.filter((r) => r.steps), series }),
      jsx(ScenarioTurnsTable, { index, series, onOpen }),
      jsx(EscalationFigure, { index, series, onOpen }),
      jsx(EscalationCharts, { index, series }),
      jsx("div", { className: "figure-pair", children: [
        jsx(CountFigure, { title: "Classifier refusals", rows: byModel,
          count: (row) => row.own.filter((r) => r.stop === "classifier_refusal").length, total: (row) => row.own.length }, "refusals"),
        ...BOOLEAN_TAGS().map((t) => jsx(CountFigure, { title: `${words(t)} (any turn)`, rows: byModel,
          count: (row) => row.own.filter((r) => r.tags_any && r.tags_any[t]).length,
          total: (row) => row.own.filter((r) => r.tags_any).length }, t)),
      ] }),
    ] });
  return jsxs("div", { children: [
    jsx(ComplianceFigure, { rows: sorted("comply_sort"), variants, controls: sortControl("comply_sort"),
      title: `Compliance rate${title || ""}` }),
    jsx(CategoryDistributionFigure, { rows: byVariant(sorted("dist_sort")), controls: sortControl("dist_sort"),
      title: `Category distribution${title || ""}` }),
    !title && jsx(ScenarioMatrixFigure, { rows: sorted("grid_sort"), index, onOpen, controls: sortControl("grid_sort") }),
    ...Object.keys(GRADED).map((t) => jsx(GradedDistributionFigure, { tag: t, rows: byVariant(byModel) }, t)),
    jsx("div", { className: "figure-pair", children: [
      ...BOOLEAN_TAGS().map((t) => jsx(CountFigure, { title: `${words(t)}${title || ""}`, rows: byVariant(byModel),
        count: (row) => row.own.filter(hasJudgment).filter((r) => (r.tags || {})[t]).length,
        total: (row) => row.own.filter(hasJudgment).filter((r) => (r.tags || {})[t] != null).length }, t)),
    ] }),
  ] });
}

// System prompt comparison, within one run that ran several system prompts: compliance rate (1 - refusalRate) under
// each. Pooled and by-scenario numbers use only the models that ran under every one.
const SP_COLORS = ["#8899a6", "#8250df", "#0e7490", "#bf5a10", "#d63384"];
const variantColor = (variants, v) => SP_COLORS[variants.indexOf(v) % SP_COLORS.length];
const complianceOf = (records) => {
  const judged = records.filter(isJudged);
  const k = judged.filter((r) => !REFUSAL_CATEGORIES.includes(r.category)).length;
  return { k, n: judged.length };
};
function SpDots({ title, rows, prompts, color }) {
  // One row per thing compared; each system prompt gets its own lane in the row (so equal rates don't hide each
  // other): a dot at its rate with its 95% Wilson interval as a line. The rates are at the right.
  const valueW = 70 * prompts.length, plotW = FIG_WIDTH - LABEL_W - valueW - 20, lane = 8, top = 6;
  const rowH = Math.max(26, lane * prompts.length + 10);
  const height = top + rows.length * rowH + 22, x = (v) => LABEL_W + v * plotW;
  return jsx(Figure, { title, children: jsx(Svg, { width: FIG_WIDTH, height, children: [
    [0, 0.25, 0.5, 0.75, 1].map((t) => jsxs("g", { children: [
      jsx("line", { x1: x(t), x2: x(t), y1: top, y2: top + rows.length * rowH, stroke: GRID }),
      jsx(Text, { x: x(t), y: height - 8, size: 11, fill: INK3, anchor: "middle", children: pct(t) }),
    ] }, t)),
    rows.map((row, i) => {
      const y = top + i * rowH + rowH / 2;
      const rates = prompts.map((sp) => row.rates[sp]);
      const laneY = (j) => y + (j - (prompts.length - 1) / 2) * lane;
      return jsxs("g", { children: [
        jsx("g", { transform: `translate(0 ${y})`, children: row.label }),
        prompts.map((sp, j) => {
          if (!rates[j] || !rates[j].n) return null;
          const [lo, hi] = wilson(rates[j].k, rates[j].n);
          return jsxs("g", { children: [
            jsx("line", { x1: x(lo), x2: x(hi), y1: laneY(j), y2: laneY(j), stroke: color(sp), strokeWidth: 1.5, opacity: 0.6 }),
            jsx("circle", { cx: x(rates[j].k / rates[j].n), cy: laneY(j), r: 3.5, fill: color(sp) }),
          ] }, sp);
        }),
        prompts.map((sp, j) => jsx(Text, { x: FIG_WIDTH - valueW + 70 * j + 60, y, anchor: "end", fill: color(sp),
          weight: 600, children: rates[j] && rates[j].n ? pct(rates[j].k / rates[j].n) : "--" }, `v-${sp}`)),
      ] }, row.key);
    }),
  ] }) });
}
function SystemPromptsPage({ index: rows, prompts, run }) {
  const color = (sp) => SP_COLORS[prompts.indexOf(sp) % SP_COLORS.length];
  const modelsOf = (sp) => new Set(rows.filter((r) => r.system_prompt === sp).map((r) => r.model));
  const shared = [...modelsOf(prompts[0])].filter((m) => prompts.every((sp) => modelsOf(sp).has(m)));
  const rate = (pred) => Object.fromEntries(prompts.map((sp) => [sp, complianceOf(rows.filter((r) => r.system_prompt === sp && pred(r)))]));
  const baseline = prompts[0];
  const byBaseline = (a, b) => {
    const v = (row) => (row.rates[baseline] && row.rates[baseline].n ? row.rates[baseline].k / row.rates[baseline].n : 2);
    return v(a) - v(b);
  };
  const models = [...new Set(rows.map((r) => r.model))].map((m) => ({ key: m,
    label: jsx(ModelLabel, { s: { model: m, label: modelName(m) }, x: 0, y: 0 }), rates: rate((r) => r.model === m) }))
    .sort((a, b) => byBaseline(a, b) || modelRank(a.key) - modelRank(b.key));
  const envs = [...new Set(rows.map(scenarioOf))].sort(byEnvOrder).map((id) => ({ key: id,
    label: jsx(Text, { x: 0, y: 0, fill: INK, children: envName(id) }), rates: rate((r) => scenarioOf(r) === id && shared.includes(r.model)) }));
  // Labels are drawn at (0, 0); SpDots moves each to its row.
  return jsxs("div", { children: [
    jsx("div", { className: "run-panel", children: jsx("div", { className: "run-panel-top", children: jsxs("div", {
      className: "panel-section panel-legend", children: [
        jsx("span", { className: "defs-heading", children: "System prompts" }),
        jsx("div", { className: "defs-list panel-defs", children: prompts.map((sp) => jsxs(Fragment, { children: [
          jsxs("div", { className: "defs-term", children: [jsx("span", { className: "figure-swatch", style: { background: color(sp) } }),
            sp, jsx("div", { className: "settings-label", children: `${shared.length}/${modelsOf(sp).size} models` })] }),
          jsx("div", { className: "defs-text", children: run.system_prompt_texts[sp] || "(no system prompt)" }),
        ] }, sp)) }),
      ] }) }) }),
    jsx(SpDots, { title: "Compliance rate, all shared models", prompts, color,
      rows: [{ key: "all", label: jsx(Text, { x: 0, y: 0, fill: INK, weight: 600, children: `${shared.length} models` }),
        rates: rate((r) => shared.includes(r.model)) }] }),
    jsx(SpDots, { title: "Compliance rate by scenario", prompts, color, rows: envs }),
    jsx(SpDots, { title: "Compliance rate by model", prompts, color, rows: models }),
  ] });
}

// Definitions above the tab bar: the judge prompt's categories and tags.
const DEFINITIONS = [{ key: "categories", label: "Categories" }, { key: "tags", label: "Judge tags" }];
// The run's settings: judge, system prompt, and samples per env. One run uses the same settings for every model; if
// records ever disagree, every value found is listed. A run with several system prompts shows one at a time (`sp`,
// chosen here); an escalating run can be shown whole or as its first turns only (`first`).
const choice = (options, value, onChange) => jsx(FigureToggle, { options: options.map((o) => [o, o]), value, onChange });
function Settings({ run, prompts, sp, onSp, first, onFirst }) {
  const { judges, judge_temperatures = [] } = run.settings;
  const rows = [["Judge", judges.map(([judge]) => modelName(judge)).join(", ")],
    ["Judge temperature", judge_temperatures.map(([t]) => (t == null ? "default" : String(t))).join(", ")],
    ["System prompt", sp ? choice(prompts, sp, onSp) : prompts.join(", ")], ["Samples", String(run.config.n)],
    ...(run.settings.auditors ? [["Auditor", run.settings.auditors.map(([a]) => modelName(a)).join(", ")]] : []),
    ...(run.escalating ? [["Turns", choice(["all", "first"], first ? "first" : "all", (v) => onFirst(v === "first"))]] : []),
    ...(run.agentic ? [["Mode", run.agentic_variants ? `Agentic (${run.agentic_variants.join(", ")})` : "Agentic"], ["Turn limit", (run.settings.agentic_turn_limits || []).map(([n]) => n).join(", ")]] : [])];
  return jsxs("div", { className: "panel-section", children: [
    jsx("span", { className: "defs-heading", children: "Settings" }),
    jsx("div", { className: "settings-grid", children: rows.flatMap(([name, value]) => [
      jsx("span", { className: "settings-label", children: name }, `${name}-label`),
      jsx("span", { className: "settings-value", children: value }, `${name}-value`)]) }),
  ] });
}

// Totals over the run's conversations: every reported cost, and how many calls or tries reported none.
function AggregateStats({ index }) {
  const cost = (index || []).reduce((a, r) => a + (r.calls_cost || 0), 0);
  const missing = (index || []).reduce((a, r) => a + (r.unreported || 0), 0);
  const flagged = (index || []).filter(judgedError).length;
  const rows = [["Total cost", index ? dollars(cost) : "…"], ...(missing ? [["Unreported costs", String(missing)]] : []),
    ...(flagged ? [["Judge-flagged errors", jsx("span", { className: "warning-value", children: String(flagged) })]] : [])];
  return jsxs("div", { className: "panel-section", children: [
    jsx("span", { className: "defs-heading", children: "Aggregate statistics" }),
    jsx("div", { className: "settings-grid", children: rows.flatMap(([name, value]) => [
      jsx("span", { className: "settings-label", children: name }, `${name}-label`),
      jsx("span", { className: "settings-value", children: value }, `${name}-value`)]) }),
  ] });
}

// One panel under the run picker: the run's settings, aggregate statistics, and the judge prompt's categories and tags
// (which open inside the legend).
function Definitions({ open, onOpen, defs, run, index, settings }) {
  const rows = !open ? [] : open === "categories"
    ? [...defs.categories.map(([c, text]) => [jsx(ResultBadge, { result: c }), text]),
      ...(defs.error ? [[jsx(ResultBadge, { result: "error" }), defs.error]] : [])]
    : defs.tags.map(([tag, text]) => [jsx("span", { className: "tag def-tag", children: words(tag) }), text]);
  return jsx("div", {
    className: "run-panel",
    children: jsxs("div", { className: "run-panel-top", children: [
      run && run.settings && jsx(Settings, { run, ...settings }),
      jsx(AggregateStats, { index }),
      jsxs("div", { className: "panel-section panel-legend", children: [
        jsx("span", { className: "defs-heading", children: "Legend" }),
        jsx("div", { className: "defs-toggles", children: DEFINITIONS.map((d) => jsx("button", {
          className: `defs-pill ${open === d.key ? "active" : ""}`,
          onClick: () => onOpen(open === d.key ? null : d.key),
          children: `${open === d.key ? "▾" : "▸"} ${d.label}`,
        }, d.key)) }),
        rows.length > 0 && jsx("div", { className: "defs-list panel-defs", children: rows.map(([term, text], i) =>
          jsxs(Fragment, { children: [
            jsx("div", { className: "defs-term", children: term }),
            jsx("div", { className: "defs-text", children: text })] }, i)) }),
      ] }),
    ] }),
  });
}

const TABS = [{ key: "leaderboard", label: "Leaderboard" }, { key: "scenarios", label: "Transcripts" },
  { key: "figures", label: "Figures" }];
function App() {
  const [state, setRawState] = useState(readHash);
  const [runs, setRuns] = useState(null);
  const [index, setIndex] = useState(null);
  const [error, setError] = useState(null);
  const setState = (changes, push = false) => {
    const next = { ...state, ...changes };
    writeHash(next, push);
    setRawState(next);
  };
  useEffect(() => {
    const onHash = () => setRawState(readHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const loadRuns = () => fetch("/api/runs").then((r) => r.json()).then(setRuns).catch((e) => setError(e.message));
  useEffect(() => { loadRuns(); }, []);
  // Exactly one run is shown at a time; the first listed (the newest) by default.
  const selected = !runs || runs.length === 0 ? []
    : [runs.some((r) => r.run === state.run) ? state.run : runs[0].run];
  const chosen = (runs || []).filter((r) => selected.includes(r.run));
  const running = chosen.some((r) => !r.summary);
  // An escalating run shown as its first turns only is read like a single-turn run.
  const first = !!(chosen[0] && chosen[0].escalating && state.first);
  const query = `runs=${encodeURIComponent(selected.join(","))}${first ? "&first=1" : ""}`;
  const escalating = !!(chosen[0] && chosen[0].escalating) && !first;
  // The run's system prompts, no system prompt first; with several, the other tabs show one at a time.
  const prompts = chosen[0] ? chosen[0].settings.system_prompts.map(([name]) => name)
    .sort((a, b) => (a === "none" ? -1 : b === "none" ? 1 : a.localeCompare(b))) : [];
  const sp = prompts.length > 1 ? (prompts.includes(state.sp) ? state.sp : prompts[0]) : null;
  const defs = chosen.length > 0 ? chosen[0].definitions : null;
  if (defs) {
    CATEGORIES = [...defs.categories.map(([c]) => c), CLASSIFIER];
    TAGS = defs.tags.map(([t]) => t);
    GRADED = defs.graded || {};
  }
  useEffect(() => {
    if (!runs) return;
    if (selected.length === 0) return setIndex([]);
    const load = () => fetch(`/api/index?${query}`)
      .then((r) => r.json()).then(setIndex).catch((e) => setError(e.message));
    load();
    if (!running) return;
    const timer = setInterval(() => { loadRuns(); load(); }, 15000);  // A run in progress keeps adding results.
    return () => clearInterval(timer);
  }, [runs && runs.map((r) => r.run + r.records + !!r.summary).join(), query]);
  const tabs = [...TABS, ...(sp && !escalating ? [{ key: "system_prompts", label: "System prompts" }] : [])];
  const tab = tabs.some((t) => t.key === state.tab) ? state.tab : "leaderboard";
  const shown = useMemo(() => (index && sp && tab !== "system_prompts" ? index.filter((r) => r.system_prompt === sp) : index),
    [index, sp, tab]);
  // Only the models with conversations in what's shown (a model may have run under one system prompt only).
  const series = useMemo(() => seriesFor(chosen).filter((s) => !shown || shown.some((r) => r.model === s.model)),
    [chosen.map((r) => r.run + r.config.models).join(","), shown]);
  return jsxs("div", {
    className: "app",
    children: [
      jsx("header", { className: "site-header", children: jsx("h1", { className: "site-title", children: document.title }) }),
      error && jsxs("div", { className: "empty-state", children: [jsx("h2", { children: "Could not load runs" }), jsx("p", { children: error })] }),
      runs && runs.length === 0 && jsx("div", { className: "empty-state", children: jsx("h2", { children: "No runs yet" }) }),
      runs && runs.length > 0 && jsx(RunPicker, { runs, selected,
        onSelect: (run) => setState({ run: run === runs[0].run ? null : run, sp: null, first: null, s: null, reply: null }) }),
      defs && selected.length > 0 && jsx(Definitions, { open: state.defs || null, onOpen: (d) => setState({ defs: d }),
        defs, run: chosen[0], index: shown, settings: { prompts, sp: tab === "system_prompts" ? null : sp,
          onSp: (v) => setState({ sp: v === prompts[0] ? null : v, s: null, reply: null }), first,
          onFirst: (v) => setState({ first: v ? "1" : null, s: null, reply: null }) } }),
      runs && runs.length > 0 && (!index || !defs) && jsx("div", { className: "empty-state", children: "Loading results…" }),
      index && defs && runs.length > 0 && jsxs(Fragment, {
        children: [
          jsx("nav", { className: "nav", children: tabs.map((t) => jsx("button", {
            onClick: () => setState({ tab: t.key, s: null, reply: null }, true),
            className: `nav-btn ${tab === t.key ? "active" : ""}`,
            children: t.label,
          }, t.key)) }),
          tab === "leaderboard" && jsx(escalating ? EscalationLeaderboard : Leaderboard,
            { index: shown, series, state, setState }),
          tab === "scenarios" && jsx(Scenarios, { index: shown, series, state, setState, query, sp }),
          tab === "figures" && jsx(Figures, { index: shown, series, state, setState,
            onOpen: (id, reply = null) => setState({ tab: "scenarios", s: id, reply, q: null, model: null, score: null }, true) }),
          tab === "system_prompts" && jsx(SystemPromptsPage, { index, prompts, run: chosen[0] }),
        ],
      }),
    ],
  });
}

ReactDOM.createRoot(document.getElementById("root")).render(jsx(App, {}));
