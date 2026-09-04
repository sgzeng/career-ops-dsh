#!/usr/bin/env node
/**
 * render-roles-html.mjs — rebuild ai-security-roles.html from the native tracker.
 *
 * Source of truth: roles-model.mjs, which reads data/applications.md (tracker),
 * reports/*.md (Machine Summary), data/pipeline.md (unevaluated scan hits) and
 * data/scan-history.tsv (posted/portal join). Deterministic and offline — the
 * `pipeline` / `triage` modes do discovery and scoring; this script only
 * renders the page. Run it after every pipeline run, or use `npm run
 * serve:roles` for a live view with working row actions (move/delete).
 *
 *   node roles/render-roles-html.mjs
 *   node roles/render-roles-html.mjs --out ../ai-security-roles.html
 *
 * This file opened directly (file://) is read-only — the Actions column and
 * its API calls only activate when the page is served over http (see
 * serve-roles.mjs). Column-visibility and active-tab choices persist in the
 * viewer's own localStorage.
 */

import { writeFileSync } from 'fs';
import path from 'path';
import { buildRoleModel } from './roles-model.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.resolve(flag('--out', '../ai-security-roles.html'));

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const { rows: data, generatedAt } = buildRoleModel({ root: ROOT });

// Live tabs first (most useful for a "what should I look at" view), evaluated
// ranked by match%, everything else newest-first.
const TAB_ORDER = ['new', 'evaluated', 'submitted', 'pending', 'offered', 'rejected', 'archived', 'deleted'];
const TAB_LABELS = {
  new: 'New openings', evaluated: 'Evaluated openings', submitted: 'Submitted',
  pending: 'Pending', offered: 'Offered', rejected: 'Rejected',
  archived: 'Archived', deleted: 'Deleted',
};
data.sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));

const tabCounts = Object.fromEntries(TAB_ORDER.map((t) => [t, data.filter((r) => r.tab === t).length]));
const stats = {
  total: data.filter((r) => r.tab !== 'deleted').length,
  hot: data.filter((r) => (r.pct ?? 0) >= 90 && r.tab !== 'deleted').length,
  fresh: data.filter((r) => r.isNew && r.tab !== 'deleted').length,
};

// ── Column registry ────────────────────────────────────────────────────────
//   w    = natural / target-max width (px). Auto-fit never grows a column past
//          this from content alone; slack distribution may exceed it for `grow`.
//   min  = floor width (px). Auto-fit and manual drag never go below this.
//   grow = text column: absorbs leftover width when the table is roomy, and is
//          the first to be squeezed (toward `min`) when the table is tight.
// Applied client-side via <colgroup> + table-layout:fixed (see autoFit()).
const COLS = [
  { id: 'co', label: 'Company', w: 150, min: 84, grow: true },
  { id: 'team', label: 'Team', w: 160, min: 96, grow: true },
  { id: 'role', label: 'Role', w: 260, min: 100, grow: true },
  { id: 'why', label: 'Why it fits', w: 320, min: 124, grow: true },
  { id: 'loc', label: 'Location', w: 150, min: 66, grow: true },
  { id: 'remote', label: 'Remote', w: 80, min: 40 },
  { id: 'sal', label: 'Salary', w: 120, min: 58 },
  { id: 'pct', label: 'Match %', w: 90, min: 52 },
  { id: 'score', label: 'Score', w: 70, min: 42 },
  { id: 'legitimacy', label: 'Legitimacy', w: 130, min: 44 },
  { id: 'workauth', label: 'Work auth', w: 120, min: 44 },
  { id: 'risk', label: 'Risk', w: 90, min: 42 },
  { id: 'source', label: 'Source', w: 100, min: 46 },
  { id: 'posted', label: 'Posted', w: 100, min: 52 },
  { id: 'seen', label: 'Seen', w: 90, min: 44 },
  { id: 'softgaps', label: 'Soft gaps', w: 220, min: 84, grow: true },
  { id: 'hardstops', label: 'Hard stops', w: 220, min: 84, grow: true },
  { id: 'report', label: 'Report', w: 90, min: 44 },
  { id: 'pdf', label: 'PDF', w: 60, min: 36 },
  { id: 'apply', label: 'Apply', w: 100, min: 58 },
];
const ACTIONS_W = { live: 96, readonly: 150 };

// Per-column help text (what it holds / where it comes from / why it matters),
// shown as a cursor tooltip on the header cell and the "Enabled info" toggle.
const COL_DOC = {
  co:        { what: '公司名。', src: 'tracker（data/applications.md）的 Company 列；还没评估的新行来自 data/pipeline.md 的扫描命中。' },
  team:      { what: '岗位所属团队/线，或匹配到的 archetype。', src: '评估报告 ## Machine Summary 的 archetype；没有报告时取 Notes 里「pct N · team · why」约定的中段。', why: '判断它属于公司哪条线、是不是你的目标方向。' },
  role:      { what: '职位名称。', src: 'tracker / data/pipeline.md / data/scan-history.tsv。' },
  why:       { what: '这个岗位最强的一条匹配理由（一句话）。', src: '报告 ## Machine Summary 的 top_strengths 第一条；没有报告时取 Notes 的 why 段。', why: '一眼判断值不值得动手。' },
  loc:       { what: '岗位地点（可能多地并列）。', src: 'data/scan-history.tsv / data/pipeline.md / JD 原文。', why: '远程 / 通勤 / 搬迁 / 签证相关。' },
  remote:    { what: '是否接受远程。', src: '从地点文本和 JD 推断。' },
  sal:       { what: 'JD 公示的薪资。', src: '报告 ## Machine Summary 的 advertised_comp。', why: '对照你的底线 $150K。' },
  pct:       { what: '0–100 匹配分。', src: '按 modes/_custom.md 的 Scoring Rules（0–100 rubric）打分，写进报告的 pct: 字段。', why: '页面默认排序键；≥90 才提示生成定制 CV。' },
  score:     { what: 'pct 投影到 career-ops 的 1–5 分（round(pct/20,1)）。', src: '由 pct 换算。', why: 'stats / dashboard 等原生工具用的口径。' },
  legitimacy:{ what: '招聘启事的可信度分级。', src: '评估报告 Block G（Posting Legitimacy）的 legitimacy_tier。', why: '过滤影子岗 / 钓鱼帖。' },
  workauth:  { what: '针对该岗位的签证 / sponsorship 判断。', src: '报告的 work_auth 字段。', why: 'F-1 / 需要 H-1B —— 硬门槛。' },
  risk:      { what: '综合风险级别。', src: '报告 Risk Summary 的 risk_level。' },
  source:    { what: '哪个扫描器 / 渠道发现的（greenhouse-api / ashby-api / lever-api / yc-seed / websearch …）。', src: 'data/scan-history.tsv 的 portal 列。' },
  posted:    { what: '岗位发布日期。', src: 'data/scan-history.tsv 的 posted_at。', why: '新鲜度。' },
  seen:      { what: '扫描器第一次看到它是多久以前。', src: 'data/scan-history.tsv 的首见日期换算。', why: '>60 天且无在招证据 → 硬排除。' },
  softgaps:  { what: '可弥补的简历 ↔ JD 差距。', src: '报告的 soft_gaps 列表。', why: '面试前要补的点。' },
  hardstops: { what: '硬性阻断项（不满足的强制条件）。', src: '报告的 hard_stops 列表。', why: '命中即淘汰。' },
  report:    { what: '完整评估报告的链接。', src: 'reports/NNN-*.md。' },
  pdf:       { what: '是否已生成定制 CV PDF。', src: 'tracker 的 PDF 列（pct ≥ 80 自动生成）。' },
  apply:     { what: '岗位投递链接；没有公开 URL 时显示「Outreach」（走冷邮件）。', src: 'tracker / 报告里的 URL。' },
};

