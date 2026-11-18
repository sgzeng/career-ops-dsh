# job scan

**阶段 1** 在 Mac 上零 token 跑发现。波（wave）按顺序执行；只有打不同 host 或不联网的步骤才在同一波里并发（wave 0、2、5）。
```
阶段 1 直接运行 career-ops/ops/daily-scan.sh · 零 token
 wave 0  validate-portals ‖ check-config-regression  配置预检（只 WARN，不拦）
 wave 1  串行（它们打同一批 ATS host，不能同时）：
         scan.mjs --since 14                          watchlist（portals.yml → tracked_companies）
       → verify-portals.mjs                           复查所有 ATS slug（防静默 404）
       → audit-portals.mjs（1–3 分钟）
       → discover-ats.mjs --in data/seeds/*.yml --write   名单（Black Hat 赞助商 / AIxCC 队伍）→ portals.yml
 wave 2  scan-ats-full.mjs --ats greenhouse ‖ ashby ‖ lever ‖ workable   反向发现：整个公开 ATS 目录
                                                    （四个目录并发，每个 10 分钟上限，各用独立 checkpoint；
                                                     workable 读官方一份全量 XML feed，约 40 秒）
 wave 3  scan-ats-full.mjs --seeds yc,a16z --since 10   反向发现：YC / a16z portfolio（突发请求，单独放一波）
 wave 4  ops/stage1-liveness.mjs                      Pending 非 LinkedIn 行查 liveness：失效 → Processed，
                                                    有效 → note 加 `liveness active <日期>`
 wave 5  健康摘要（只读，每次都跑）：detect-reposts、stats、filter-audit、close-stale（dry run）、reeval-candidates
        └─► data/pipeline.md + data/scan-history.tsv + data/logs/scan-<date>.log
```
并发写共享文件靠 `pipeline-lock.mjs`（pipeline.md / scan-history / scan-runs）、`dead-boards.mjs` 的锁内合并、每个目录独立的 checkpoint。
日志里每个步骤按固定顺序输出，另有 `[lane X finished in Ns]` 和 `wave N done`。`CAREER_OPS_PARALLEL=0` 退回串行。

阶段 1标题过滤：`portals.yml → title_filter`（`word:` = 全词，`stem:` = 词首）。`node filter-audit.mjs --summary` 看哪些关键词从没命中、哪些只和别的重复、哪些太吵。
**阶段 2** 读阶段 1 的产物，做 liveness、triage、打分、出报告。

规则全部在 `career-ops/modes/` 和 `config/`，这份文件只写流程和胶水。规则改动去改那里，不要在这里重复。

