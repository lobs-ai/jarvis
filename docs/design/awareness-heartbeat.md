# Jarvis — awareness & the heartbeat: standing gaze and the second clock

> **Status:** Part 1 (workspace roster) **as-built** — `servers/terminal/src/index.ts` and
> `servers/browser/src/index.ts` edited 2026-07-03. Part 2 (the heartbeat) **as-built**
> 2026-07-04 per §2.6: `Session.heartbeat()` + the `"heartbeat"` turn source (session.ts),
> `heartbeat_min` config key (default 15, 0 disables), the timer in main(), the speaking
> circuit breaker (30-min cooldown; muted beats get the rate-limited prompt AND a say-swallow
> backstop that degrades to `noteForNextTurn`), heartbeat turns invisible to the idle clock
> (store.ts — §2.10 Q6), and a distinct chip + collapsed-by-default card in Activity (§2.10 Q5).
> Part 3 (the coworker loop) **as-built** 2026-07-04 — see §5 below: `servers/workspace`
> (lab-activity stream) + `servers/watch` (follow-through ledger), arrival beats off the HID
> idle clock, per-beat verdict notes in Activity, quiet hours, and the speak cooldown made a
> config key. Typecheck clean; **pending a `jarvisd` restart to take effect** (all parts).
> Owner: Rafe. This doc builds strictly on the shipped substrate (`docs/design/jarvis.md`
> M0–M4, `docs/design/jarvis-post-m4.md` Parts I & II) and the observability plan
> (`docs/design/observability.md`); it supersedes neither.
>
> **Live-code caveat:** every file:line citation below was read from source on 2026-07-03.
> jarvis source is under active edit — re-verify a cited symbol still exists before
> implementing against it.

---

## 0. North star