const CSS = String.raw`
:root {
  --bg:#07080d; --surface:#0e1118; --surface-alt:#131925;
  --border:#1c2538; --border-hi:#2e4068;
  --text:#dce1ec; --text-sub:#8492b0; --text-dim:#3a4560;
  --accent:#00c9a0; --accent-dim:rgba(0,201,160,.10);
  --violet:#8b78f6; --violet-dim:rgba(139,120,246,.12);
  --danger:#f0533a; --danger-dim:rgba(240,83,58,.12);
  --hot:#00c9a0; --hot-dim:rgba(0,201,160,.10);
  --strong:#4bbef7; --strong-dim:rgba(75,190,247,.10);
  --good:#f0b333; --good-dim:rgba(240,179,51,.10);
  --stretch:#5a6a88; --stretch-dim:rgba(90,106,136,.10);
  --mono:'IBM Plex Mono','SFMono-Regular',Menlo,'Courier New',monospace;
  --sans:'IBM Plex Sans',system-ui,-apple-system,sans-serif;
  --r:4px;
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
    --bg:#edf0f7; --surface:#ffffff; --surface-alt:#f3f6fc;
    --border:#dde3f0; --border-hi:#b0bedd;
    --text:#0d1322; --text-sub:#6a7899; --text-dim:#b5c0d8;
    --accent:#009e7f; --accent-dim:rgba(0,158,127,.10);
    --violet:#6248e0; --violet-dim:rgba(98,72,224,.10);
    --danger:#c22e1a; --danger-dim:rgba(194,46,26,.09);
    --hot:#007d65; --hot-dim:rgba(0,125,101,.09);
    --strong:#1878b0; --strong-dim:rgba(24,120,176,.09);
    --good:#9a6e00; --good-dim:rgba(154,110,0,.09);
    --stretch:#7a8aa8; --stretch-dim:rgba(122,138,168,.09);
  }
}
:root[data-theme="light"] {
  --bg:#edf0f7; --surface:#ffffff; --surface-alt:#f3f6fc;
  --border:#dde3f0; --border-hi:#b0bedd;
  --text:#0d1322; --text-sub:#6a7899; --text-dim:#b5c0d8;
  --accent:#009e7f; --accent-dim:rgba(0,158,127,.10);
  --violet:#6248e0; --violet-dim:rgba(98,72,224,.10);
  --danger:#c22e1a; --danger-dim:rgba(194,46,26,.09);
  --hot:#007d65; --hot-dim:rgba(0,125,101,.09);
  --strong:#1878b0; --strong-dim:rgba(24,120,176,.09);
  --good:#9a6e00; --good-dim:rgba(154,110,0,.09);
  --stretch:#7a8aa8; --stretch-dim:rgba(122,138,168,.09);
}
:root[data-theme="dark"] {
  --bg:#07080d; --surface:#0e1118; --surface-alt:#131925;
  --border:#1c2538; --border-hi:#2e4068;
  --text:#dce1ec; --text-sub:#8492b0; --text-dim:#3a4560;
  --accent:#00c9a0; --accent-dim:rgba(0,201,160,.10);
  --violet:#8b78f6; --violet-dim:rgba(139,120,246,.12);
  --danger:#f0533a; --danger-dim:rgba(240,83,58,.12);
  --hot:#00c9a0; --hot-dim:rgba(0,201,160,.10);
  --strong:#4bbef7; --strong-dim:rgba(75,190,247,.10);
  --good:#f0b333; --good-dim:rgba(240,179,51,.10);
  --stretch:#5a6a88; --stretch-dim:rgba(90,106,136,.10);
}
*,*::before,*::after { box-sizing:border-box; margin:0; padding:0; }
body { font-family:var(--sans); background:var(--bg); color:var(--text); min-height:100vh; font-size:13px; line-height:1.5; }
/* Track the window width — the table fills whatever room the viewport gives it
   (autoFit distributes the slack to the text columns). Cap only guards against
   a degenerate stretch on an ultra-wide display. */
.page { max-width:2560px; margin:0 auto; padding:28px 24px 60px; }
header { display:flex; align-items:flex-start; justify-content:space-between; gap:24px; margin-bottom:20px; padding-bottom:22px; border-bottom:1px solid var(--border); flex-wrap:wrap; }
.eyebrow { font-family:var(--mono); font-size:10px; letter-spacing:.12em; text-transform:uppercase; color:var(--accent); margin-bottom:6px; }
h1 { font-size:20px; font-weight:600; letter-spacing:-.02em; margin-bottom:12px; text-wrap:balance; }
.skill-tags { display:flex; flex-wrap:wrap; gap:5px; }
.skill-tag { font-family:var(--mono); font-size:10px; padding:3px 8px; border:1px solid var(--border); border-radius:3px; color:var(--text-sub); background:var(--surface-alt); letter-spacing:.02em; }
.header-stats { display:flex; gap:24px; flex-shrink:0; }
.stat { text-align:right; }
.stat-val { font-family:var(--mono); font-size:26px; font-weight:600; line-height:1; font-variant-numeric:tabular-nums; }
.stat-val.accent{color:var(--accent);} .stat-val.violet{color:var(--violet);} .stat-val.sub{color:var(--text-sub);}
.stat-lbl { font-size:10px; color:var(--text-sub); margin-top:3px; }

.tab-strip { display:flex; gap:4px; flex-wrap:wrap; margin-bottom:14px; border-bottom:1px solid var(--border); padding-bottom:0; }
.tab-btn { font-family:var(--mono); font-size:11px; padding:8px 12px; border:1px solid transparent; border-bottom:none; border-radius:4px 4px 0 0; background:transparent; color:var(--text-sub); cursor:pointer; letter-spacing:.02em; display:flex; align-items:center; gap:6px; transform:translateY(1px); }
.tab-btn:hover { color:var(--text); }
.tab-btn.on { color:var(--accent); background:var(--surface); border-color:var(--border); border-bottom-color:var(--surface); }
.tab-count { font-size:9px; padding:1px 5px; border-radius:8px; background:var(--surface-alt); color:var(--text-dim); }
.tab-btn.on .tab-count { background:var(--accent-dim); color:var(--accent); }

.controls { display:flex; align-items:center; gap:8px; margin-bottom:12px; flex-wrap:wrap; }
.search-wrap { position:relative; flex:0 1 240px; }
.search-wrap input { width:100%; background:var(--surface); border:1px solid var(--border); border-radius:var(--r); color:var(--text); font-family:var(--mono); font-size:11px; padding:7px 10px 7px 28px; outline:none; transition:border-color .15s; }
.search-wrap input:focus { border-color:var(--border-hi); }
.search-wrap input::placeholder { color:var(--text-dim); }
.search-ico { position:absolute; left:9px; top:50%; transform:translateY(-50%); color:var(--text-dim); font-family:var(--mono); font-size:13px; pointer-events:none; line-height:1; }
.btn-group { display:flex; gap:3px; }
.chip { font-family:var(--mono); font-size:10px; padding:6px 10px; border-radius:3px; border:1px solid var(--border); background:transparent; color:var(--text-sub); cursor:pointer; transition:all .12s; white-space:nowrap; letter-spacing:.03em; }
.chip:hover { border-color:var(--border-hi); color:var(--text); }
.chip.on { background:var(--accent-dim); border-color:var(--accent); color:var(--accent); }
.chip.hot.on{background:var(--hot-dim);border-color:var(--hot);color:var(--hot);}
.chip.str.on{background:var(--strong-dim);border-color:var(--strong);color:var(--strong);}
.chip.good.on{background:var(--good-dim);border-color:var(--good);color:var(--good);}
.chip.vio.on{background:var(--violet-dim);border-color:var(--violet);color:var(--violet);}
.controls-tail { margin-left:auto; display:flex; align-items:center; gap:10px; }
.result-count { font-family:var(--mono); font-size:10px; color:var(--text-dim); }
.theme-btn { background:var(--surface); border:1px solid var(--border); border-radius:3px; width:28px; height:28px; cursor:pointer; color:var(--text-sub); font-size:14px; display:flex; align-items:center; justify-content:center; transition:border-color .12s; }
.theme-btn:hover { border-color:var(--border-hi); color:var(--text); }

.col-toggles { display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-bottom:14px; padding:10px 12px; border:1px solid var(--border); border-radius:6px; background:var(--surface); }
.col-toggles-label { font-family:var(--mono); font-size:9px; letter-spacing:.1em; text-transform:uppercase; color:var(--text-dim); margin-right:4px; }
.col-tag { font-family:var(--mono); font-size:9px; padding:3px 7px; border-radius:3px; border:1px solid var(--border); background:transparent; color:var(--text-dim); cursor:pointer; letter-spacing:.03em; user-select:none; }
.col-tag.on { background:var(--accent-dim); border-color:var(--accent); color:var(--accent); }
.col-toggles .sep { width:1px; align-self:stretch; background:var(--border); margin:0 2px; }
.col-tag.mini-btn { color:var(--text-sub); }

.table-outer { --table-fs:13px; overflow-x:auto; border:1px solid var(--border); border-radius:8px; background:var(--surface); }
table { width:100%; border-collapse:collapse; table-layout:fixed; }
thead th { font-family:var(--mono); font-size:9px; letter-spacing:.1em; text-transform:uppercase; color:var(--text-dim); padding:10px 12px; text-align:left; border-bottom:1px solid var(--border); background:var(--surface); user-select:none; cursor:pointer; position:relative; overflow:hidden; }
thead th .th-label { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
thead th[data-nosort] { cursor:default; }
thead th:hover { color:var(--text-sub); }
thead th.sorted { color:var(--accent); }
/* Drag handle on the right edge of every header cell. Sits above the label,
   has its own cursor, and swallows the click so sorting doesn't fire. */
.col-resize { position:absolute; right:0; top:0; height:100%; width:9px; cursor:col-resize; touch-action:none; z-index:2; }
.col-resize::after { content:''; position:absolute; right:3px; top:3px; bottom:3px; width:1px; background:transparent; transition:background .12s; }
.col-resize:hover::after, .col-resize.dragging::after { background:var(--border-hi); }
thead th:last-child .col-resize { display:none; }
body.col-resizing { cursor:col-resize; user-select:none; }
body.col-resizing * { cursor:col-resize !important; }
tbody tr { border-bottom:1px solid var(--border); transition:background .1s; }
tbody tr:last-child { border-bottom:none; }
tbody tr:hover { background:var(--surface-alt); }
tbody td { padding:9px 12px; vertical-align:top; font-size:var(--table-fs); overflow-wrap:anywhere; }
tbody td:first-child { padding-left:15px; }
tbody td:first-child::before { content:''; position:absolute; left:0; top:0; bottom:0; width:3px; }

/* Company (first) and Actions (last) columns stay pinned during horizontal
   scroll — the row stays identifiable and the Actions ▾ menu is always in reach. */
thead th:first-child, tbody td:first-child { position:sticky; left:0; z-index:3; background:var(--surface); }
thead th:last-child, tbody td:last-child { position:sticky; right:0; z-index:3; background:var(--surface); }
thead th:first-child, thead th:last-child { z-index:4; }
thead th:first-child, tbody td:first-child { border-right:1px solid var(--border); }
thead th:last-child, tbody td:last-child { border-left:1px solid var(--border); }
tbody tr:hover td:first-child, tbody tr:hover td:last-child { background:var(--surface-alt); }
tr.t-hot td:first-child::before{background:var(--hot);}
tr.t-strong td:first-child::before{background:var(--strong);}
tr.t-good td:first-child::before{background:var(--good);}
tr.t-stretch td:first-child::before{background:var(--stretch);}
tr.is-stale { opacity:.55; }
/* Cell text tracks --table-fs (set on .table-outer, stepped down by autoFit on
   tight viewports). Sizes are em so one variable scales the whole grid. */
.co-name { font-weight:600; font-size:1em; display:flex; align-items:center; gap:5px; flex-wrap:wrap; }
.badge { font-family:var(--mono); font-size:.7em; padding:1px 5px; border-radius:2px; text-transform:uppercase; letter-spacing:.05em; flex-shrink:0; }
.b-new { background:var(--hot-dim); color:var(--hot); border:1px solid rgba(0,201,160,.28); }
.role { font-size:.92em; color:var(--text); font-weight:500; }
.why, .desc-txt { font-size:.85em; color:var(--text-sub); line-height:1.5; }
.loc { font-family:var(--mono); font-size:.85em; color:var(--text-sub); overflow-wrap:anywhere; }
.remote-tag { display:inline-block; font-family:var(--mono); font-size:.7em; padding:1px 5px; border-radius:2px; background:var(--accent-dim); color:var(--accent); letter-spacing:.04em; }
.sal { font-family:var(--mono); font-size:.85em; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
.match-pct { font-family:var(--mono); font-size:1.08em; font-weight:600; font-variant-numeric:tabular-nums; line-height:1; margin-bottom:4px; }
tr.t-hot .match-pct{color:var(--hot);} tr.t-strong .match-pct{color:var(--strong);}
tr.t-good .match-pct{color:var(--good);} tr.t-stretch .match-pct{color:var(--stretch);}
.bar-track { height:2px; background:var(--border); border-radius:2px; overflow:hidden; width:100%; max-width:60px; }
.bar-fill { height:100%; border-radius:2px; }
tr.t-hot .bar-fill{background:var(--hot);} tr.t-strong .bar-fill{background:var(--strong);}
tr.t-good .bar-fill{background:var(--good);} tr.t-stretch .bar-fill{background:var(--stretch);}
.mono-cell { font-family:var(--mono); font-size:.85em; color:var(--text-sub); white-space:nowrap; }
.tag-list { display:flex; flex-direction:column; gap:2px; font-size:.85em; color:var(--text-sub); }
.tag-list .neg { color:var(--danger); }

/* Long free-text cells (Why it fits, Notes) — clamped by JS (clampDesc) to the
   height of the tallest sibling cell in the row; a "more" toggle reveals the
   rest. maxHeight is set inline per row. */
.desc-clamp { position:relative; overflow:hidden; }
.desc-clamp.clamped { padding-bottom:2px; }
.desc-clamp.clamped::after { content:''; position:absolute; left:0; right:0; bottom:0; height:18px; background:linear-gradient(to bottom, transparent, var(--surface)); pointer-events:none; }
tbody tr:hover .desc-clamp.clamped::after { background:linear-gradient(to bottom, transparent, var(--surface-alt)); }
.desc-clamp.expanded { overflow:visible; }
.desc-more { position:absolute; right:0; bottom:0; z-index:1; font-family:var(--mono); font-size:9px; line-height:1; padding:2px 5px; border:1px solid var(--border); border-radius:3px; background:var(--surface); color:var(--text-sub); cursor:pointer; letter-spacing:.03em; }
.desc-more:hover { color:var(--text); border-color:var(--border-hi); }
tbody tr:hover .desc-more { background:var(--surface-alt); }
.desc-clamp.expanded .desc-more { position:static; display:inline-block; margin-top:4px; }
.apply-link { display:inline-flex; align-items:center; gap:3px; font-family:var(--mono); font-size:.77em; padding:5px 9px; border-radius:3px; text-decoration:none; letter-spacing:.04em; white-space:nowrap; transition:all .12s; background:var(--accent-dim); border:1px solid rgba(0,201,160,.2); color:var(--accent); }
.apply-link:hover { background:rgba(0,201,160,.18); }
.direct-tag { font-family:var(--mono); font-size:.77em; padding:5px 9px; border-radius:3px; letter-spacing:.04em; background:transparent; border:1px solid var(--border); color:var(--text-sub); display:inline-block; }
.status-pill { font-family:var(--mono); font-size:.72em; padding:2px 7px; border-radius:10px; border:1px solid var(--border); color:var(--text-sub); display:inline-block; }
.empty { padding:48px; text-align:center; color:var(--text-sub); font-family:var(--mono); font-size:12px; }
.hidden { display:none !important; }

/* Actions dropdown — a single reusable fixed-position menu (see #actions-menu
   in the body), not one per row: an absolutely-positioned menu nested inside
   .table-outer's overflow-x:auto container gets clipped on the y axis too
   (overflow-x:auto implicitly computes overflow-y:auto), so it never escapes
   the scroll box. position:fixed + JS-computed coordinates sidesteps that. */
.actions-btn { font-family:var(--mono); font-size:11px; padding:5px 9px; border-radius:3px; border:1px solid var(--border); background:transparent; color:var(--text-sub); cursor:pointer; }
.actions-btn:hover { border-color:var(--border-hi); color:var(--text); }
#actions-menu { position:fixed; background:var(--surface); border:1px solid var(--border-hi); border-radius:6px; padding:4px; min-width:190px; z-index:100; box-shadow:0 8px 24px rgba(0,0,0,.35); }
#actions-menu button { display:block; width:100%; text-align:left; background:none; border:none; color:var(--text); font-family:var(--sans); font-size:12px; padding:7px 9px; border-radius:4px; cursor:pointer; }
#actions-menu button:hover { background:var(--surface-alt); }
#actions-menu button.danger { color:var(--danger); }
#actions-menu .menu-sep { height:1px; background:var(--border); margin:4px 0; }
.readonly-note { font-family:var(--mono); font-size:10px; color:var(--text-dim); padding:5px 9px; }

/* Column help tooltip — follows the cursor over a header cell or an "Enabled
   info" toggle, explains what the column holds, where it comes from, why it matters. */
#coltip { position:fixed; z-index:250; max-width:320px; background:var(--surface); border:1px solid var(--border-hi); border-radius:6px; padding:9px 11px; font-family:var(--sans); font-size:11px; line-height:1.5; color:var(--text); box-shadow:0 10px 30px rgba(0,0,0,.4); pointer-events:none; }
#coltip .ct-t { font-family:var(--mono); font-size:9px; letter-spacing:.09em; text-transform:uppercase; color:var(--accent); margin-bottom:5px; }
#coltip .ct-r { color:var(--text-sub); margin-top:3px; }
#coltip .ct-r b { color:var(--text); font-weight:600; }

.legend { display:flex; align-items:center; gap:18px; margin-top:14px; flex-wrap:wrap; }
.leg-item { display:flex; align-items:center; gap:6px; font-family:var(--mono); font-size:10px; color:var(--text-sub); }
.leg-dot { width:8px; height:3px; border-radius:1px; }
footer { margin-top:22px; padding-top:16px; border-top:1px solid var(--border); font-family:var(--mono); font-size:10px; color:var(--text-dim); display:flex; gap:16px; flex-wrap:wrap; }
.toast { position:fixed; bottom:20px; right:20px; background:var(--surface); border:1px solid var(--border-hi); border-radius:6px; padding:10px 14px; font-family:var(--mono); font-size:11px; color:var(--text); box-shadow:0 8px 24px rgba(0,0,0,.3); z-index:50; }
.toast.err { border-color:var(--danger); color:var(--danger); }

/* Column drag-to-reorder — the whole header cell is a drag source (the
   resize handle on its right edge opts out via pointerdown/preventDefault and
   an explicit target check in dragstart). */
thead th[draggable="true"] { cursor:grab; }
body.col-dragging, body.col-dragging * { cursor:grabbing !important; }
thead th.col-dragging { opacity:.4; }
thead th.col-drop-before { box-shadow:inset 3px 0 0 var(--accent); }
thead th.col-drop-after  { box-shadow:inset -3px 0 0 var(--accent); }

/* Click-to-edit cells (live server only). */
tbody td.editable .cellbox { cursor:text; }
tbody td.editable:hover .cellbox { outline:1px dashed var(--border-hi); outline-offset:2px; border-radius:3px; }
.cell-edit { width:100%; box-sizing:border-box; font-family:var(--sans); font-size:var(--table-fs); color:var(--text); background:var(--surface-alt); border:1px solid var(--accent); border-radius:3px; padding:4px 6px; outline:none; }
textarea.cell-edit { min-height:56px; resize:vertical; line-height:1.5; }
.cell-saving { font-family:var(--mono); font-size:.8em; color:var(--text-dim); }
`;