- **jd_cache**：每条新进 pipeline 的岗位都由阶段 1 读 JD、存到 `jds/stage1/`，备注写 `jd: local:…` 或 `jd: unread`。LinkedIn 每条间隔 2 秒，连续 3 次失败本次停抓。日志看 `JD cache:` 一行。
- **visa_filter**：公民身份 / 安全许可 / 不担保签证在阶段 1 就拦（包括 jd_cache 新读到的 JD），日志 `Filtered by visa:` 下逐条列出 JD 原句。改规则后跑 `node ops/check-config-regression.mjs`。
- **level_filter** 看 JD 不看标题：标题带 Staff / Principal / Distinguished **且** JD 硬性要求 8+ 年或 team lead 才丢。丢的每条都会在日志里列出 JD 原句。
- **content_rescue**：标题没命中但 JD 证据够的岗位保留（`note: content-rescue: …`）。
- **campus_track**：校招标题 + 技术岗词的岗位用 365 天窗口，跳过标题过滤（`note: campus: …`）。只对 tracked_companies 生效。
- **first_scan_backfill**：没在 `data/scan-backfill.tsv` 里的公司第一次扫用 120 天窗口。
- **LinkedIn 搜索**（通道 A，见 `linkedin_post.md`）：只回看 7 天，超过 8 天没跑会永久漏掉。
- **Apple**：`apple` provider，按 `apple.teams` / `apple.queries` 扫（零 token）。不限于 SEAR team：queries 覆盖 offensive security / exploit / fuzzing / vulnerability / red team / AI security 等，`title_net: apple_security` 补 "Security Software Engineer" 这类标题。校招通道 = `internships-STDNT-INTRN` team + "early career" query（Apple 没有独立的全职 new-grad team，校招岗是普通 req），`campus_track.company_nets.apple_campus` 限定标题。websearch 的 Apple campus 条目已关。
- **bigtech_security net**：NVIDIA / Intel / Adobe / Salesforce / Oracle / Cisco / IBM / Google / Netflix / Microsoft / Qualcomm / Amazon / GitHub / Meta 条目带 `title_net: bigtech_security`，补 "Security Software Engineer"、"Senior Researcher - Security" 这类全局 title_filter 漏掉的标题。
- **Microsoft / Qualcomm**：`eightfold` provider，按 `eightfold.queries` 做服务端搜索（整板翻页会 429）。查询词用具体的词，多词查询匹配很宽（"AI security" 返回 1790 条）。
- **GitHub Security Lab**：`jibeapply` provider（`api: https://www.github.careers/api/jobs`）。
- **HN Who's Hiring**：`portals.yml → job_boards`，每月一帖，覆盖没有 ATS 的小公司。
- **Zellic**：`notion` provider 读 Notion 招聘页。Notion 的发布时间是页面创建时间，所以老的常驻岗位会被年龄过滤掉，需要手动加到 `pipeline.md`。
- 去重：`scan.mjs` 和 `merge-tracker.mjs` 共用 `identity-key.mjs`（公司名别名 + 括号后缀折叠，见「5. 去重」）。


# 你自己维护的文件

| 文件 | 作用 |
|---|---|
| `career-ops/cv.md` | 简历，唯一事实来源。发论文 / 加项目更新这里 |
| `career-ops/config/profile.yml` | 目标岗位 / 签证 / 薪资 / archetypes |
| `career-ops/modes/_custom.md` | ★ 打分规则、硬性排除、流程规则、Tool hooks、怎么 pitch。觉得分数不对改这里 |
| `career-ops/modes/_brief.md` | triage 读的精简版。改 `_custom.md` 后同步一下 |
| `career-ops/modes/li-posts.md` | 通道 B 的采集规则（fork 专属，不会被上游覆盖） |
| `career-ops/portals.yml` | 公司 watchlist、搜索词、过滤器、LinkedIn 通道、Apple / Zellic 等 provider 配置 |
| `../linkedin_post.md` | 通道 A 说明、找 HM 的规则、Prompt 1 / Prompt 2 |

# 加公司 / 减 websearch 条目

`portals.yml` 里 `scan_method: websearch` 的公司每次阶段 2 都花 token。能换成零 token 的 provider 就换：

```bash
node verify-portals.mjs --add "Semgrep"                                   # 探单个公司的 slug 变体
grep -B3 'scan_method: websearch' portals.yml | grep 'name:' | sed 's/.*name: *//' \
  | sed 's/^/  - name: /' | (echo 'companies:'; cat) > /tmp/ws.yml
node discover-ats.mjs --in /tmp/ws.yml --summary                          # 预览
node discover-ats.mjs --in /tmp/ws.yml --write                            # 写回 portals.yml
```

- 不要手写没探过的 slug。猜错会永远静默 404（`semgrep`、`sentinelone`、`dreadnode` 都不是有效 slug）。
- Apple、Zellic 这类 provider 能直接识别的站，不用 slug，只要 `careers_url` 对。`verify-portals` 会把它们当成 provider 条目处理。
- 加一整个名单（会议赞助商 / VC portfolio）：仿照 `data/seeds/blackhat-us26-sponsors.yml` 建 `data/seeds/<名字>.yml`，每次扫描自动解析。
- 新加安全公司带上 `title_net: security`，写了不存在的 net 名 `validate-portals.mjs` 会报错。
- Comeet 公司：`api:` 要带 company uid + token（公开的，嵌在对方 careers 页 HTML / iframe 里）。
- Fallback to my chrome browser with my Gmail profile if Websearch does not work.