The Iron Man reading of Jarvis, stated as the target this feature serves: **always up to date
on what Rafe is doing, mostly silent, occasionally proactively helpful.** Today Jarvis only
sees the world when Rafe speaks — the utterance bundle is assembled *per turn* and thrown away
(`session.ts:815` `assembleBundle`, `context.ts` `UtteranceBundle` "attached to the current
turn only"). Between turns Jarvis is blind and asleep. Two capabilities close that gap, and
they are deliberately **separable knobs**:

1. **Awareness** — Jarvis's per-glance field of view widens from "the one thing Rafe is looking
   at" to "the whole workspace," and it acquires a *clock of its own* so it glances even when
   Rafe hasn't spoken.
2. **Interruption** — the separate, higher-bar decision to break silence and *say* something
   unprompted.

Build awareness first; add the speaking gate second. A Jarvis that is silently, perfectly
up to date is already useful (it answers the next real question with full context and no
catch-up round-trip) and carries none of the annoyance risk. Speaking unprompted is where the
"Jarvis" fantasy lives and where it most easily becomes a nuisance — so it is gated hard and
shipped only once silent awareness is proven.

This doc has two parts matching the two things actually being built:

- **Part 1 — the workspace roster** (as-built): the per-glance field of view, widened from one
  pane / one tab to the whole tmux + Chrome workspace, under a three-tier read model.
- **Part 2 — the heartbeat** (design): the second clock — a synthetic ~15-min turn injected into
  the same warm session so Jarvis stays aware between Rafe's utterances, silent by default.

---

## Part 1 — The workspace roster (as-built)

### 1.1 The three-tier read model

Jarvis's eyes now read the workspace at three escalating costs, so cheap awareness is always on
and expensive detail is fetched only when a question demands it:

| tier | what | cost | when |
|---|---|---|---|
| **ROSTER** | one line per tmux pane (all sessions) and per Chrome tab (all windows) | cheap — one `tmux` call, one AppleScript pass; no per-pane scrollback, no per-tab JS | **every turn**, rides the bundle |
| **DEEP** | the *active* pane's scrollback tail + the *active* tab's selection & visible text | moderate — bounded to ~80 lines / 4000 chars | **every turn**, rides the bundle alongside the roster |
| **DRILL-DOWN** | full contents of *any other* pane or tab Jarvis names | on demand only | when a question needs a pane/tab that isn't the focused one |

The load-bearing decision: **DRILL-DOWN needs no new tool.** The brain already has a real shell
(Claude Code's `Bash`, unconfined — `docs/design/jarvis.md` §"Shell access") and the browser
AppleScript surface. When the roster shows a pane worth reading, the brain runs
`tmux capture-pane -t <session:window.pane> -p -S -80` itself; for another tab it runs a
per-tab AppleScript. So the roster's job is *only* to tell the brain what exists and how to
address it — the reach is already in its hands. This is why widening the eyes cost almost
nothing to build: no protocol change, no new MCP tool, no new bundle plumbing.

### 1.2 `terminal_context` — as-built (`servers/terminal/src/index.ts`)

`terminal_context` now returns **ROSTER then DEEP**:

- **Roster** (`tmuxRoster()`, `index.ts:23`): `tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index}  #{pane_current_path}  [#{pane_current_command}]#{?pane_active,  *ACTIVE,}'`
  — one line per pane across *every* session and window: address, cwd, running command, and an
  `*ACTIVE` flag on the focused pane. Capped at `ROSTER_CAP = 40` panes with a `… +N more panes`
  tail so a wall of panes can't blow the bundle budget.
- **Deep** (`tryTmux()`, `index.ts:46`): `tmux capture-pane -p -S -80` — the last `TAIL_LINES = 80`
  of the active pane (the pane `-t` defaults to). Prepended by the roster; labelled
  `[tmux] active pane, last 80 lines:`.
- **Fallbacks** unchanged: iTerm2 / Terminal.app AppleScript when tmux is absent. If nothing is
  readable but the roster exists, the roster alone is still returned — it's useful on its own.

`terminal_run` (the API-path shell) is unchanged.

### 1.3 `browser_context` — as-built (`servers/browser/src/index.ts`)

`browser_context` now returns the active tab's DEEP read **plus a ROSTER of every tab**:

- **Active tab (deep)**: url/title (`activeTabInfo()`, `index.ts:32`), current selection, and
  `document.body.innerText` truncated to `TEXT_LIMIT = 4000` — the latter two via
  `activeTabJs()` (`index.ts:41`), which executes JavaScript through Chrome's Apple-Events
  bridge. **This requires Chrome → View → Developer → "Allow JavaScript from Apple Events"**
  (now enabled). When it's off, the body reports the selection/url only plus a one-line hint to
  enable the toggle — it degrades, it doesn't fail.
- **Roster** (`chromeTabRoster()`, `index.ts:52`): an AppleScript loop over `every tab of every
  window`, emitting `[w<window#>] <title> — <url>` per tab. Title+url only — **no per-tab JS**,
  so the roster is cheap and needs no Apple-Events toggle. Capped at `TAB_CAP = 40` tabs, urls
  clipped to `URL_CAP = 100` chars, with a `… +N more tabs` tail.

The eyes/hands split is intact and unchanged: reads go through AppleScript against Rafe's *real*
Chrome (read-only, no debug port on the daily browser); the `browser_open`/`click`/`type` hands
still drive only the dedicated Jarvis-owned CDP profile on `:9222` (`docs/design/jarvis.md`
§Security model). DRILL-DOWN into another real tab is a read, so it rides the same read-only
AppleScript path the brain can invoke directly — no actuator ever attaches to Rafe's browser.

### 1.4 How the roster reaches the model (unchanged plumbing)

No new wiring. `McpManager.collectContext()` (`mcp/manager.ts:106`) auto-discovers any
`*_context` tool, fans them out in parallel with a `PER_SERVER_TIMEOUT_MS = 300`ms per-server
timeout, redacts secret shapes, and truncates each server's contribution to its share of
`BUNDLE_TOKEN_BUDGET = 2000` tokens (`context.ts:20`). `Session.assembleBundle()`
(`session.ts:815`) wraps the lot in `<untrusted-content>` delimiters and appends it to the
current turn only. The richer roster+deep bodies simply flow through the pipe that already
existed — which is exactly the "the extension point we already have" thesis of
`docs/design/observability.md`. The bundle cap is what keeps the widened eyes honest: a roster
of 200 panes still can't inflate time-to-first-token, because the per-server slice truncates
first.

---

## Part 2 — The heartbeat (design)

### 2.1 What it is

A **heartbeat** is a synthetic turn jarvisd injects into the **same warm Claude Code session**
every ~15 minutes. It carries the current world-state bundle (Part 1's roster + deep read). The
brain glances at it and, **by default, produces no speech** — it updates its own understanding
and stays silent. Speaking is a separate, higher-bar judgment call (§2.4).

The heartbeat is the "second clock" of `docs/design/observability.md` §Phase 4, but arriving far
earlier and far cheaper than that doc assumed — it needs no rolling on-disk journals, because the
warm session's own transcript *is* the journal (§2.3).

### 2.2 Why in-session, not a separate process

Because **continuity comes free.** The tier-1 brain is one persistent `claude` child that owns
the conversation history (`cli-brain.ts` §class docstring; `docs/design/jarvis-post-m4.md`
§"History-of-record lives in the BrainPort"). Injecting the heartbeat as an ordinary turn into
*that* session means:

- Every heartbeat glance accumulates into the same context the next real question will see. When
  Rafe finally asks "why did that build go red?", Jarvis has been watching it go red for the
  last three heartbeats — no catch-up, no re-read.
- There is **no external activity log to build or reconcile.** A separate watcher process would
  need its own memory of "what I saw last time" to notice *changes*; the in-session heartbeat
  gets that for free — the transcript is the memory. This is the single biggest simplification
  and the reason the feature is small.

The cost of in-session is context growth (§2.7) — handled by leaning on Claude Code's own
compaction, decision (d).

### 2.3 The structural precedent already in the tree

jarvisd already injects a timer-driven synthetic turn that stays silent unless something is
worth surfacing: the **stage-fault loop** (`session.ts:476-533`). It is worth reading as the
template, because the heartbeat is nearly the same machine:

- A `setTimeout`/debounce fires `fireFaultTurn()` (`session.ts:507`).
- It **defers while a turn is active** (`if (this.active) { this.scheduleFaultTurn(); return; }`,
  `session.ts:509`) — never barging into a live performance.
- It runs `startTurn("system", …)` with a bracketed, clearly-not-from-Rafe preamble
  (`[stage fault report — automated, not from Rafe] …`, `session.ts:528`).
- It has a **circuit breaker**: at most one corrective turn per `CORRECTIVE_COOLDOWN_MS = 60_000`
  (`session.ts:63,521`), and it only fires to a live audience (`this.sink.hasAudience()`).
- When it can't/shouldn't fire, it **degrades to a next-turn note** via `noteForNextTurn()`
  (`session.ts:522`) rather than forcing speech.

The heartbeat reuses every one of these ideas. The two real differences: it is periodic rather
than event-triggered, and it *wants* the world-state bundle (a stage-fault turn deliberately
omits it — `session.ts:700` — because it's about the stage, not the world).

### 2.4 Awareness and interruption are decoupled knobs

**Awareness (knob 1) is nearly free on the say-tool contract.** On the CLI path the model is
silent by default and speaks *only* by calling the `say` tool; plain text it emits is private
workspace and is **never spoken** — the earlier speak-the-scratch fallback was explicitly removed
(`cli-brain.ts:152-155`: a turn with no `say` and non-empty scratch is *logged*, not voiced). So
a heartbeat turn where the model simply reads, thinks, and declines to call `say` produces
**zero audio by construction.** Silent awareness requires no new muting mechanism — it is the
default behavior of a turn that chooses not to speak.

**Interruption (knob 2) is prompt-driven judgment, not a mechanical gate.** The model deciding to
speak or stay silent is a strong engineer, and the right mental model is **a good second engineer
glancing over your shoulder** — one who knows the difference between a remark worth making and a
thought better kept to himself, and who mostly stays quiet. The design deliberately does *not*
enumerate a speak/don't-speak rules table; it invests in the **prompt** that shapes that judgment
(treated as the project's key artifact in §2.6c). jarvisd keeps exactly one crude, non-judgment
backstop — a circuit breaker (§2.6e) so a misfiring model can't *spam* — and leaves the actual
call to the model's read of the moment.

**What the proactive value actually is — substantive engineering awareness, not focus-policing.**
The payoff is that Jarvis can *read what an agent is doing and hold a real opinion about it.* The
roster (Part 1) shows a `claude` (or any agent) running in a pane; a DEEP/DRILL-DOWN read shows
what that agent is actually outputting; and the shell lets Jarvis go check the code the agent just
wrote. From that vantage a good second engineer can:

- **Summarize an agent's progress** — "here's where the victors migration is at: schema's moved,
  the backfill's running, tests aren't touched yet." A glanceable status on work Rafe launched and
  walked away from.
- **Flag a wrong path early** — "that agent's reaching for a global mutex; it'll deadlock the
  worker pool — worth stopping it before it writes more against that shape." Catching a bad
  direction at beat two instead of at the end is the highest-leverage thing a reviewer does.
- **Suggest an approach** — when an agent (or Rafe) is circling a problem, offer the angle it's
  missing.
- **Be a live second opinion on in-flight work** — a read *while* the work is happening, which is
  exactly what a pair or reviewer provides and what a solo agent loop lacks.

And a good second engineer doesn't only *talk* — on your say-so, he acts: stops the agent, clears
the wedged lockfile, spins the helper. That step — forming a suggestion with a concrete action
attached, holding it, and firing it only on Rafe's approval — is the **suggest → hold →
act-on-approval loop** (§2.5).

**Objectives (optional).** Rafe can hand Jarvis an **objective** and point it at an agent or pane
— "watch this migration against the design doc," "tell me if that refactor drifts." Jarvis then
monitors that target across successive heartbeats (continuity is free — decision (b)), re-reads
the code as it changes, and reports how it's going against the objective. This is the substantive,
engineering form of "monitor against a goal" — about *the work*, not about Rafe's attention. See
§2.6f for the state it needs.

**Accountability nudges are one minor, optional flavor — not the core.** The lightweight "you
meant to ship X and you've drifted" nudge is still available *when Rafe has given a goal that
invites it*, but it is deliberately demoted from a central mechanic to a small option: the
proactive value lives in the engineering awareness above, not in policing focus. The one sane
norm if it's used at all — tie it to something Rafe actually said he was doing, never to Jarvis's
own opinion of what's "productive" — is guidance inside the judgment prompt, not a hard rule the
system enforces.

### 2.5 The suggest → hold → act-on-approval loop

A second engineer who only ever *talks* is half a colleague. The value compounds when Jarvis can
also **act on what it noticed** — but acting unprompted on an autonomous agent's work is exactly
the high-consequence, injection-exposed move the rest of the design is careful about (§2.9). The
resolution is a three-step loop that keeps a human in the decision without making Jarvis ask
permission every beat:

1. **SUGGEST.** A heartbeat forms an opinion about an agent/pane (§2.4) and, instead of merely
   voicing it, attaches a **concrete action** — "that agent's about to migrate with no backfill; I
   can tell it to add one," "the build's wedged on a stale lockfile; I can clear it and re-run,"
   "this refactor's stuck — I can spin a subagent to map the call sites." The suggestion is a
   *proposed action*, not just a remark.
2. **HOLD.** By default the action does not fire. The suggestion becomes **pending**: Jarvis holds
   it and stays silent, or — if the moment clears the speaking bar (§2.4) — flags it once ("heads
   up, I'd stop that agent; say the word"). Then it waits.
3. **ACT ON APPROVAL.** When Rafe next checks in — or reacts to a flag — his approval ("yeah, do
   it") is the turn that **fires the held action**. No approval, or a "nah," and it's dropped. The
   approval is an ordinary conversational yes in the warm session, *not* a `ConfirmBroker`
   mutate-dialog (that gate is the API path's; here the authorizing turn is Rafe's own words).

**The pending-suggestion queue is free — the in-session dividend again (decision (b)).** Because
every heartbeat is a turn in the *same warm session*, a suggestion Jarvis formed at 2:05 is still
right there in the transcript at 2:25 when Rafe looks up. There is **no pending-suggestion store to
build**: the transcript *is* the queue. Jarvis still knows twenty minutes later what it flagged,
why, and the exact action it proposed, and can execute on approval — it never forgot, it just held.

**What "act" can actually do (against the current codebase + security model):**

- **Steer another Claude Code pane — AVAILABLE, no new tooling.** The brain has a built-in `Bash`
  tool (`CLI_ALLOWED`, `main.ts:34`) and tmux is already present (the roster uses it), so Jarvis
  types into *any* pane with `tmux send-keys -t <session:window.pane> "…" Enter`. This is the
  headline capability — steering the agents Rafe already runs. **It is also the sharpest edge:**
  typing into an autonomous agent is powerful and can shove it *down* a wrong path as easily as off
  one, so it must be approval-gated (the HOLD step is exactly that). Whether it warrants a harder
  gate than a prompt norm is an open question (§2.10).
- **Spin a subagent / run a command — AVAILABLE.** Via the same shell, or the tasks MCP server's
  `subagent_start` (`CLI_ALLOWED`, `main.ts:49`). Approved background research or a mechanical fix
  lands here.
- **Act in Jarvis's OWN dedicated Chrome profile — AVAILABLE.** `browser_open` (navigate) is
  already granted; `browser_click`/`browser_type` drive the dedicated Jarvis-owned CDP profile on
  `:9222` (`servers/browser/src/index.ts`). *Caveat:* those two currently sit in `CLI_DISALLOWED`
  (`main.ts:68`), so enabling them for the heartbeat brain is a small allow-list change — safe,
  because they touch only Jarvis's own profile; **not** a security-boundary relaxation.
- **Act in Rafe's REAL logged-in browser — DELIBERATELY BLOCKED.** The security model
  (`servers/browser/src/index.ts` header) splits **eyes** (read Rafe's real Chrome read-only via
  AppleScript) from **hands** (act only against the dedicated Jarvis profile via CDP), precisely so
  a poisoned or injected page can't drive Rafe's authenticated sessions. "Click Rafe's real
  browser" is not a missing feature to wire up — it would mean **intentionally relaxing that
  boundary**, and it is treated as an explicit decision with a real tradeoff (§2.10), never a
  default.

The through-line holds: Jarvis is a second engineer who **monitors, opines, and — on approval —
acts, primarily by steering the agents Rafe already runs.**

### 2.5a The acting rule: prepare, don't commit (2026-07-04, Rafe's direction)

Where §2.5 draws the line for acting on *another agent's* work, this is the general rule for what
a beat may do **on its own authority, before any approval.** Rafe's framing (2026-07-04): a
heartbeat should let Jarvis *get ready to help* — "acting is more just like analysis and getting
ready to help instead of actually doing work for yourself." So the earlier "strictly
read-and-maybe-speak" v1 (§2.9) is deliberately widened — but only along the reversible axis, not
the commit axis.

**The rule is: a beat may PREPARE freely; it may not COMMIT without Rafe.** Preparation is any
work that is reversible and stays inside Jarvis's own boundary — reading and analyzing the
workspace, anticipating the next thing Rafe will need, working up an answer or a plan, and
**staging** an artifact that Rafe still has to accept. Committing is anything irreversible or
outward-facing: it waits for the approval turn (§2.5), every time.

**PREPARE — a beat may do these unprompted:**

- **Read and analyze** the roster, the panes, the code an agent just wrote (§2.4) — the existing
  awareness payload.
- **Work up an answer or plan** to a question Rafe left open, so it's ready the moment he looks up
  — the warm transcript *is* the delivery (decision (b)); no store needed.
- **Stage a `wiki_propose_edit`** — a proposal is not a commit. It lands as a diff Rafe confirms;
  the human-in-the-loop gate is structural, so drafting one on a beat is preparation, not action.
- **Dispatch a read-only subagent** for background research/analysis whose *output* is a report,
  not a side effect — the analysis-not-work case Rafe named.

**COMMIT — a beat may not do these until an approval turn (§2.5) fires them:**

- `wiki_commit`, or any write with a side effect on the world.
- Steering another agent's pane (`tmux send-keys`), running a mutating/destructive command,
  installing, pushing, or anything the tier-1 "ask before destructive" norm already covers.
- Acting in Jarvis's own browser profile, and — always, by boundary — in Rafe's real browser
  (decision (i)).
- Dispatching a subagent whose task *takes* world-affecting action rather than just reporting.

**Why this line and not "read-only" or "fully autonomous."** Pure read-only wastes the beat — the
highest-leverage thing a second engineer does between glances is *have the thing ready* when you
turn around, and that needs drafting, not just watching. Full autonomy re-opens exactly the
injection-to-action path the rest of the design guards (§2.9): an unattended beat reading poisoned
panes must never be one step from a committing action. "Prepare, don't commit" takes the value
(readiness) without the exposure (unattended mutation). It leans on a property the stack already
has — the propose/confirm and suggest/hold gates make *staging* and *committing* genuinely
different operations, so "reversible" is a real, enforced distinction, not a vibe.

**Enforcement is a prompt norm first, honestly flagged.** Per-turn tool restriction isn't
available (grants are set at child spawn, `cli-brain.ts:79-85`), so like the `Bash`-unconfined and
DRILL-DOWN decisions this rides the heartbeat prompt, not a hard gate — with the same two real
backstops underneath: the propose/confirm wiki path and the ConfirmBroker mutate-dialog on the API
side both keep a commit from landing silently regardless of what a beat *tries*. Whether the
sharpest commit — pane-steering via unconfined `Bash` — deserves a hard jarvisd gate stays the
open question of §2.9/§2.10.

### 2.6 Concrete implementation plan

Everything hooks into `Session` (`apps/jarvisd/src/session.ts`) and `main()`
(`apps/jarvisd/src/main.ts`). Names below are the real symbols as of 2026-07-03.

**(a) A heartbeat entry point on `Session`.** Add a public method — call it `heartbeat()` —
that is the single guarded gate, modelled on `drainAnnouncements()` (`session.ts:307`) and the
idle-backstop's checks (`session.ts:190-197`). It must **no-op unless the room is genuinely
idle**, because injecting a turn while `this.active` is set is the *barge-in* path
(`startTurn`, `session.ts:616`) — a heartbeat must never interrupt Rafe mid-sentence. Guards, in
order:

```
heartbeat():
  if (this.active) return;                       // a real turn is in flight
  if (this.pendingAnnouncements.length) return;   // idle channel is busy speaking a result
  if (brainRestartPending) return;                // a deferred model/thinking restart is queued
  if (!this.store.hasTurns) return;               // never heartbeat an empty session
  // (optional) skip if the session has been idle so long the idle backstop is about to end it
  void this.startTurn("heartbeat", HEARTBEAT_PROMPT);
```

**(b) A new turn source, `"heartbeat"`.** `startTurn` already takes
`source: "voice" | "text" | "system"` (`session.ts:608`). Add `"heartbeat"`. Two touch-points:

- **The bundle gate** at `session.ts:700` is currently
  `const bundle = source === "system" ? null : await this.assembleBundle();`. A heartbeat *wants*
  the bundle, so `"heartbeat"` must fall on the assemble side — i.e. keep the gate as "only
  `system` skips it," and `"heartbeat"` naturally assembles. This is the whole point of the
  turn.
- **The wire `source`** in `SessionSink.sendTurnBegin` / the activity `turn.begin` event is
  typed `"voice" | "text" | "system"` (`session.ts:31`, and the `ActivityEvent` union in
  `docs/design/jarvis-post-m4.md` §II.2). Lightest path: emit heartbeat turns to the wire as
  `source: "system"` (they *are* system-originated) while keeping `"heartbeat"` as the internal
  discriminator that drives the bundle + prompt. If Activity should visibly distinguish
  heartbeats (recommended — see §2.8), add `"heartbeat"` to the protocol union and the stage's
  turn-card chip instead.

**(c) The heartbeat prompt — the key artifact.** This is where the feature's value actually lives.
Rafe's framing: *"you need to be clever with how you're being proactive,"* *"we just need to get
the right prompts."* Because the speak/stay-silent decision is judgment rather than a rules table
(§2.4), the prompt is the thing that gets iterated — expect to tune it by watching real heartbeats,
not to write it once. `HEARTBEAT_PROMPT` is a bracketed, clearly-synthetic instruction in the
idiom of the stage-fault preamble (`session.ts:528`), carrying: (i) what a heartbeat is — a
periodic glance, not a question; (ii) the **second-engineer stance** — read the workspace, form a
real opinion on what the agents are doing, and speak only when a sharp colleague actually would;
(iii) the objective, if one is set (§2.6f). A starting sketch, expected to grow:

> `[heartbeat — automated, not from Rafe] A periodic glance over Rafe's shoulder, not a question.
> Below is his workspace: a roster of every terminal pane and browser tab, plus the focused
> pane/tab in depth. Read it like a second engineer sitting beside him. You may drill into any
> pane (tmux capture-pane) or read the code an agent is writing (the shell) before forming a view.
> Then decide, as that engineer would, whether anything is worth saying out loud right now — a
> progress summary he'd want, an agent heading down a path that'll bite, an approach worth
> suggesting, a real second opinion, or a genuine state change. If nothing clears that bar, call
> no say and stay silent; most beats are silent. If you speak, one short line, detail on the
> stage. Never remark on routine progress, cosmetic churn, or anything he can plainly see.`

**Example judgments (the starting calibration set — grow it from real misfires).** A few worked
situations, each the kind of call the prompt has to get right:

- Agent in pane 2 just wrote a migration that drops a column with no backfill → **speak**: "that
  migration drops `users.legacy_id` with no backfill — anything still reading it breaks." (a real,
  catchable mistake)
- Agent is three files into a refactor, tests green, going fine → **silent** (routine progress; a
  colleague wouldn't interrupt for it).
- Rafe's objective is "get the victors migration merged"; the agent just opened the PR →
  **speak**: "victors migration PR is up, CI's running." (an objective milestone he'd want).
- An agent hit a transient network error and retried successfully → **silent** (self-resolved
  noise).
- Build in pane 1 went red two beats ago and is still red; Rafe has moved to another pane →
  **speak once**: "pane 1's build has been red ~30 min — flagging in case it fell off your radar."
- Rafe is reading docs in Chrome, nothing is broken, no objective set → **silent** (nothing a
  second engineer would say aloud; exactly where an unprompted remark becomes a nuisance).

**(d) The timer, wired in `main()`.** `main.ts:300` already wires
`session.startIdleBackstop(idleSessionEndMs, …)` — a `setInterval` at 60s with `timer.unref?.()`
(`session.ts:189-200`). Add a sibling `session.startHeartbeat(intervalMs, …)` on the same
template, or a bare `setInterval` in `main()` calling `session.heartbeat()`:

```
// main.ts, near the idle-backstop wiring (~line 300)
const heartbeatMs = cfg.heartbeat_min * 60_000;      // new config key; 0 disables
if (heartbeatMs > 0) {
  const hb = setInterval(() => session.heartbeat(), heartbeatMs);
  hb.unref?.();
}
```

Config: add `heartbeat_min` to `apps/jarvisd/src/config.ts` (default e.g. 15; `0` = disabled, so
the whole feature is dark-launchable, matching how `wake_word=""` disables the wake gate). It
also belongs in the settings control plane (`applySettings`, `main.ts:328`) if Rafe wants to
toggle cadence by voice later — but that is not required for v1.

**(e) The speaking circuit breaker.** Add `lastHeartbeatSpokeAt` + `HEARTBEAT_SPEAK_COOLDOWN_MS`
to `Session`, mirroring `lastCorrectiveAt`/`CORRECTIVE_COOLDOWN_MS`. In the heartbeat turn's
completion path, detect whether the turn produced any `say` (the queue knows —
`queue.totalSays`, used already at `session.ts:594`; or the brain result's `fullText`). If a
heartbeat spoke, stamp `lastHeartbeatSpokeAt`. To *enforce* the cap rather than just measure it,
the cleanest lever is the prompt: when inside the cooldown, `heartbeat()` composes a variant
instruction that says "you are rate-limited from speaking this beat; if something is urgent,
note it silently" — since the model can't be forced not to call `say`, telling it not to is more
reliable than post-hoc swallowing. Keep the post-hoc swallow as the hard backstop.

**(f) Objective — optional durable state (§2.4).** Hold a small nullable field on `Session`: an
**objective** (a short string) plus an optional **target** (an agent/pane address from the roster,
e.g. `work:2.1`) it applies to. Rafe sets it in passing — "watch the victors migration against the
design doc," "keep an eye on that refactor" — parsed from an ordinary turn or via a trivial
`settings`-style setter. When set, `heartbeat()` folds it into `HEARTBEAT_PROMPT` and the model
monitors that target across beats: re-read its pane output and (via the shell) the code it's
producing, and report progress or a divergence from the objective. Continuity makes this cheap —
the model already watched the last several beats of the same target (decision (b)). When it's
null, the prompt carries no objective clause and the heartbeat is pure over-the-shoulder judgment
across the whole workspace. The *same* field also backs the minor accountability-nudge flavor
(§2.4): a goal like "finish the heartbeat doc today" invites a light drift-nudge — but that is one
optional use of the objective, not its purpose, which is monitoring the *work*. Clear it on
`endSession()` (per-session, like the transcript and pending notes, `session.ts:161-176`); let
Rafe drop or change it by voice. *Rationale: an explicit objective is what lets "monitor against a
goal" be about the engineering, and keeps any focus-nudge tied to something Rafe actually said
rather than to Jarvis's own opinion.*

**(g) Acting on approval (§2.5) — mostly free, one small allow-list change.** No new persistence:
the pending suggestion lives in the warm transcript (decision (b)), so "hold" is just the model
*not* acting until approved, and "act on approval" is an ordinary turn where Rafe says "do it" and
Jarvis runs the held action. Execution uses tools the CLI brain already has: `Bash` for
`tmux send-keys -t <target> "…" Enter` (steer a pane) and one-off commands; `subagent_start` (tasks
MCP) for background work; `browser_open` for its own browser. The one code change is the allow-list
— to let Jarvis *click/type* in its own Chrome profile, move `browser_click`/`browser_type` from
`CLI_DISALLOWED` to `CLI_ALLOWED` (`main.ts:56`,`main.ts:32`), safe because they bind only the
dedicated `:9222` profile. Everything that mutates Rafe's real machine still relies on the same
posture as tier-1 Bash today (`bypassPermissions`; "ask before destructive" as a prompt norm) —
which is why the HOLD-for-approval discipline, and the question of a harder steering gate (§2.10),
matter here. *Rationale: the loop is a prompt/behavior pattern over capabilities that already
exist; the only genuinely new wire is optionally granting own-profile clicks.*

**Build order (each ends in a demo):**
1. **Awareness only.** Wire (a)–(d) with a prompt that says *never speak* — pure silent
   heartbeats. Demo: leave a session idle, watch heartbeat turns appear in Activity every ~15
   min with a bundle and no audio; then ask a question and confirm Jarvis already knows the state
   that changed while Rafe was away.
2. **Proactive judgment.** Relax the prompt to the §2.4 second-engineer stance and add the
   circuit breaker (e). Demo: point an agent in a pane down a wrong path (or let a build sit red)
   and watch the next heartbeat flag it in one line; on a routine-progress beat, confirm it stays
   silent.
3. **Objectives.** Add the objective field (f) and its prompt clause. Demo: "watch the victors
   migration against the design doc," then let the agent work across a couple of beats; a
   heartbeat reports progress and, when the agent diverges, says so. (The minor accountability-nudge
   flavor rides the same field — a stated goal like "finish the doc today" invites a light
   drift-nudge; no goal, no nudge.)
4. **Act on approval.** Wire (g): optionally enable own-profile clicks, and lean on the prompt to
   hold each suggestion with a concrete action attached. Demo: point Jarvis at an agent about to
   make a mistake; it flags "I'd stop it and tell it to X — say the word"; say "do it" and watch it
   `tmux send-keys` the correction into that pane; confirm that with no approval, nothing fires.

### 2.7 Why ~15-min polling (not event-driven)

Recorded as Rafe's decision (2026-07-03): **cost at a 15-min cadence is noise-level, and
simplicity wins.** An event-driven design (tmux `pipe-pane` tails, a Chrome-extension push, file
watchers — the `docs/design/observability.md` Phase 3–4 substrate) would react faster but demands
real infrastructure: a rolling journal, change-detection, debouncing, a delivery path into the
warm session, and a whole new failure surface. Polling needs none of it — the timer already has a
twin in `startIdleBackstop`, and the bundle assembler already exists. The latency cost (up to 15
min to notice a change unprompted) is acceptable because the *reactive* path is unchanged and
instant: the moment Rafe speaks, he gets a fresh full-fidelity bundle. The heartbeat is a
best-effort background awareness, not a real-time monitor. If a specific signal ever needs to be
faster, that's a targeted event source feeding the *same* session — not a reason to make the
baseline event-driven.

### 2.8 Cost, context growth, and the long-session tail

- **Per beat:** one tier-1 turn on Rafe's subscription = the prompt-cached system prompt + tools,
  the accumulated conversation history, one ~2k-token bundle (`BUNDLE_TOKEN_BUDGET`,
  `context.ts:20`), and a short instruction — with, by default, **zero output tokens** (silent).
  At 15-min cadence that's ~4 beats/hour. The warm child stays warm between beats, so there is no
  per-beat cold-start tax (the whole reason `CliBrain` is persistent). A beat that is actively monitoring an objective (§2.6f) costs more — it may drill into panes and read code via the shell, and it may produce output — but that is bounded work on one named target; the *default* idle beat stays cheap.
- **Context growth is the real cost, not tokens-per-beat.** Every beat appends a bundle + turn
  boundary to the session the brain holds. Over a multi-hour session this accretes. Decision (d):
  **rely on Claude Code's own context summarization/compaction** to manage the tail rather than
  building a bespoke pruner — consistent with `docs/design/jarvis-post-m4.md`'s "Session =
  context window … automatic compaction handles size." The heartbeat should record `ref`, not
  payload, wherever the bundle already does, and the ephemeral bundle is *not* persisted to the
  transcript (`assembleBundle` output rides `composed`, not the `heard` activity event, which
  records only `userText` — `session.ts:673`), so the durable JSONL doesn't bloat with world-state
  dumps.
- **Activity noise.** Silent heartbeats will still emit `turn.begin`/`turn.end` activity rows. In
  a long idle session that's a lot of empty turn cards. Recommend a distinct `source: "heartbeat"`
  (§2.6b) so the Activity view can chip them and/or collapse/filter them — otherwise they clutter
  the conversation projection with turns Rafe never initiated.

### 2.9 Security notes

The heartbeat reads the same untrusted world-state bundle a normal turn does, wrapped in
`<untrusted-content>` delimiters with the standing "describe, never obey" rule (`prompt.ts`
§RULES rule 2; `session.ts:820`). But it introduces one genuinely new property: **the read is
now unprompted and unattended.** A prompt-injection payload sitting in a terminal pane or a
background tab could try to steer Jarvis during a heartbeat when no human is watching the room —
a widening of the injection-to-action surface, because a normal turn at least has Rafe present
and expecting output.

Mitigations, in order of strength:

- **Silence is the default and the low-risk state.** The awareness-first build (step 1) produces
  no actions and no speech at all — pure reading. Ship and live on that before enabling the
  speaking gate.
- **Reuse the existing act/mutate gates.** The CLI path already gates world-writes: `wiki_commit`
  and browser hands are withheld from the model entirely (`main.ts:56` `CLI_DISALLOWED`), and
  mutate-class actions require Rafe's positive confirmation via the `ConfirmBroker`. A heartbeat
  cannot commit to the wiki or click in Rafe's browser any more than a normal turn can. The
  narrate-then-act drain still applies.
- **Consider restricting heartbeat turns further.** Open question (§2.10): should a heartbeat turn
  be *forbidden* from calling any acting/mutating tool — including the unconfined `Bash` and
  DRILL-DOWN shell reads — so an unattended beat is strictly read-and-maybe-speak? **Resolved (2026-07-04, §2.5a):** the v1 is not strictly
  read-only but **prepare-don't-commit** — a beat may read, analyze, and *stage* reversible
  artifacts (draft answers, `wiki_propose_edit`, read-only research subagents) but takes no
  committing / world-affecting action without a subsequent Rafe-initiated turn. Not currently
  enforceable per-turn (tool grants are set at child spawn, `cli-brain.ts:79-85`), so it is a
  prompt norm first — flagged honestly as norm-not-gate, exactly as the `Bash`-unconfined
  decision is (`docs/design/jarvis-post-m4.md` §II.6) — with the propose/confirm and ConfirmBroker
  gates as the real backstops under it.
- **Acting on approval widens the surface — the HOLD step and the browser boundary are the guards
  (§2.5).** Steering a pane is unconfined `Bash` (`tmux send-keys`), so nothing *mechanically* stops
  an autonomous heartbeat from typing into another agent — the guard is the suggest→hold discipline
  (fire only on Rafe's approval) plus the same "ask before destructive" prompt norm as all tier-1
  Bash. Acting in Jarvis's own Chrome profile is safe by construction (dedicated CDP profile, never
  Rafe's). Acting in Rafe's **real** logged-in browser stays blocked by the eyes/hands split
  (`servers/browser/src/index.ts`) and would take an explicit boundary relaxation (§2.10). Whether
  pane-steering deserves a hard jarvisd gate rather than a norm is the sharpest question here.
- **Egress is unchanged.** The bundle already passes secret-shape redaction before egress
  (`redactSecrets`, `mcp/manager.ts:133`) — the honest accident-net caveat from the original
  §Security applies identically; a heartbeat just fires it on a timer instead of on an utterance.

### 2.10 Open questions

1. **What does an always-aware Jarvis actually *do* for daily work — and which of it justifies
   the feature vs. which is a gimmick?** Passive awareness (answer the next question with full
   context, no catch-up) is the floor and clearly pays for itself. The active possibilities, to be
   pressure-tested against real use, in rough order of expected payoff:
   - **Second opinion on in-flight agent work.** *The core proactive value* (§2.4): read what a
     `claude`/agent is outputting in a pane, check the code it's writing, and surface a progress
     summary, an early wrong-path flag, or a better approach — a reviewer riding along on work that
     would otherwise be an unwatched solo loop. Strongest justification and the tightest fit to the
     roster + shell already in hand; build it first.
   - **Objective monitoring.** Hand Jarvis an objective + a target and have it report the work's
     progress/divergence across beats (§2.6f). A close companion to the above — the same read,
     pointed and persistent.
   - **Cross-pane air-traffic-control.** Surface "the thing in pane 3 failed while you were in pane
     1." A subset of the second-opinion read applied across the whole roster; valuable, but only as
     good as the speaking judgment behind it.
   - **Continuity / second-brain.** "You were debugging this exact thing yesterday"; draft a wiki
     log entry from a session's arc (the ambient-draft path, `main.ts:221`), now continuous rather
     than session-end-only. Justifies itself only if the recall/drafts are trusted.
   - **On-stage reference lookups while Rafe stays in flow.** Pre-stage the relevant page/doc
     beside the work *without speaking*. Exploits awareness without touching the speaking knob;
     gimmick risk is clutter — earns its place only if trivially ignorable.
   - **Ambient subagent work.** Dispatch a tier-2 subagent when a longer investigation is
     warranted, the result surfacing later via the idle channel. *Highest gimmick risk* —
     unattended dispatch is the most speculative and the biggest cost/security multiplier.
   - **Accountability nudges.** The minor, optional focus flavor (§2.4) — highest *annoyance* risk
     of the speaking modes, deliberately no longer central; keep it small and goal-anchored.
   The call to make: build the second-opinion read + objective monitoring first (clearest payoff,
   tightest fit to what's already built), treat reference-pre-staging as a cheap experiment, and
   hold the highest-risk modes — ambient subagent dispatch and accountability nudges — until the
   core has earned trust.
2. **The heartbeat prompt is the project — how do we iterate and evaluate it?** Rafe: *"you need to
   be clever with how you're being proactive,"* *"we just need to get the right prompts."* The
   speak/stay-silent quality is *entirely* the prompt's quality, not a rules table (§2.4, §2.6c),
   so the real open work is prompt engineering with a feedback loop: can we replay recorded
   heartbeat turns against a labeled set of situations (should-speak / should-stay-silent) offline
   to regression-test prompt changes? Should every heartbeat log its decision + Rafe's reaction
   (ignored / engaged / "not now") so the prompt tunes against real misfires? Start from the §2.6c
   example-judgment set and grow it from whatever the model gets wrong. The accountability-nudge
   flavor is the sharpest annoyance case to watch in that log — but a minor mode, not the headline.
3. **Cooldown enforcement mechanism.** Prompt-told rate-limit vs. post-hoc say-swallow vs. both
   (§2.6e). Pick on observed spam rate.
4. **Per-turn tool restriction for heartbeats** (§2.9) — norm-only for v1, or is a real
   spawn-time / per-turn grant split worth building so an unattended beat provably can't act?
5. **Cadence & config surface.** Is 15 min right, and should it be voice-adjustable via
   `settings_set` or a fixed config key? Should cadence back off when the session has been idle a
   long time (fewer beats when nothing is happening), or when Rafe is clearly away
   (the idle backstop is about to end the session anyway)?
6. **Activity representation.** Distinct `source: "heartbeat"` + filter chip, or fold into
   `system`? (Recommended: distinct — §2.8.)
7. **Interaction with the idle backstop.** A heartbeat touches the session (`startTurn` →
   `store.append`), which updates `store.lastEventAt` — so naive heartbeats would *prevent* the
   idle backstop (`session.ts:195`) from ever ending an abandoned session. The heartbeat must
   either not count as activity for the idle clock, or the idle backstop must ignore
   heartbeat-only turns. Flag and decide before shipping — otherwise sessions never rotate and
   ambient drafting never fires.
8. **Acting in Rafe's real logged-in browser — should the read-only boundary ever be relaxed?**
   Today it's deliberately blocked: eyes read the real Chrome via AppleScript, hands act only on
   the dedicated Jarvis CDP profile (`servers/browser/src/index.ts`), so an injected page can't
   drive Rafe's authenticated sessions. Relaxing it (granting CDP on the real profile) would let
   Jarvis actually operate Rafe's logged-in accounts on approval — genuinely useful for "book that,
   reply to this" — but it collapses the single strongest anti-injection guarantee in the design: a
   poisoned page read during an unattended heartbeat could reach an actuator on Rafe's real sessions
   with no human present. Recorded as an **explicit decision, not a default**: if ever taken, it
   should be opt-in, scoped per-session or per-action, and lean on the risk-class confirm gates the
   original design specified — never silently on.
9. **Does steering an autonomous agent need a harder gate than a prompt norm?** `tmux send-keys`
   rides unconfined `Bash`, so the suggest→hold→act discipline (§2.5) is currently a *behavioral*
   guard, not an enforced one — an autonomous heartbeat could in principle type into another
   agent's pane without approval, and typing into an agent can derail it as easily as correct it.
   This sharpens the per-turn-tool-restriction question (item 4): should heartbeat-originated turns
   be barred from `send-keys`/act tools until Rafe approves in a *subsequent* Rafe-initiated turn (a
   real gate), or is the norm plus the always-visible Activity log (where every `send-keys` shows
   up) enough? Start conservative: hold by default, act only in a turn Rafe drove.

---

## 3. Decisions & rationale (2026-07-03, Rafe's direction)

| # | Decision | Rationale |
|---|---|---|
| a | **Awareness and interruption are decoupled knobs; build awareness first.** | A silently-aware Jarvis is already useful and carries no annoyance risk; speaking unprompted is the high-risk, high-reward part. Ship silent heartbeats, then gate speech on top. (§2.4) |
| b | **In-session heartbeat, not a separate process/session.** | Continuity comes free — the warm session's transcript *is* the memory, so no external activity log or change-detection is needed. This is the biggest simplification. (§2.2) |
| c | **~15-min polling, not event-driven.** | Cost at that cadence is noise-level and simplicity wins; event sources demand real infrastructure (journals, change-detection, delivery) for latency the reactive path already provides on demand. (§2.7) |
| d | **Rely on Claude Code's own context summarization for the long-session tail.** | The in-session design's one real cost is context growth; automatic compaction already handles size, so no bespoke pruner. (§2.8) |
| e | **Roster is every-turn; deep read is the active surface; drill-down is on-demand and needs no new tool.** | The brain's own shell + AppleScript already reach any pane/tab, so widening the eyes cost almost no new code. (§1.1) |
| f | **The proactive value is substantive engineering awareness — read agents' work, hold an opinion, give progress summaries / wrong-path flags / approaches / second opinions / objective monitoring — NOT focus-policing.** | Rafe's pushback (2026-07-03): the payoff is a second engineer glancing over your shoulder, not a productivity cop. Accountability nudges survive only as one minor, optional flavor. (§2.4, §2.6f) |
| g | **The speak/stay-silent decision is prompt-driven judgment, not a mechanical gate; the heartbeat system prompt is the key artifact to iterate on.** | Rafe: "you need to be clever with how you're being proactive," "we just need to get the right prompts." A good engineer's sense of when a comment is worth making isn't a rules table — it lives in the model, shaped by the prompt. (§2.4, §2.6c, §2.10) |
| h | **Jarvis acts via suggest → hold → act-on-approval, primarily by steering the agents Rafe already runs (own panes via `tmux send-keys`, subagents, its own browser profile).** | A second engineer who acts, not just talks — but a human stays in the loop on high-consequence moves, and the pending-suggestion queue is free because the warm transcript already remembers what was flagged (decision (b)). (§2.5) |
| i | **Jarvis stays read-only on Rafe's real browser; acting there would be an explicit, non-default boundary relaxation.** | Eyes-via-AppleScript / hands-only-on-the-dedicated-profile is the strongest anti-injection guarantee in the design; a heartbeat reading poisoned pages must not be one grant away from driving Rafe's logged-in sessions. (§2.5, §2.10) |
| j | **On its own authority a beat may PREPARE but not COMMIT: read/analyze, work up answers, stage `wiki_propose_edit`, dispatch read-only research subagents — but no side-effecting write, pane-steering, or committing action without an approval turn.** | Rafe (2026-07-04): acting should be "analysis and getting ready to help instead of actually doing work for yourself." Widens the read-only v1 along the *reversible* axis only — readiness without the unattended-mutation exposure §2.9 guards. The stack's propose/confirm and suggest/hold gates make "staged" vs "committed" a real distinction. (§2.5a) |

## 4. Alternatives considered

| Alternative | Why rejected |
|---|---|
| **Separate heartbeat process / session** | Forfeits free continuity — it would need its own memory of prior state to detect change, and a delivery path back into the warm session. In-session gets the transcript-as-journal for nothing. (§2.2) |
| **Event-driven watchers (tmux `pipe-pane`, Chrome-extension push, file watchers)** | Real infrastructure and a new failure surface for latency the reactive path already delivers instantly on the next utterance. A targeted event source can still feed the same session later if one signal genuinely needs sub-15-min reaction. (§2.7) |
| **New MCP tool for drill-down into non-active panes/tabs** | Unnecessary — the brain has a shell and AppleScript; `tmux capture-pane -t <pane>` and per-tab AppleScript are already in its hands. Adding a tool would enlarge the per-turn schema for capability that already exists. (§1.1) |
| **Speak-by-default heartbeats, mute the noise** | Backwards. The say-tool contract makes silence the natural default (`cli-brain.ts:152`); a speak-by-default design would fight that and require a muting layer. Silence-by-default + a high speaking bar is both safer and less code. (§2.4) |
| **Encode the speaking decision as mechanical gate-rules (a speak/don't-speak conditions table or rules engine)** | Rejected (Rafe, 2026-07-03): a second engineer's sense of when a remark is worth making isn't a rules table — hard conditions produce both false alarms and missed catches. The judgment lives in the model, shaped by the prompt (§2.6c); jarvisd keeps only a crude anti-spam circuit breaker, not a decision engine. (§2.4) |
| **Bespoke context pruner for the long session** | Duplicates Claude Code's compaction; decision (d). |
| **Fire a suggestion's action autonomously (no approval)** | Rejected: typing into an autonomous agent, running a command, or acting in a browser unattended is high-consequence and the exact injection-to-action path the design guards; hold-for-approval keeps a human in the loop, and the pending queue is free anyway (decision (b)). (§2.5) |
| **A dedicated pending-suggestion store / queue** | Rejected: the warm session's transcript already remembers what Jarvis flagged and the action it proposed twenty minutes later; a separate queue duplicates state and drifts from it (decision (b)). (§2.5) |

## 5. Part 3 — the coworker loop (as-built 2026-07-04)

Rafe's framing for this round: "how do we make this a coworker that actually helps me, like
Jarvis in Iron Man." The heartbeat gave Jarvis a clock and eyes; Part 3 gives it the three
things a responder still lacked — **a memory of what Rafe's world was mid-way through, standing
responsibilities it follows through on, and a debuggable interruption judgment.** Everything
below rides the existing substrate (context-tool bundles, the heartbeat turn source, prompt
norms); no new wire types, no stage changes.

### 5.1 The lab-activity stream — `servers/workspace`

`workspace_context` returns a roster of recently active git repos under `workspace_dirs`
(config, default `~/other/lobs`): name, branch, dirty count, last commit subject, recency —
newest first, 14-day window, capped at 12. The pane/tab roster shows what's *on screen right
now*; this shows what's been *worked on lately* even with no window open on it — the
zero-integration answer to "what was he in the middle of?". Auto-discovered by
`collectContext()`, so it rides every bundle: real turns, heartbeats, arrivals.

Two implementation notes that matter: the bundle assembler's ~300 ms race means the tool
serves a **cached snapshot** refreshed on a 5-min background timer (scanning ~60 dirs inline
is fatal); and `git status` must run `--no-optional-locks`, because a plain status *refreshes
the index* — the scan itself would bump every repo's `.git/index` mtime and drag the whole
roster toward "0m ago" (caught live during the build). Recency = max(last commit,
`.git/index` mtime, `.git/HEAD` mtime), so uncommitted work counts.

### 5.2 The follow-through ledger — `servers/watch`

The durable form of §2.6f's per-session objective, and the completion-observability piece: a
watch item is something Jarvis is keeping an eye on until it can *see* it's done. Store is
`~/.jarvis/watch.json`, read/rewritten per call with no in-memory state (the on-disk proposals
lesson: jarvisd and the CLI child each run their own server instance). Tools: `watch_add(text,
target?)` (open-item cap 30), `watch_done(id, note?)` (done items retained 7 days),
`watch_list`, and `watch_context` for the bundle — open items ride **every turn**, so
follow-through needs no separate delivery path. The system prompt sets the norms: add on
"keep an eye on / remind me / make sure" or a promise to check later; close quietly when the
workspace shows it done ("a coworker who quietly closes loops beats one who nags about
finished work"); persists across conversations by design — this is deliberately NOT the
transcript-is-the-queue answer of decision (b), because that queue dies with the session and
follow-through must not.

### 5.3 Arrival beats — the "speaks first, correctly" moment

Presence comes from the Mac's **HID idle clock** (`ioreg -c IOHIDSystem`, polled per minute in
main()), not from open stage tabs — a tab left open overnight would mask every return. On the
away→back edge after ≥ `arrival_min` (default 45, 0 disables) with a stage open, main fires
`session.arrival(awayMinutes)`: a heartbeat-source turn whose prompt *expects* speech — one
short line, useful fact first, "never greet for greeting's sake" — and which is **exempt from
the speak cooldown** (that's what the beat is for; a spoken arrival still stamps the cooldown
so ordinary beats stay quiet after it). It skips the `hasTurns` guard deliberately: greeting a
fresh session is the point.

### 5.4 Beat verdicts — the gate becomes debuggable (§2.10 Q2, answered)

Every heartbeat/arrival prompt now ends with the verdict norm: close the private workspace
with one line — `verdict: silent — <why>` / `verdict: spoke — <why>`. At turn end jarvisd
parses the last such line out of the accumulated thought and emits an Activity note
(`beat verdict: …`; falls back to "spoke/silent (no reason stated)"). The feedback loop §2.10
Q2 asked for: when the timing feels off, Rafe greps the verdicts and tunes the prompt against
real misfires instead of muting the feature.

### 5.5 Budget knobs, and the norm updated to §2.5a

`heartbeat_speak_cooldown_min` (default 30) replaces the hardcoded cooldown — together with
the cooldown stamp this IS the interrupt budget (≤ ~2 unprompted lines/hour, tunable).
`quiet_hours` ("23:00-08:00" style, wraps midnight) **skips beats entirely** — overnight
awareness of an idle machine is context growth with no reader; arrival beats are exempt
(sitting down at 2 a.m. is exactly when a brief is wanted). And the in-code heartbeat norm
finally caught up with decision (j): `HEARTBEAT_READONLY_NORM` → `HEARTBEAT_PREPARE_NORM`
(prepare-don't-commit), which also legitimizes watch-list bookkeeping on unattended beats —
own-boundary and reversible.

### 5.6 What was deliberately NOT built

- **No daily speak-cap bookkeeping** — cooldown + quiet hours already bound the worst case;
  add a cap only if the verdict log shows real spam.
- **No settings-drawer surface for the new knobs** — config.toml keys only, until they've
  proven they need voice/UI access.
- **No email/calendar stream** — the designed Helm v0 stream, but it drags triage-quality
  problems in before the interrupt gate is calibrated on low-stakes signals. The lab stream
  is the calibration ground; external streams are the next part, not this one.
- **Watch items for tier-2 subagents** — workers still get wiki-only; revisit if a
  background task ever needs to stage a watch.