const colToggleHtml = COLS.map((c) => `<button class="col-tag on" data-col="${c.id}" onclick="toggleCol('${c.id}')">${esc(c.label)}</button>`).join('');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Security Roles</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@300;400;500;600&display=swap">
<style>${CSS}</style>
</head>
<body>
<div class="page">

  <header>
    <div>
      <div class="eyebrow">Job Search · updated ${esc(generatedAt)}</div>
      <h1>AI Security &amp; Vulnerability Research Roles</h1>
      <div class="skill-tags">
        <span class="skill-tag">Fuzzing</span>
        <span class="skill-tag">Concolic Execution</span>
        <span class="skill-tag">Program Analysis</span>
        <span class="skill-tag">Vulnerability Research</span>
        <span class="skill-tag">Reverse Engineering</span>
        <span class="skill-tag">AI Agents</span>
        <span class="skill-tag">LLVM · C/C++ · Python</span>
        <span class="skill-tag">PhD 2026</span>
      </div>
    </div>
    <div class="header-stats">
      <div class="stat"><div class="stat-val accent" id="s-total">${stats.total}</div><div class="stat-lbl">total roles</div></div>
      <div class="stat"><div class="stat-val violet" id="s-hot">${stats.hot}</div><div class="stat-lbl">at 90%+</div></div>
      <div class="stat"><div class="stat-val sub" id="s-new">${stats.fresh}</div><div class="stat-lbl">new today</div></div>
    </div>
  </header>

  <div class="tab-strip" id="tab-strip">
    ${TAB_ORDER.map((t, i) => `<button class="tab-btn${i === 0 ? ' on' : ''}" data-tab="${t}" onclick="setTab('${t}')">${esc(TAB_LABELS[t])} <span class="tab-count" id="tc-${t}">${tabCounts[t]}</span></button>`).join('\n    ')}
  </div>

  <div class="controls">
    <div class="search-wrap">
      <span class="search-ico">⌕</span>
      <input type="text" id="q" placeholder="Search company, role, team…" oninput="go()">
    </div>
    <div class="btn-group" id="tier-btns">
      <button class="chip on"   data-t="all"    onclick="setTier(this)">All</button>
      <button class="chip hot"  data-t="hot"    onclick="setTier(this)">95%+ Hot</button>
      <button class="chip str"  data-t="strong" onclick="setTier(this)">85%+ Strong</button>
      <button class="chip good" data-t="good"   onclick="setTier(this)">75%+ Good</button>
    </div>
    <button class="chip vio" id="b-new"     onclick="tog('isNew')">New today</button>
    <button class="chip vio" id="b-remote"  onclick="tog('remote')">Remote</button>
    <div class="controls-tail">
      <span class="result-count" id="rc">${data.length} of ${data.length}</span>
      <button class="theme-btn" onclick="cycleTheme()" title="Toggle theme">◑</button>
    </div>
  </div>

  <div class="col-toggles">
    <span class="col-toggles-label">Enabled info</span>
    ${colToggleHtml}
    <div class="sep"></div>
    <button class="col-tag mini-btn" onclick="setAllCols(true)">All</button>
    <button class="col-tag mini-btn" onclick="setAllCols(false)">None</button>
    <div class="sep"></div>
    <button class="col-tag mini-btn" onclick="resetColW()" title="Clear manual column widths — back to auto-fit">Reset widths</button>
    <button class="col-tag mini-btn" onclick="resetColOrder()" title="Back to the default column order">Reset order</button>
  </div>

  <div class="table-outer">
    <table id="tbl">
      <colgroup id="cg"></colgroup>
      <thead><tr id="thead-row"></tr></thead>
      <tbody id="tb"></tbody>
    </table>
    <div class="empty hidden" id="empty">No roles match.</div>
  </div>

  <div id="actions-menu" class="hidden" onclick="event.stopPropagation()"></div>
  <div id="coltip" class="hidden"></div>

  <div class="legend">
    <div class="leg-item"><div class="leg-dot" style="background:var(--hot)"></div>95%+ Hot</div>
    <div class="leg-item"><div class="leg-dot" style="background:var(--strong)"></div>85–94% Strong</div>
    <div class="leg-item"><div class="leg-dot" style="background:var(--good)"></div>75–84% Good</div>
    <div class="leg-item"><div class="leg-dot" style="background:var(--stretch)"></div>&lt;75% Stretch</div>
    <div class="leg-item" id="mode-note" style="margin-left:auto"></div>
  </div>

  <footer>
    <span>Generated by career-ops · render-roles-html.mjs</span>
    <span>Source: data/applications.md + data/pipeline.md + reports/ · scored per modes/_custom.md</span>
    <span>Rendered: ${esc(generatedAt)}</span>
  </footer>