搜索词（阶段 2 WebSearch）：只改 `portals.yml → search_keyword_groups`（`core` / `ai` / `campus`）。新增 websearch 公司：给 `careers_url` 即可，缺省用 `core` 组；域名对不上时加 `search_site:`。`node validate-portals.mjs` 会校验组引用和 `site:` 前缀。

---

# 其它能直接用的功能

- `/career-ops {岗位URL}`：完整 A–H 评估 + 定制 CV PDF + 写进 tracker
- `/career-ops li-posts`：通道 B，Mac + Chrome，见 `linkedin_post.md`
- `/career-ops contacto`：找 hiring manager，LinkedIn 私信草稿（先查 `contact-lookup.mjs`）
- `/career-ops cover` / `interview-prep` / `tracker`
- `node precheck-duplicate.mjs --company … --title … --url …`：投递前查重
- `node closing-soon.mjs --summary`：Notes 里写了截止日期（`closes 2026-11-04`）的 Evaluated 行，临近截止的列出来
- `node reeval-candidates.mjs --summary`：改过 cv.md / _custom.md 之后，哪些老评估该重打
- `node close-stale.mjs --summary --days 60`：长期没回音的 Applied（默认 dry run，`--confirm` 才写）
- `node analyze-patterns.mjs --summary`：按 ATS 和岗位类型看面试率（样本小会提示）
- `node company-history.mjs --company "<c>" --summary`：一家公司的全部记录（tracker、follow-up、扫描历史）
- `node linkedin-join.mjs --company "<c>"`：LinkedIn 一度人脉在哪些目标公司（需要先导出 `data/Connections.csv`）
- `npm run serve:dashboard`：Go TUI 浏览 pipeline
- `node stats.mjs --summary` / `node weekly-digest.mjs --summary`：漏斗 / 周报

---

# 文件位置速查

| 用途 | 文件 |
|---|---|
| 阶段 1 脚本 | `career-ops/ops/daily-scan.sh` |
| launchd 定时 | `career-ops/ops/com.haochen.careerops.daily-scan.plist` |
| 扫描日志 | `career-ops/data/logs/scan-<date>.log` |
| 待处理 | `career-ops/data/pipeline.md` |
| tracker | `career-ops/data/applications.md` |
| 联系人 | `career-ops/data/contacts.tsv`（gitignored） |
| 通道 B 查询轮换记录 | `career-ops/data/li-post-queries.tsv` |
| 门户快照（audit-portals 的 baseline） | `career-ops/data/portal-audit.json` |
| 回信候选 | `career-ops/data/reply-candidates.json` |

---

# 阶段 2 执行手册（Claude agent：这个 scheduled task 就是让你跑这一段）

工作目录 `career-ops`。目标：把阶段 1 写进 `data/pipeline.md` 的新岗位走一遍
`modes/pipeline.md`，再补 WebSearch 覆盖不到的公司，最后重渲染 `../roles.html` 并在 chat 里给简报。

**效率规则**：条目数 > 2 时，JD 抓取、打分、写报告这类批量步骤用 `Workflow` 工具起 dynamic workflow
（`pipeline()` 处理有依赖的流程，`parallel()` 处理互相独立的公司搜索），只把结构化结果
（score、hard_stops、report 正文）带回主会话。主会话负责领号、写 `reports/`、写 tracker、跑 `merge-tracker.mjs`，
subagent 不碰这些文件。liveness 用 `check-liveness.mjs`（零 token 批量），不用套 workflow。

**硬规则**：不要在这个会话里跑 `npm run scan` / `node scan.mjs` / `node scan-ats-full.mjs`。