</div>

<script>
const D = ${JSON.stringify(data)};
const COLS = ${JSON.stringify(COLS)};
const COL_DOC = ${JSON.stringify(COL_DOC)};
const TAB_ORDER = ${JSON.stringify(TAB_ORDER)};
const TAB_LABELS = ${JSON.stringify(TAB_LABELS)};
const IS_LIVE = location.protocol === 'http:' || location.protocol === 'https:';
const esc = s => String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function tier(p){ if(p==null) return 'stretch'; return p>=95?'hot':p>=85?'strong':p>=75?'good':'stretch'; }

// ── column visibility (persisted) ──────────────────────────────────
let colState = {};
try { colState = JSON.parse(localStorage.getItem('roles.cols.v1') || '{}'); } catch {}
for (const c of COLS) if (!(c.id in colState)) colState[c.id] = true; // default on
function saveCols(){ try { localStorage.setItem('roles.cols.v1', JSON.stringify(colState)); } catch {} }
function applyColVisibility(){
  for (const c of COLS) {
    const on = colState[c.id];
    document.querySelectorAll('[data-col="'+c.id+'"]').forEach(el => el.classList.toggle('hidden', !on));
    const tag = document.querySelector('.col-tag[data-col="'+c.id+'"]');
    if (tag) tag.classList.toggle('on', on);
  }
  buildColgroup();
}
function toggleCol(id){ colState[id] = !colState[id]; saveCols(); applyColVisibility(); layout(); }
function setAllCols(v){ for (const c of COLS) colState[c.id] = v; saveCols(); applyColVisibility(); layout(); }
const COLMAP = Object.fromEntries(COLS.map(c => [c.id, c]));

// ── column order (persisted, drag to reorder) ──────────────────────
let colOrder = [];
try { colOrder = JSON.parse(localStorage.getItem('roles.colorder.v1') || '[]'); } catch {}
function saveColOrder(){ try { localStorage.setItem('roles.colorder.v1', JSON.stringify(colOrder)); } catch {} }
// Saved ids first (in saved order, dropping unknowns), then any column the saved
// list doesn't mention yet — so a new column added to COLS still shows up.
function orderedCols(){
  const seen = new Set();
  const out = [];
  for (const id of colOrder) { const c = COLMAP[id]; if (c && !seen.has(id)) { seen.add(id); out.push(c); } }
  for (const c of COLS) if (!seen.has(c.id)) out.push(c);
  return out;
}
function moveCol(fromId, toId, after){
  const ids = orderedCols().map(c => c.id).filter(id => id !== fromId);
  let ti = ids.indexOf(toId);
  if (ti < 0) return;
  ids.splice(after ? ti + 1 : ti, 0, fromId);
  colOrder = ids; saveColOrder();
  buildHeader(); go();
}
function resetColOrder(){ colOrder = []; try { localStorage.removeItem('roles.colorder.v1'); } catch {} buildHeader(); go(); }
const visCols = () => orderedCols().filter(c => colState[c.id]);

// ── column widths: content-aware auto-fit + manual drag (persisted) ────────
// <colgroup> + table-layout:fixed make column widths authoritative. autoFit()
// measures each visible column's natural content width (canvas text metrics),
// then fits the set to the container: hands slack to text columns when roomy,
// squeezes them toward their floor + steps the font down (13→12→11) when tight,
// and only lets the table overflow (horizontal scroll) as a last resort.
const MONO = "'IBM Plex Mono','SFMono-Regular',Menlo,monospace";
const SANS = "'IBM Plex Sans',system-ui,-apple-system,sans-serif";
const FS_STEPS = [13, 12, 11];
let curFs = 13;
let _rows = [];
let colW = {};
try { colW = JSON.parse(localStorage.getItem('roles.colw.v1') || '{}'); } catch {}
const manualW = (id) => colW[id] && colW[id].manual ? colW[id].px : null;
function saveColW(){
  try {
    const m = {}; for (const k in colW) if (colW[k] && colW[k].manual) m[k] = colW[k];
    localStorage.setItem('roles.colw.v1', JSON.stringify(m));
  } catch {}
}
function resetColW(){ colW = {}; try { localStorage.removeItem('roles.colw.v1'); } catch {} layout(); }

const _mctx = document.createElement('canvas').getContext('2d');
function _lines(html){
  const d = document.createElement('div'); d.innerHTML = html;
  const parts = [];
  d.querySelectorAll('div,li,a,span.mono-cell').forEach(n => { if (n.children.length === 0) parts.push(n.textContent); });
  if (!parts.length) parts.push(d.textContent || '');
  return parts;
}
function measureCol(c){
  // Header contributes a floor only — capped so one long label ("Confidence",
  // "Legitimacy") can't inflate an otherwise-empty column; .th-label ellipsizes.
  _mctx.font = '600 ' + Math.max(8, curFs - 4) + "px " + MONO;
  let content = 0;
  const headerFloor = Math.min(_mctx.measureText(c.label).width + 22, 86);
  _mctx.font = curFs + 'px ' + SANS;
  for (const r of _rows) {
    for (const line of _lines(cellFor(c.id, r, tier(r.pct)))) {
      const s = String(line).trim();
      if (s === '' || s === '—') continue;
      for (const seg of s.split(' · ')) {
        const w = _mctx.measureText(seg.trim()).width;
        if (w > content) content = w;
      }
    }
  }
  return Math.max(headerFloor, Math.ceil(content) + 24); // cell L/R padding
}
function autoFit(){
  const outer = document.querySelector('.table-outer');
  const cg = document.getElementById('cg');
  if (!outer || !cg) return;
  const vis = visCols();
  const actW = IS_LIVE ? ${ACTIONS_W.live} : ${ACTIONS_W.readonly};
  const budget = Math.max(320, outer.clientWidth - actW - 2);
  let chosen = null;
  for (let s = 0; s < FS_STEPS.length; s++) {
    curFs = FS_STEPS[s];
    const w = {};
    for (const c of vis) {
      const m = manualW(c.id);
      w[c.id] = m != null ? Math.max(c.min, m) : Math.max(c.min, Math.min(c.w, measureCol(c)));
    }
    const sum = vis.reduce((a, c) => a + w[c.id], 0);
    if (sum <= budget) {
      const grow = vis.filter(c => c.grow && manualW(c.id) == null);
      let slack = budget - sum;
      if (grow.length && slack > 0) {
        // Pass 1: grow the text columns toward a comfortable ~1.7x their natural
        // width, weighted so the widest ones take the most.
        const caps = grow.map(c => Math.max(0, c.w * 1.7 - w[c.id]));
        const tot = caps.reduce((a, b) => a + b, 0);
        const give = Math.min(slack, tot);
        grow.forEach((c, i) => { if (tot) w[c.id] += give * caps[i] / tot; });
        slack -= give;
        // Pass 2: any slack still left goes out proportionally so the table
        // always spans the full container (no dead gap on wide monitors).
        if (slack > 1) {
          const wtot = grow.reduce((a, c) => a + c.w, 0);
          grow.forEach(c => { w[c.id] += slack * c.w / wtot; });
        }
      }
      chosen = w; break;
    }
    const shr = vis.filter(c => c.grow && manualW(c.id) == null);
    const over = sum - budget;
    const room = shr.reduce((a, c) => a + (w[c.id] - c.min), 0);
    if (room >= over) {
      const k = over / room;
      shr.forEach(c => { w[c.id] -= (w[c.id] - c.min) * k; });
      chosen = w; break;
    }
    if (s === FS_STEPS.length - 1) { shr.forEach(c => { w[c.id] = c.min; }); chosen = w; } // overflow — last resort
  }
  if (!chosen) return;
  outer.style.setProperty('--table-fs', curFs + 'px');
  let total = actW;
  vis.forEach((c, i) => {
    const px = Math.round(chosen[c.id]); total += px;
    const col = cg.children[i]; if (col) col.style.width = px + 'px';
  });
  const ac = cg.children[vis.length]; if (ac) ac.style.width = actW + 'px';
  const tbl = document.getElementById('tbl');
  // Pin the table to the computed total so fixed-layout doesn't redistribute
  // our deliberate per-column sizing; < container ⇒ table sits narrow, > ⇒ scroll.
  tbl.style.width = total + 'px';
  tbl.style.minWidth = total + 'px';
}