**JD 门禁**：`data/pipeline.md` 里的每一条 posting，都必须由 agent 实际读到 JD 正文之后才能做任何判定（硬性排除、triage、跳过、评估）。
- **禁止仅凭标题、雇主名、公司类型、地点或 pipeline 备注排除**。标题或雇主名只能用来决定抓取顺序，不能替代读 JD。
- 读取顺序：**先读备注里的 `jd: local:jds/stage1/<文件>`**（阶段 1 已存好原文，不要重抓；报告的 JD 原文段从这里复制）。只有 `jd: unread` 的才走 `fetch-jd.mjs` → `check-liveness.mjs` 对应的 API → Playwright → WebFetch。LinkedIn 按 AGENTS.md 的 LinkedIn JD loading guard；用户 Chrome 已登录时可用其登录态读取。
- JD 读完后，跳过理由必须引用 JD 原文里的句子（例如 "requires TS/SCI"、"8+ years"、"lead a team of"）。引用不到就不算排除。
- 读不到 JD 的（登录墙、骨架、404 之外的不确定）保持 `[!]` 并注明 `JD unavailable`，不得标记为跳过或失效。
- 每条 posting 的读取结果（读到 / 读不到 / 页面状态）写进 `data/discard.log` 或报告头 `**Verification:**`，便于事后核对。
这个沙箱 VM 的 egress 拒绝 ATS API 域名，会失败且看起来像配置坏了。发现是阶段 1 的活。

## 步骤

### 1. 载入规则

- `config/profile.yml`：签证 / 目标 / 薪资
- `cv.md`：事实来源。候选人的任何断言都必须能在这里找到
- `modes/_custom.md`：Scoring Rules、Hard blockers、Pipeline Rules、Tool hooks、How to pitch
- `modes/_brief.md`：triage 用的精简版
- `data/applications.md`：现有 tracker（跨天记忆）

### 2. 确认最近跑过的阶段 1

```bash
tail -30 data/logs/scan-$(date +%F).log                       # scan.mjs exit= 应为 0
awk -F'\t' -v d="$(date +%F)" '$2==d' data/scan-history.tsv   # 今天的新行
```

- 日志缺失或 exit 非 0：在简报里说「阶段 1 今天没跑（Mac 睡了？），这次只有 WebSearch 覆盖」。不要因此做全量 WebSearch 兜底。
- 检查 level 过滤丢掉的岗位，它们不会进 pipeline，只有这里能救回来：
  `grep -A30 "Filtered by level" data/logs/scan-$(date +%F).log`。
  原句如果其实不满足规则，按 `_custom.md` → Pipeline Rules 的 `level-rescue` 处理。
- 检查 LinkedIn / 反向发现是否限流或不完整：
  `grep -n "PARTIAL RESULT\|local parser failed\|⚠️ Seed\|STOPPED" data/logs/scan-$(date +%F).log`。
  有输出就在简报里说明，不做全量 WebSearch 兜底。
- 检查健康摘要（只读，有输出才需要看）：`grep -A12 "health digest" data/logs/scan-$(date +%F).log`。
  每次还有 filter-audit / reeval-candidates / audit-portals 的输出：filter-audit 的 NEVER MATCHED / REDUNDANT 列表，以及 audit-portals 相对上次快照的变化。

### 3. 跑 pipeline

对 `data/pipeline.md` 里 `## Pending` 段的 `- [ ]` 条目，执行 `/career-ops pipeline`。
按 `modes/pipeline.md` 走，规则以 `_custom.md` 为准：

1. **Liveness**：note 里有 `liveness active <今天>` 的行跳过（阶段 1 已查）。其余行跑 `check-liveness.mjs --file <tmp>`。LinkedIn 帖子链接（`linkedin.com/posts/…`）不做 liveness，报告头写 `post-sourced`（`_custom.md` → Pipeline Rules）。
2. **Hard blockers 先查**（`_custom.md` → Hard blockers），只能基于已读完的 JD 正文（见上面「JD 门禁」）。不合格的按 `modes/pipeline.md` 的 Discard log 格式记 `data/discard.log`，不打分，并引用 JD 原句。
3. **Triage**（`_brief.md`）。不合格同上，记 discard log。
4. **过了 triage 的做 A–G 全量评估**：`reserve-report-num.mjs` 领号，打分用 `_custom.md` → Scoring Rules，报告格式用 `_custom.md` → Report contents（含 JD 原文段）。
5. **写 tracker**：只走 `batch/tracker-additions/*.tsv` + `node merge-tracker.mjs`，不手改 `applications.md`。状态用 `templates/states.yml` 的规范值，新评估 = `Evaluated`。
6. 收尾：`node reconcile-pipeline.mjs`、`node verify-pipeline.mjs`（0 errors）、释放没用上的号。