// ── description clamp: cap long free-text cells at the tallest sibling cell ──
// Any column whose cell can hold a paragraph / multi-item list: it is clamped to
// the height of the rest of its row and gets a "more" toggle when it overflows.
const DESC_COLS = new Set(['why', 'loc', 'softgaps', 'hardstops']);
const _expanded = new Set(); // "rowId:colId" — session-only, survives re-filter
function _ensureMore(wrap, key, label){
  let btn = wrap.querySelector('.desc-more');
  if (!btn) {
    btn = document.createElement('button');
    btn.className = 'desc-more';
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (_expanded.has(key)) _expanded.delete(key); else _expanded.add(key);
      clampDesc();
    });
    wrap.appendChild(btn);
  }
  btn.textContent = label;
}
function clampDesc(){
  document.querySelectorAll('#tb tr').forEach(tr => {
    const kids = [...tr.children];
    const descCells = kids.filter(td => DESC_COLS.has(td.getAttribute('data-col')));
    if (!descCells.length) return;
    // Table cells all stretch to the row height, so measure each sibling's inner
    // .cellbox (shrink-wrapped to its content) instead of the <td>.
    let sib = 0;
    kids.forEach(td => {
      const cd = td.getAttribute('data-col');
      if (!cd || DESC_COLS.has(cd) || td.classList.contains('hidden')) return;
      const box = td.querySelector('.cellbox');
      if (box) sib = Math.max(sib, box.offsetHeight);
    });
    descCells.forEach(td => {
      if (td.classList.contains('hidden')) return;
      const wrap = td.querySelector('.desc-clamp');
      if (!wrap) return;
      const key = tr.dataset.id + ':' + td.getAttribute('data-col');
      const cs = getComputedStyle(wrap);
      const lh = parseFloat(cs.lineHeight) || (curFs * 1.5);
      wrap.classList.remove('clamped', 'expanded');
      wrap.style.maxHeight = '';
      if (_expanded.has(key)) {
        wrap.classList.add('expanded');
        _ensureMore(wrap, key, 'less');
        return;
      }
      const cap = Math.min(Math.max(sib - 2, lh * 3), lh * 10);
      if (wrap.scrollHeight > cap + 2) {
        wrap.classList.add('clamped');
        wrap.style.maxHeight = Math.round(cap) + 'px';
        _ensureMore(wrap, key, 'more');
      } else {
        const b = wrap.querySelector('.desc-more'); if (b) b.remove();
      }
    });
  });
}

let _fitT = null;
// Reading geometry (clientWidth / offsetHeight) right after writing styles forces
// a synchronous reflow, so autoFit → clampDesc runs correctly without waiting on
// requestAnimationFrame (which a backgrounded tab throttles or pauses).
function scheduleFit(){ clearTimeout(_fitT); _fitT = setTimeout(layout, 120); }
function layout(){ autoFit(); clampDesc(); }

function buildColgroup(){
  const cg = document.getElementById('cg');
  if (!cg) return;
  cg.innerHTML = visCols().map(c => '<col data-col="' + c.id + '">').join('') + '<col data-col="__act">';
}
function wireResize(){
  document.querySelectorAll('.col-resize').forEach(h => {
    h.addEventListener('click', e => e.stopPropagation());
    h.addEventListener('dblclick', e => { e.stopPropagation(); delete colW[h.dataset.rz]; saveColW(); layout(); });
    h.addEventListener('pointerdown', e => {
      e.preventDefault(); e.stopPropagation();
      const id = h.dataset.rz;
      const vis = visCols();
      const idx = vis.findIndex(c => c.id === id);
      const cg = document.getElementById('cg');
      const col = cg && cg.children[idx];
      const th = document.querySelectorAll('#thead-row th')[idx];
      if (!col || !th) return;
      const startX = e.clientX;
      const startW = th.getBoundingClientRect().width;
      const cmin = (COLMAP[id] || {}).min || 44;
      h.classList.add('dragging');
      document.body.classList.add('col-resizing');
      try { h.setPointerCapture(e.pointerId); } catch {}
      const mv = ev => { col.style.width = Math.round(Math.max(cmin, startW + (ev.clientX - startX))) + 'px'; };
      const up = ev => {
        h.removeEventListener('pointermove', mv);
        h.removeEventListener('pointerup', up);
        h.removeEventListener('pointercancel', up);
        h.classList.remove('dragging');
        document.body.classList.remove('col-resizing');
        colW[id] = { px: Math.round(Math.max(cmin, startW + (ev.clientX - startX))), manual: true };
        saveColW();
        layout();
      };
      h.addEventListener('pointermove', mv);
      h.addEventListener('pointerup', up);
      h.addEventListener('pointercancel', up);
    });
  });
}

// ── tabs (persisted) ────────────────────────────────────────────────
let curTab = localStorage.getItem('roles.tab.v1') || 'new';
if (!TAB_ORDER.includes(curTab)) curTab = 'new';
function setTab(t){
  curTab = t;
  try { localStorage.setItem('roles.tab.v1', t); } catch {}
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  go();
}

let curTier='all', filt={isNew:false,remote:false};
let sortKey='pct', sortAsc=false;

function buildHeader(){
  const row = document.getElementById('thead-row');
  const cells = orderedCols().map(c => '<th data-col="'+c.id+'" onclick="maybeSort(\\''+c.id+'\\')">'
    + '<span class="th-label">'+esc(c.label)+' <span class="si" id="si-'+c.id+'">↕</span></span>'
    + '<span class="col-resize" data-rz="'+c.id+'"></span></th>');
  cells.push('<th data-nosort><span class="th-label">Actions</span></th>');
  row.innerHTML = cells.join('');
  buildColgroup();
  wireResize();
  wireHeaderDnD();
}

// ── header drag-to-reorder ─────────────────────────────────────────
let _dragCol = null, _dragJustHappened = false;
function maybeSort(k){ if (_dragJustHappened) { _dragJustHappened = false; return; } sort(k); }
function wireHeaderDnD(){
  document.querySelectorAll('#thead-row th[data-col]').forEach(th => {
    th.setAttribute('draggable', 'true');
    const clearMarks = () => document.querySelectorAll('#thead-row th').forEach(x =>
      x.classList.remove('col-drop-before', 'col-drop-after', 'col-dragging'));
    th.addEventListener('dragstart', e => {
      if (e.target.closest('.col-resize')) { e.preventDefault(); return; }
      _dragCol = th.dataset.col;
      try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', _dragCol); } catch {}
      th.classList.add('col-dragging');
      document.body.classList.add('col-dragging');
    });
    th.addEventListener('dragend', () => { _dragCol = null; document.body.classList.remove('col-dragging'); clearMarks(); });
    th.addEventListener('dragover', e => {
      if (!_dragCol || th.dataset.col === _dragCol) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'move'; } catch {}
      const r = th.getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      th.classList.toggle('col-drop-after', after);
      th.classList.toggle('col-drop-before', !after);
    });
    th.addEventListener('dragleave', () => th.classList.remove('col-drop-before', 'col-drop-after'));
    th.addEventListener('drop', e => {
      e.preventDefault();
      const from = _dragCol, to = th.dataset.col;
      const r = th.getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      clearMarks();
      _dragCol = null;
      document.body.classList.remove('col-dragging');
      if (from && to && from !== to) { _dragJustHappened = true; moveCol(from, to, after); }
    });
  });
}

function cellFor(key, r, t){
  switch(key){
    case 'co': {
      const nb = r.isNew ? '<span class="badge b-new">New</span>' : '';
      return '<div class="co-name">'+esc(r.co)+nb+'</div>';
    }
    case 'team': return esc(r.team||'—');
    case 'role': return '<div class="role">'+esc(r.role)+'</div>';
    case 'why': return r.why ? descCell(r.why) : '—';
    case 'loc': return r.loc ? '<div class="desc-clamp" data-desc><div class="loc">'+esc(r.loc)+'</div></div>' : '—';
    case 'remote': return r.remote ? '<span class="remote-tag">Remote OK</span>' : '—';
    case 'sal': return '<div class="sal">'+esc(r.sal||'—')+'</div>';
    case 'pct': return r.pct==null ? '—' : '<div class="match-pct">'+r.pct+'%</div><div class="bar-track"><div class="bar-fill" style="width:'+r.pct+'%"></div></div>';
    case 'score': return esc(r.score||'—');
    case 'legitimacy': return esc(r.legitimacy_tier||'—');
    case 'workauth': return esc(r.work_auth||'—');
    case 'risk': return esc(r.risk_level||'—');
    case 'source': return '<span class="mono-cell">'+esc(r.source||'—')+'</span>';
    case 'posted': return '<span class="mono-cell">'+esc(r.posted_at||'—')+'</span>';
    case 'seen': return '<span class="mono-cell">'+(r.age==null?'—':(r.age===0?'today':r.age+'d ago'))+'</span>';
    case 'softgaps': return descListCell(r.soft_gaps);
    case 'hardstops': return descListCell(r.hard_stops, true);
    case 'report': {
      if (!r.reportFile) return '—';
      const rn = String(r.reportFile).split('-')[0] || 'view';
      const href = (IS_LIVE ? '/reports/' : 'career-ops/reports/') + r.reportFile;
      return '<a class="apply-link" href="'+esc(href)+'" target="_blank" rel="noopener">#'+esc(rn)+' ↗</a>';
    }
    case 'pdf': return esc(r.pdf||'—');
    case 'apply': return r.url ? '<a class="apply-link" href="'+esc(r.url)+'" target="_blank" rel="noopener">Open ↗</a>' : '<span class="direct-tag">Outreach</span>';
    default: return '—';
  }
}
function listCell(list, neg){
  if (!list || !list.length) return '—';
  return '<div class="tag-list">'+list.map(x => '<div'+(neg?' class="neg"':'')+'>· '+esc(x)+'</div>').join('')+'</div>';
}
// listCell wrapped for height-clamping (see DESC_COLS / clampDesc).
function descListCell(list, neg){
  const inner = listCell(list, neg);
  return inner === '—' ? '—' : '<div class="desc-clamp" data-desc>'+inner+'</div>';
}
function descCell(text){ return '<div class="desc-clamp" data-desc><div class="desc-txt">'+esc(text)+'</div></div>'; }

const TAB_MOVE_TARGETS = ['evaluated','submitted','pending','offered','rejected','archived'];
function actionsCell(r){
  if (!IS_LIVE) return '<span class="readonly-note">run npm run serve:roles</span>';
  return '<button class="actions-btn" onclick="openActionsMenu(event,\\''+r.id+'\\',\\''+r.tab+'\\')">Actions ▾</button>';
}

// A single reusable fixed-position menu (see #actions-menu in the body) shared
// by every row — an absolutely-positioned per-row menu nested inside
// .table-outer's overflow-x:auto container gets clipped on the y axis too
// (overflow-x:auto implicitly computes overflow-y:auto), so it never escapes
// the scroll box. position:fixed + coordinates from the clicked button does.
function openActionsMenu(evt, id, fromTab){
  evt.stopPropagation();
  const menu = document.getElementById('actions-menu');
  const moves = TAB_MOVE_TARGETS.filter(t => t !== fromTab)
    .map(t => '<button onclick="doMove(\\''+id+'\\',\\''+t+'\\')">Move to '+esc(TAB_LABELS[t])+'</button>').join('');
  menu.innerHTML = moves
    + '<div class="menu-sep"></div>'
    + '<button onclick="doDelete(\\''+id+'\\',\\'temporary\\')">Temporary delete</button>'
    + '<button class="danger" onclick="doDelete(\\''+id+'\\',\\'permanent\\')">Permanent delete</button>'
    + '<button class="danger" onclick="doBlacklist(\\''+id+'\\')">Blacklist company</button>';
  const r = evt.currentTarget.getBoundingClientRect();
  menu.classList.remove('hidden');
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = Math.min(r.right - mw, window.innerWidth - mw - 8);
  let top = r.bottom + 4;
  if (top + mh > window.innerHeight) top = r.top - mh - 4;
  menu.style.left = Math.max(8, left) + 'px';
  menu.style.top = Math.max(8, top) + 'px';
}
function closeActionsMenu(){ document.getElementById('actions-menu').classList.add('hidden'); }
document.addEventListener('click', closeActionsMenu);
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeActionsMenu(); hideTip(); } });

// ── column help tooltip ─────────────────────────────────────────────
function hideTip(){ const t = document.getElementById('coltip'); if (t) t.classList.add('hidden'); }
function showTip(id, x, y){
  const doc = COL_DOC[id];
  const tip = document.getElementById('coltip');
  if (!doc || !tip) { hideTip(); return; }
  const label = (COLMAP[id] || {}).label || id;
  tip.innerHTML = '<div class="ct-t">' + esc(label) + '</div>'
    + '<div class="ct-r"><b>存什么：</b>' + esc(doc.what) + '</div>'
    + '<div class="ct-r"><b>来源：</b>' + esc(doc.src) + '</div>'
    + (doc.why ? '<div class="ct-r"><b>意义：</b>' + esc(doc.why) + '</div>' : '');
  tip.classList.remove('hidden');
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let L = x + 16, T = y + 18;
  if (L + w > window.innerWidth - 8) L = x - w - 16;
  if (T + h > window.innerHeight - 8) T = y - h - 18;
  tip.style.left = Math.max(8, L) + 'px';
  tip.style.top = Math.max(8, T) + 'px';
}
function _tipFromEvent(e){
  const el = e.target.closest && e.target.closest('thead th[data-col], .col-tag[data-col]');
  if (el) showTip(el.getAttribute('data-col'), e.clientX, e.clientY);
  else hideTip();
}
document.addEventListener('mousemove', _tipFromEvent);
document.addEventListener('mouseover', _tipFromEvent);
document.addEventListener('mouseout', e => {
  if (e.target.closest && e.target.closest('thead th[data-col], .col-tag[data-col]')
      && !(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('thead th[data-col], .col-tag[data-col]'))) hideTip();
});
window.addEventListener('blur', hideTip);
document.addEventListener('scroll', hideTip, true);

function render(rows){
  _rows = rows;
  const tb=document.getElementById('tb'), em=document.getElementById('empty');
  if(!rows.length){ tb.innerHTML=''; em.classList.remove('hidden'); }
  else{
    em.classList.add('hidden');
    tb.innerHTML=rows.map(r=>{
      const t=tier(r.pct);
      const stale = r.status==='Rejected' || r.status==='Discarded';
      const cells = orderedCols().map(c => '<td data-col="'+c.id+'"'+(IS_LIVE && EDITABLE_COLS.has(c.id) ? ' class="editable" title="Click to edit"' : '')+'><div class="cellbox">'+cellFor(c.id, r, t)+'</div></td>').join('');
      return '<tr class="t-'+t+(stale?' is-stale':'')+'" data-id="'+esc(r.id)+'">'+cells+'<td class="actions-cell-wrap"><div class="cellbox">'+actionsCell(r)+'</div></td></tr>';
    }).join('');
  }
  document.getElementById('rc').textContent=rows.length+' of '+D.filter(r=>r.tab===curTab).length;
  applyColVisibility();
  layout();
}