### 4. 补 WebSearch，只补缺口

只跑 `portals.yml → search_queries` 里阶段 1 够不着的：`scan_method: websearch` 的公司，加上没有公共 ATS 的 company-native careers 页。查询串的构造规则在 `_custom.md` → WebSearch query construction（stage 2）。

- 今天已经从 `scan-history.tsv` 出现过的公司跳过。
- Google / DeepMind / YouTube 不再 WebSearch（阶段 1 直接读 Google 公开的 feed）。Microsoft、Qualcomm、GitHub 也已经移到阶段 1。
- GH / Ashby / Lever 的 `site:` 查询已关（`enabled: false`）：阶段 1 每周扫这三个整个公开目录。
- 不要 WebFetch 大 board 的 API（Anthropic、OpenAI、Zscaler 这类），WebFetch 会静默丢行。大 board 是阶段 1 的活。
- WebSearch 命中的 URL 必须先过 liveness（`node check-liveness.mjs <url>`），搜索索引会滞后几周。
- 多家公司要搜时用 `parallel()`，每家一个 subagent，只返回命中的 URL、标题、摘要。liveness 和写回 `pipeline.md` 仍在主会话做。

### 5. 去重

`scan.mjs` 和 `merge-tracker.mjs` 按 URL、requisition ID、公司 + 标题去重。手动加的岗位在写入前先用
`node precheck-duplicate.mjs --company "<c>" --title "<t>" --req "<id>" --url "<u>" --json` 查一遍。
公司名的括号后缀自动折叠。品牌和法人名不同的，在 `portals.yml → company_aliases` 加一行。

### 6. 删除submitted stale/closed 的job
已投递的job再次访问apply URL，liveness check确认该岗位是否还在招人。如果岗位已关闭或挂在那大于60则移到Rejected里。

### 7. 查看结果

访问 http://127.0.0.1:7777。Tab（列在页面里的顺序）→ `templates/states.yml` 的规范状态：

| Tab | 状态 | 说明 |
|---|---|---|
| New openings | （无 tracker 行） | 还在 `data/pipeline.md` 里、阶段 2 还没评估的抓取结果 |
| Evaluated openings | `Evaluated` | 已出报告、等你决定 |
| Submitted | `Applied` | 已投递 |
| Pending | `Responded` / `Interview` | 公司有回应或进入面试 |
| Offered | `Offer` / `Hired` | 拿到 offer / 已入职 |
| Rejected | `Rejected` | 被拒 |
| Archived | `Discarded` | 你自己判断不感兴趣 |
| Deleted | `SKIP` | 永久删除后的墓碑行 |

- **临时删除**：从 tracker 和 `pipeline.md` 去掉这一行，`scan-history.tsv` 里这条 URL 进入 30 天冷却（`cooldown:公司:日期`），冷却后可能被重新捡回来。
- **永久删除**：状态设成 `SKIP` 并保留（Deleted tab 可见，作为审计记录）。这个 URL 永久算「已见过」，扫描器不会再加回来。
- **拉黑公司**：写进 `data/blacklist.md`，之后的扫描跳过这家公司的新岗位，但不撤回 tracker 里已有的行。

### 8. Chat 简报（简短）

- 今天新增几条、名字分别是什么？今天最值得动手的一条
- 阶段1 和 阶段2 进入tracker的job 分别贡献几条；阶段 1 有没有正常跑
- 已经submitteded的jobs有无 stale / closed？
- 写明丢弃的job posting统计个数以及各自原因（被blocker拒了哪些？让 filter 可见）
- 健康摘要有没有需要动手的（reposts、filter-audit / reeval / audit-portals）

---