function go(){
  const q=(document.getElementById('q').value||'').toLowerCase();
  let rows=D.filter(r=>{
    if (r.tab !== curTab) return false;
    if(curTier!=='all'&&tier(r.pct)!==curTier) return false;
    for(const k of Object.keys(filt)) if(filt[k]&&!r[k]) return false;
    if(q&&![r.co,r.role,r.team,r.why].some(s=>String(s||'').toLowerCase().includes(q))) return false;
    return true;
  });
  rows=[...rows].sort((a,b)=>{
    let av=a[sortKey],bv=b[sortKey];
    if(av==null) av=sortAsc?Infinity:-Infinity;
    if(bv==null) bv=sortAsc?Infinity:-Infinity;
    if(av<bv) return sortAsc?-1:1;
    if(av>bv) return sortAsc?1:-1;
    return 0;
  });
  render(rows);
}

function setTier(btn){
  curTier=btn.dataset.t;
  document.querySelectorAll('#tier-btns .chip').forEach(b=>b.classList.remove('on'));
  btn.classList.add('on'); go();
}
const togIds={isNew:'b-new',remote:'b-remote'};
function tog(k){ filt[k]=!filt[k]; document.getElementById(togIds[k]).classList.toggle('on',filt[k]); go(); }

function sort(k){
  if(sortKey===k) sortAsc=!sortAsc; else { sortKey=k; sortAsc=false; }
  document.querySelectorAll('thead th .si').forEach(el=>{ el.textContent = el.id==='si-'+k ? (sortAsc?'↑':'↓') : '↕'; });
  document.querySelectorAll('thead th').forEach(th=>th.classList.toggle('sorted', th.dataset.col===k));
  go();
}
function cycleTheme(){
  const r=document.documentElement, c=r.getAttribute('data-theme');
  if(!c) r.setAttribute('data-theme','light');
  else if(c==='light') r.setAttribute('data-theme','dark');
  else r.removeAttribute('data-theme');
}

// ── live actions (only wired when served over http) ──────────────────
function toast(msg, isErr){
  const t=document.createElement('div');
  t.className='toast'+(isErr?' err':'');
  t.textContent=msg;
  document.body.appendChild(t);
  setTimeout(()=>t.remove(), 3500);
}
async function refreshData(){
  try {
    const res = await fetch('/api/data');
    if (!res.ok) throw new Error('refresh failed: '+res.status);
    const fresh = await res.json();
    D.length = 0; D.push(...fresh.rows);
    for (const t of TAB_ORDER) document.getElementById('tc-'+t).textContent = D.filter(r=>r.tab===t).length;
    go();
  } catch(e) { toast('Refresh failed: '+e.message, true); }
}
async function callApi(path, body){
  const res = await fetch(path, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  const json = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(json.error || ('request failed: '+res.status));
  return json;
}
async function doMove(id, toTab){
  try { await callApi('/api/move', {id, to: toTab}); toast('Moved to '+TAB_LABELS[toTab]); await refreshData(); }
  catch(e){ toast(e.message, true); }
}
async function doDelete(id, mode){
  const msg = mode==='permanent'
    ? 'Permanently delete this role? The scanner will never re-add its URL.'
    : 'Temporarily delete this role? The scanner may re-add it after 30 days.';
  if (!confirm(msg)) return;
  try { await callApi('/api/delete', {id, mode}); toast(mode+' delete done'); await refreshData(); }
  catch(e){ toast(e.message, true); }
}
async function doBlacklist(id){
  const reason = prompt('Reason for blacklisting this company? (skips every future posting from them)');
  if (reason == null) return;
  try { await callApi('/api/blacklist', {id, reason}); toast('Company blacklisted'); await refreshData(); }
  catch(e){ toast(e.message, true); }
}

// ── click-to-edit cells (live server only) ─────────────────────────
// Company / Team / Role / Why it fits / Location / Remote / Salary. The write
// target depends on the row (tracker column, evaluation report YAML, scan
// history, or the pipeline.md line) — resolved server-side in roles-actions.mjs.
const EDITABLE_COLS = new Set(['co','team','role','why','loc','remote','sal']);
const EDIT_FIELD_LABEL = { co:'Company', team:'Team', role:'Role', why:'Why it fits', loc:'Location', remote:'Remote', sal:'Salary' };
let _editing = null;
function curValFor(col, r){
  const v = ({ co:r.co, team:r.team, role:r.role, why:r.why, loc:r.loc, sal:r.sal })[col];
  return (v == null || v === '—') ? '' : String(v);
}
function beginEdit(td){
  if (!IS_LIVE || _editing) return;
  const col = td.dataset.col;
  if (!EDITABLE_COLS.has(col)) return;
  const tr = td.closest('tr'); if (!tr) return;
  const r = D.find(x => x.id === tr.dataset.id); if (!r) return;
  const box = td.querySelector('.cellbox'); if (!box) return;
  const orig = box.innerHTML;
  const cur = curValFor(col, r);
  let field;
  if (col === 'remote') {
    field = document.createElement('select');
    field.innerHTML = '<option value="yes">Remote OK</option><option value="no">Not remote</option>';
    field.value = r.remote ? 'yes' : 'no';
  } else {
    field = document.createElement(col === 'why' ? 'textarea' : 'input');
    if (field.tagName === 'INPUT') field.type = 'text';
    field.value = cur;
  }
  field.className = 'cell-edit';
  _editing = { box, orig, col, id: r.id };
  box.innerHTML = '';
  box.appendChild(field);
  field.focus();
  if (field.select) field.select();
  let done = false;
  const finish = () => { done = true; _editing = null; };
  const cancel = () => { if (done) return; finish(); box.innerHTML = orig; };
  const commit = async () => {
    if (done) return;
    const val = field.value;
    const unchanged = col === 'remote' ? ((val === 'yes') === !!r.remote) : (val.trim() === cur.trim());
    if (unchanged) { cancel(); return; }
    finish();
    box.innerHTML = '<span class="cell-saving">saving…</span>';
    try {
      await callApi('/api/edit', { id: r.id, field: col, value: val });
      toast(EDIT_FIELD_LABEL[col] + ' updated');
      await refreshData();
    } catch (e) {
      toast(e.message, true);
      box.innerHTML = orig;
    }
  };
  field.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    else if (e.key === 'Enter' && !(col === 'why' && e.shiftKey)) { e.preventDefault(); field.blur(); }
  });
  field.addEventListener('blur', commit);
}
document.addEventListener('click', e => {
  if (!IS_LIVE) return;
  if (e.target.closest('a, button, .desc-more, .cell-edit')) return;
  const td = e.target.closest('#tb td[data-col]');
  if (td) beginEdit(td);
});

buildHeader();
applyColVisibility();
document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('on', b.dataset.tab === curTab));
document.getElementById('mode-note').textContent = IS_LIVE ? 'Live — row actions + click-to-edit write to disk · drag headers to reorder' : 'Static file — run npm run serve:roles for row actions & cell editing · drag headers to reorder';
go();
window.addEventListener('resize', scheduleFit);
// ResizeObserver catches width changes window.resize can miss (devtools dock,
// zoom, responsive-mode). .table-outer's own width only tracks the viewport
// (its content scrolls), so re-fitting on it can't feed back into a loop.
if (window.ResizeObserver) {
  let _rw = document.querySelector('.table-outer').clientWidth;
  new ResizeObserver(() => {
    const w = document.querySelector('.table-outer').clientWidth;
    if (Math.abs(w - _rw) >= 1) { _rw = w; scheduleFit(); }
  }).observe(document.querySelector('.table-outer'));
}
if (document.fonts && document.fonts.ready) document.fonts.ready.then(layout);
</script>
</body>
</html>
`;

writeFileSync(OUT, html, 'utf-8');
console.log(`render-roles-html: ${data.length} roles → ${OUT}`);
console.log(`  ${stats.hot} at 90%+ · ${stats.fresh} new today · tabs: ${TAB_ORDER.map((t) => `${t}=${tabCounts[t]}`).join(' ')}`);
