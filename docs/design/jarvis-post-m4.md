# Jarvis — post-M4 design doc: durable sessions, ambient drafting, presence, and the observable agent

> **Status:** Design (2026-07-03). No implementation exists yet. This doc is the plan of
> record for the phase *after* `docs/design/jarvis.md` (M0–M4, all landed). It builds
> strictly on the shipped substrate — it supersedes nothing in the original doc, it extends it.
>
> **Reviewed against reality, not the original doc's promises.** Every "current behavior"
> claim below was read from source on 2026-07-03 (files cited inline), because M0–M4 drifted
> from their design in small ways that matter here (e.g. `/ws` is already a broadcast bus, not
> audience-of-one).
>
> **Live-code caveat:** these source citations (file:line, behaviors) were true on 2026-07-03;
> jarvis source is under active edit, so re-verify each cited claim before implementing against it.
>
> **Extended 2026-07-03 (Rafe's direction) — Part II** (end of this doc) adds two capabilities on
> the *same* substrate as the four layers above: **Activity** — a complete, persisted, clearly
> viewable log of everything Jarvis and its subagents do — and **interactive subagents** — tier-2
> promoted from fire-and-forget one-shots to addressable agents you can start, message, poll, and
> read. They are not a fifth layer: Activity **is** Layer 1's durable log widened, and interactive
> subagents **are** the tier-2 worker Layer 3 leans on, made first-class.

## 0. Scope

Four capabilities, but they are **one dependency stack, not four features** — the ordering is
the whole insight:

```
  ┌─────────────────────────────────────────────────────────┐
  │  4. Presence: wake word (in transcriber) + barge-in (AEC) │  ← nicest to talk to
  ├─────────────────────────────────────────────────────────┤
  │  3. Ambient wiki drafting (draft-with-review at "new")    │  ← the payoff
  ├─────────────────────────────────────────────────────────┤
  │  2. Reconnect-on-refresh (replay live session to new tab) │  ← the keystone
  ├─────────────────────────────────────────────────────────┤
  │  1. Durable session history (record every turn to disk)   │  ← the foundation
  └─────────────────────────────────────────────────────────┘
```

Layer 1 makes 2 possible (you can't replay what you didn't record); layers 1+2 make 3 nearly
free (the recorded session **is** the journal ambient drafting reads); 4 is independent polish
that rides alongside. Build bottom-up.

**Part II (end of doc)** extends this stack *sideways*, not upward: **Activity** reuses Layer 1's
durable log (widening it into the single record the whole UI reads); **interactive subagents**
generalize the tier-2 worker Layer 3 already fires. Neither is a new foundation — both cash in the
one fact that jarvisd already *sees* the full-fidelity stream (tier-1's child, and every tier-2
child) and today throws most of it away.

## 1. The Problem

Jarvis today is amnesiac in two ways that undercut everything it's for. First, a session lives
only in the running `jarvisd` process: refresh the stage and the conversation is gone — the new
browser tab connects to a live daemon but sees a blank stage, so Rafe restarts from scratch.
Rafe's words: "it's a pretty bad feature." Second, because nothing is durably recorded, Jarvis
can never look back at what happened in a session — which means the marquee deferred feature,
**ambient wiki drafting** (Jarvis proposing wiki entries from observed work), has nothing to
read. The original design gated ambient drafting on "trust earned by reactive mode"; that trust
now exists, but the *memory* it needs does not. Fixing the amnesia is the unlock. On top of that
we want two presence upgrades — a wake word so Jarvis is a thing that's just *there*, and
acoustic barge-in so Rafe can cut Jarvis off mid-sentence — both small next to the session work.

## 2. The Technical Plan

### What already exists (read from source, 2026-07-03)

Three facts collapse most of this work before it starts:

- **Turns are already recorded to disk.** `apps/jarvisd/src/memory/store.ts` (`MemoryStore`)
  appends every user/assistant/interrupt/system event as one JSON line (the `warning` kind is declared but never written — a gap to close if we want warnings durable) to
  `~/.jarvis/sessions/<timestamp>.jsonl`, mode 0600. Layer 1 is *90% built* — what's missing is
  a **stable session identity** (today the filename is a fresh timestamp per process start, so a
  daemon restart silently forks the session) and **enough fidelity to replay** (today it stores
  `text` only — no exhibits, no turn source).
- **`/ws` is already a broadcast bus, not audience-of-one.** `apps/jarvisd/src/ws.ts`
  (`StageSocket`) keeps every open socket in a `Set` and fans all output to all of them; a new
  tab does *not* evict the old one. So a refresh already gets a live, wired socket into the
  running `Session`. The **only** thing missing is that the new socket receives no *history* —
  the daemon never replays the conversation-so-far, so the stage paints blank. Reconnect is a
  **replay-on-connect** problem, not a re-architecture.
- **History-of-record lives in the `BrainPort`, not in `Session`.** `apps/jarvisd/src/brain/port.ts`:
  `CliBrain`'s warm `claude` child *is* the history; `Session` owns only turn lifecycle and the
  performance layer. This matters: our durable JSONL is a **replayable projection** of the
  brain's conversation for the *stage's* benefit — it is not the brain's memory and must not try
  to be. On daemon restart the brain starts fresh (by design); the JSONL survives for replay and
  for ambient drafting, but does not resurrect the model's context. We state this explicitly so
  nobody later wires the JSONL back into the prompt and reinvents the wiki snapshot badly.

### The four layers

**Layer 1 — Durable session history.** Give a session a **stable id** minted once and reused
across daemon restarts within the same logical session (persisted to `~/.jarvis/sessions/current`).
Widen `TranscriptEvent` so a transcript can be *replayed*, not just read: record turn boundaries
(`turn.begin` with source voice/text), the `heard` text, each `say` item's final text, and each
**exhibit** directive (`show`/`update`/`dismiss` with id + type + title + payload-or-ref). A session
ends when Rafe says the **distinctive whole-utterance phrase** ("new session"/"start fresh" — never
a bare "new", which recurs in ordinary speech) or after an idle backstop; both the phrase and the
existing new-conversation button route through one `endSession()` routine (§4). Ending stamps the
JSONL closed and rotates to a new id in place. Everything else in the stack reads this file.

**Layer 2 — Reconnect-on-refresh.** On each new `/ws` connection the daemon sends a
**`session.replay`** message: a snapshot of the session's **currently-live exhibits** plus a
bounded transcript tail (recent captions). Three correctness constraints the first draft missed,
each verified against source:
- **Exhibits are keyed `${turnId}:${id}`, not `id`** (`apps/stage/src/exhibits.ts`). So replay is
  idempotent *only if* each replayed exhibit carries its original `turnId` — and `turnId` must be
  unique across the whole session, which today it is **not**: `Session.nextTurnId()` is a
  per-process counter that resets to `t1` on restart (`session.ts`). The Layer-1 "restart
  mid-session" demo would then collide a live `t3:e1` with a replayed `t3:e1`. **Fix (Layer 1):**
  mint turnIds as `<sessionId>-<n>` from a counter persisted with the session, so they never repeat.
- **`Session` retains no exhibit state today** — exhibits compile per-turn and stream straight to
  the sink. So "currently-live exhibits" needs a *source of truth* we must add: a small
  **live-exhibit registry** on `Session`, updated on every `show`/`update`/`dismiss` (add on show,
  replace on update, drop on dismiss). `replaySnapshot()` reads this registry, not the JSONL.
- **Mid-turn joins race the live broadcast.** A tab that connects while a turn is in flight gets
  the snapshot *and then* the live stream for the same turn. Rule: the snapshot contains only
  **completed** turns' live exhibits; the in-flight turn arrives via the normal stream. And replay
  **never carries audio** — a joiner must not re-hear TTS already spoken; it gets captions +
  exhibits only. This makes replay a strict projection with a clean cut at the current turn
  boundary.
No brain involvement; this is pure stage-side projection.

**Layer 3 — Ambient wiki drafting.** When a session ends, the daemon fires a **tier-2 background
task** to propose (never commit) up to two `wiki_propose_edit` diffs about *Rafe*, surfaced on the
stage exactly like a reactive edit (approve by click or exact-phrase per `ConfirmBroker`; 24h TTL
reaps the ignored). **Critical correction from review:** the tier-2 sandbox has **no file-read
tool** — by design (`apps/jarvisd/src/brain/bg-cli.ts`: only `wiki_*` + web tools; no `Read`, no
`Bash`). So the task **cannot be handed a path**. Instead, **jarvisd reads the closed JSONL itself
and inlines the (distilled) transcript into the task string** the runner already accepts. This
keeps the sandbox's "no unreviewed actuator" guarantee intact — the guardrail is: *the file read
happens in jarvisd, never in the child*. Two brain paths exist (`BackgroundRunner` SDK path in
`tasks.ts`; `CliBackground` subscription path in `bg-cli.ts`, chosen by `main.ts`); the trigger
calls whichever `dispatchBackground` main wired, and the inline-transcript shape is the only one
that works on both. Transcript goes to the child on **stdin, not argv** (argv is world-readable
via `ps`).

**Layer 4 — Presence.** Review exposed that these two pieces are **not independent** — they, the
wake word, and the *existing half-duplex mic gate* form one interacting system that must be
designed together, not three bullets.

Today (verified): the mic is an off-by-default **toggle** that fully releases the OS device when
off (`mic.ts`), and it is **half-duplex** — while TTS plays, `main.ts` drops mic frames
(`if (player.isPlaying) return`) and cancels the in-flight utterance. So "always there" and
"barge-in" both require capability that *doesn't exist yet*:

- **Wake word (transcript prefix).** Whisper transcribes clips, so wake-word = jarvisd treats an
  utterance as a turn only if its transcript starts with the wake word. Genuinely a string check —
  **but** it presumes a new **continuous-capture mode** the toggle doesn't provide; Layer 4 must
  *introduce* that mode, which is more than "nothing crazy." Gate **precedence must be explicit**,
  or it eats confirmations and interruptions: `pending-confirm → ConfirmBroker.tryPhrase` and
  `active-performance → barge-in` both **preempt** the wake-word check. A wake word is required
  *only* to *start a fresh turn from idle*; "yes commit" during a pending confirm and "stop"
  mid-performance must never be gated on it.
- **Barge-in.** Two blockers, not one. (a) The **software gate** `if (player.isPlaying) return`
  discards the interrupting audio before it's even transcribed — so barge-in first requires
  *lifting that gate while a performance plays*, feeding those frames to the endpointer. (b) Only
  *then* does the **acoustic** problem appear: the mic now hears our own TTS. That's what the
  loopback-RTCPeerConnection AEC is for — route TTS as the far-end reference so the browser AEC
  cancels it, leaving only Rafe's voice to trigger `player.flush()`. AEC is the genuinely uncertain
  piece (§Alternatives timeboxes it; headphones remain the shipped fallback, and a **tap /
  keypress "interrupt" affordance** always works regardless of AEC).

### Block diagram

```
  ┌──────────────────────────── stage (browser) ────────────────────────────┐
  │  mic → endpointer → [wake-word gate on transcript]        player.flush() │
  │        │                                                        ▲        │
  │        │ PCM16 up                        session.replay ────────┘        │
  └────────┼──────────────────────────────────────────────▲─────────────────┘
           │ /ws (broadcast bus, already multi-tab)        │ replay on connect
  ┌────────▼───────────────────────────────────────────────┼─────────────────┐
  │ jarvisd  Session ── turn ──▶ BrainPort (history of record, ephemeral)     │
  │             │                                                             │
  │             ├─▶ MemoryStore.append(event)  ──▶  ~/.jarvis/sessions/<id>.jsonl
  │             │                                          │ (durable, replayable)
  │             │   on "new"/idle ──▶ tier-2 task ─────────┘ reads closed session
  │             │                        │                                     │
  │             │                        └─▶ wiki_propose_edit (base-hash) ──▶ stage diff
  └─────────────┴─────────────────────────────────────────────────────────────┘
```

## 3. Alternatives considered and rejected

| Alternative | Why rejected |
|---|---|
| **Ambient drafting watches continuously and writes as it goes** | The original doc's core fear stands: confidently-wrong autobiography is worse than none. Session-end, draft-with-review keeps a human in the loop on a permanent record. Continuous writing also has no natural "is this worth recording yet" boundary — a session does. |
| **Replay by resurrecting the brain's context on reconnect** | The `BrainPort` is the history of record and is *ephemeral by design* (`CliBrain`'s child process IS the memory). Trying to rehydrate the model from the JSONL reinvents context management badly and fights the design. Replay is for the **stage** (repaint boards + captions), not the model. The model's continuity comes from the daemon staying up, not from replay. |
| **Session = context window; end it when the window fills** | Rafe: automatic compaction handles size, so size never forces an end. Tying "session" to the window would fire ambient drafts at meaningless moments (mid-thought, at a compaction boundary). A session is a *human* unit — it ends when Rafe says "new." |
| **Wake word via an in-tab WASM keyword model (Silero/openWakeWord)** | Real subsystem, real latency-tuning, always-hot mic, a model to ship and version. Rafe explicitly wanted "nothing crazy." A prefix-check on the transcript we already generate is zero new infrastructure and good enough — the endpointer already decides utterance boundaries. Revisit only if false-triggers from ambient speech become a real problem. |
| **Skip AEC; barge-in only via headphones (physical isolation)** | This is the *fallback*, not the plan — headphones already give full-duplex today. But Rafe wanted speaker-mode barge-in to feel right, so the loopback-AEC experiment is worth one bounded attempt. If it eats more than ~a day with no clean result, we ship headphones-full-duplex + a visible "tap to interrupt" affordance and move on. Recorded here so the timebox is explicit. |
| **A second `wake_word` MCP server / dedicated presence service** | Over-engineered. Wake-word gating is a string check in the stage's input path (or jarvisd's turn intake); it needs no server, no MCP round-trip. |

## 4. Detailed Implementation

Every file created or changed, bottom-up (build Layer 1 → 4 in order). Each layer ends in a
demo, matching the original doc's milestone discipline.

### Layer 1 — durable, replayable session history

- **`apps/jarvisd/src/memory/store.ts` (change).** Widen `TranscriptEvent.kind` to add
  `"turn.begin"` (with `source: "voice"|"text"`), `"heard"`, `"say"`, and `"exhibit"` (with
  `{op:"show"|"update"|"dismiss", id, exhibitType?, title?, payload?, ref?}`). Add a stable
  **session id**: on construction, read `~/.jarvis/sessions/current` if present and reuse that id
  (reopen the same `<id>.jsonl` in append mode); else mint one, write `current`, open the file.
  Add `close()`/`rotate()` — stamp `{kind:"session.end"}`, delete `current`, and (for `endSession`)
  mint the next id **in place** on the live instance. On construct, if a resumed `current`'s last
  event is older than `IDLE_SESSION_END_MS`, close it and start fresh (crash-resume must not
  resurrect a dead session). Prune by session-end mtime, not process-start. Record `ref` rather than
  `payload` when an exhibit has a ref, to avoid duplicating fetched bodies into the transcript.
  *Rationale: restart mustn't fork the transcript; replay needs exhibits + turn boundaries; and the
  durable-scope/privacy blast radius stays bounded.*
- **`apps/jarvisd/src/session.ts` (change).** Three things. (1) At each existing sink send
  (`sendTurnBegin`, `sendHeard`, `say` items, exhibit directives), also `store.append(...)` the
  new kinds — this is where exhibits + turn source get captured. (2) **Change `nextTurnId()`** from
  the per-process `t${counter}` to `<sessionId>-<n>` so turnIds are unique across a session and
  survive restart (see §2 Layer 2 — the current scheme collides on replay). (3) Add a
  **live-exhibit registry** (a `Map` updated on show/update/dismiss) so `replaySnapshot()` has a
  source of truth — `Session` retains no exhibit state today. (4) Add `endSession()` (see below)
  and detect the **distinctive phrase** ("new session"/"start fresh", whole normalized utterance,
  not a substring) to call it. *Rationale: turnId uniqueness and a live registry are load-bearing
  for replay; a bare "new" is a data-loss footgun.*
- **`endSession()` — one routine, two callers.** Both the existing `session.new` **button**
  (`main.ts` `onSessionNew`) and the spoken phrase route here: `store.close()` → fire Layer-3 draft
  on the just-closed transcript (only if `AMBIENT_DRAFTING`) → `brain.reset?.()` → open fresh
  session id in the live store. `MemoryStore` is constructed once at boot, so this mutates the
  live instance in place — there is no re-construction. *Rationale: unify click and voice so drafts
  fire exactly once regardless of how a session ends.*
- **`apps/jarvisd/src/config.ts` (change).** Add `IDLE_SESSION_END_MS` (backstop; default e.g.
  30 min) and `AMBIENT_DRAFTING` on/off flag. *Rationale: the idle backstop for when Rafe walks
  off without saying "new"; the flag lets the whole feature be dark-launched.*

### Layer 2 — reconnect-on-refresh (replay)

- **`packages/protocol/src/wire.ts` (change).** Add `session.replay`:
  `{type:"session.replay", exhibits: LiveExhibit[], transcriptTail: TranscriptEvent[]}`, where
  **`LiveExhibit` carries the original `turnId`** (not just `id`) — replay idempotency depends on
  it, since the stage keys `${turnId}:${id}`. Push-only on connect. Define `LiveExhibit`
  ({turnId, id, type, title?, payload?/ref?}) here.
- **`apps/jarvisd/src/ws.ts` + `Session.replaySnapshot()` (change).** On connect, `sendTo(ws,
  session.replaySnapshot())` — to the new socket only, not a broadcast. `replaySnapshot()` reads
  the **live-exhibit registry** (added in Layer 1) for exhibits of **completed turns only** (the
  in-flight turn arrives via the normal live stream — no double-apply), plus a bounded transcript
  tail. **Never include audio** — a joiner must not re-hear spoken TTS. *Rationale: a strict
  projection with a clean cut at the current-turn boundary.*
- **`apps/stage/src/wire.ts` + `apps/stage/src/exhibits.ts` + `main.ts` message handler
  (change).** Handle `session.replay`: re-`show` each exhibit under its **original `turnId:id`** so
  a refreshed tab and a second tab converge; backfill captions. Note the transcript pane
  (`ui/transcript.ts`) is append-only — the turn/line bookkeeping lives in `main.ts`, so the real
  change is there. *Rationale: repaint to match the running session with no duplicate or orphaned
  boards.*

### Layer 3 — ambient wiki drafting

- **New `apps/jarvisd/src/brain/ambient-draft.ts`.** jarvisd reads the just-closed JSONL itself,
  distills it to a compact transcript, and **inlines that text into the task string** — the tier-2
  child has **no file-read tool** (`bg-cli.ts`: wiki_* + web only), so a path is unusable. Prompt:
  "from this transcript, if something durably true about *Rafe* appeared, `wiki_propose_edit` the
  smallest correct change to the right page (pick via the wiki snapshot); else do nothing; never
  commit; at most 2 proposals." Dispatch via whichever runner `main.ts` wired (`BackgroundRunner`
  SDK path in `tasks.ts`, or `CliBackground` in `bg-cli.ts`); pass the transcript on **stdin, not
  argv**. Tag the task with the session id so the idle backstop can defer to it. *Rationale: keeps
  the file read in jarvisd (sandbox intact), works on both brain paths, avoids the argv leak.*
- **`apps/jarvisd/src/session.ts` (the "new"/idle handler, already above).** Fires this task.
  No new surface — proposals arrive through the same confirm/diff path as reactive edits.
- **No wiki-server changes.** `servers/wiki/src/index.ts` propose/commit already does exactly
  what's needed (base-hash revalidation, disk proposals, single-writer serialization of tier-1
  and tier-2). Stated explicitly as a guardrail: *do not add an "ambient" code path to the wiki
  server* — the whole point is that an ambient proposal is indistinguishable from a reactive one.

### Layer 4 — presence

- **`apps/stage/src/audio/mic.ts` + `apps/stage/src/audio/endpointer.ts` (change) OR
  `apps/jarvisd/src/session.ts` intake (change).** Wake-word gate: after transcription, if no
  confirm/barge-in is pending and the transcript does not start with the wake word (configurable,
  default e.g. "jarvis"), drop the utterance instead of starting a turn. Prefer doing this in
  jarvisd intake (one place, server-side, testable) over the stage. *Rationale: reuses the
  transcript we already compute; a pure string check; keeps the mic-hot cost but adds no model.*
- **`apps/jarvisd/src/config.ts` (change).** Add `WAKE_WORD` (default "jarvis", empty string =
  disabled, preserving today's always-on-turn behavior for testing). *Rationale: dark-launchable
  and testable without speaking a wake word every turn.*
- **`apps/stage/src/audio/player.ts` (already has `flush()`) + a new loopback path in
  `apps/stage/src/audio/mic.ts`.** Barge-in AEC: create an `RTCPeerConnection` loopback so TTS
  playback is presented to the browser AEC as the far-end reference signal; feed the AEC-cleaned
  mic stream to the endpointer so only Rafe's voice survives to trigger `player.flush()` +
  interrupt. *Rationale: the one uncertain piece; timeboxed per §Alternatives, headphones remain
  the shipped fallback.*
- **`apps/stage/src/ui/statusstrip.ts` (change).** Small affordance: show wake state ("say
  'jarvis'…" vs listening) and a tap-to-interrupt control that calls the same barge-in path, so
  barge-in works even where AEC doesn't. *Rationale: never make presence depend solely on the
  risky acoustic path.*

### Build & demo order

1. **L1 demo:** kill and restart `jarvisd` mid-session; the `<id>.jsonl` keeps appending to the
   same file. 2. **L2 demo:** refresh the stage mid-conversation; boards + captions repaint, no
   restart. 3. **L3 demo:** have a real session, say "new"; a wiki diff proposal appears; approve
   or ignore. 4. **L4 demo:** with wake word on, ambient talk is ignored until "jarvis …"; in
   speaker mode, talking over Jarvis cuts it off.

## 6. Interruption and barge-in (the full model)

Barge-in is not one feature — it's a pipeline with a *detection* half (when do we believe
Rafe is interrupting?) and a *recovery* half (what does Jarvis do with a turn that was cut
mid-sentence?). The original Layer-4 sketch only named the acoustic problem; review and
discussion surfaced that both halves need spelling out, and that the mechanism to *act* on an
interrupt **already exists and works** — only the trigger and the recovery detail are missing.

### 6.1 What already works (verified in source, 2026-07-03)

The brain-level interrupt is **done**, and it is the real thing — the same primitive Codex /
Copilot-CLI expose, not a kill-and-restart:

- **The brain is a warm stream-json session, not `claude -p` one-shot.** `CliBrain`
  (`apps/jarvisd/src/brain/cli-brain.ts`) spawns one persistent `claude` with
  `--input-format stream-json --output-format stream-json`; turns are `{"type":"user",...}`
  lines on stdin, events stream back on stdout.
- **Interrupt = a control message.** On barge-in, `sendInterrupt()` writes
  `{"type":"control_request","request":{"subtype":"interrupt"}}` to the child. This cancels the
  in-flight generation *mid-agentic-loop* and the child returns a `result` promptly — control
  comes back fast, not after the full turn.
- **The steer lands as the next turn, tagged with what Rafe actually heard.**
  `Session.truncateInterrupted()` asks the **performance queue** which `say` items actually
  reached the speaker (not what the model generated), and prefixes the next user message:
  `[you were interrupted while saying: "<last spoken words, ≤120 chars>"] <new input>`. So the
  model already knows the whole turn didn't play and where it was cut.

**Implication:** "how do we interrupt Claude programmatically" is already answered. The remaining
work is (a) a better *trigger* while speaking (§6.2), and (b) a richer *interrupt note* and a
*resume-or-adapt* decision (§6.3).

### 6.2 Detection: stop fast without stopping on noise

Today the mic is deaf while TTS plays (`main.ts`: `if (player.isPlaying) return`), so speaking —
which can run many seconds — simply cannot be interrupted by voice; the mic gets cut off. That's
the core complaint. The fix must resolve a real tension Rafe named:

> Stop the instant I start talking — **but** don't let a stray word or background audio derail you.

Those pull opposite ways (stop-fast trusts a little audio; stop-safe waits for enough). Resolve
it with **two stages, not one threshold**:

1. **Duck immediately (cheap, reversible).** On the *first* voice-like energy over the AEC-cleaned
   mic (§6.4), drop TTS volume sharply (don't stop) — so Rafe is never fighting to talk over
   Jarvis. Ducking is instantly undoable if it was nothing.
2. **Commit only on confirmed speech (expensive, irreversible).** Escalate to a real interrupt —
   `player.flush()` + `sendInterrupt()` — only after the endpointer sees **sustained speech** past
   a duration/energy gate (a syllable or a cough ducks but never commits). Optionally require the
   committed utterance to also clear the wake-word/relevance bar so an aside to someone else in the
   room ("hang on, I'm on a call") ducks-then-resumes rather than derailing the turn.

This is a state machine — `speaking → ducked → (resume | interrupted)` — living where the mic and
player already coordinate (`apps/stage/src/main.ts`), plus the endpointer's sustained-speech gate
(`apps/stage/src/audio/endpointer.ts`). Ducking needs a `Player.setGain()` (new) alongside the
existing `flush()`.

### 6.3 Recovery: resume-or-adapt, and a richer interrupt note

Once committed, the decision of what to do next is **Jarvis's judgment, not an automatic
discard** — this is the behavior Rafe asked for explicitly:

- If what Rafe said **doesn't change the answer** ("mm-hm", "right", a name correction that
  doesn't alter the point), Jarvis may **resume**: keep playing the remaining generated audio /
  continue the same generation. (Requires holding the interrupted turn's un-played `say` items
  rather than dropping them the instant we duck — see the queue note below.)
- If it **does change things**, Jarvis **adapts** — the interrupt note + new input drive a fresh
  turn, as today.

For that judgment to be sound, the interrupt note must carry **more than the last spoken line**.
Enrich the `[you were interrupted…]` prefix (built in `Session.truncateInterrupted()`) with:
- **How much played vs. remained** — e.g. "you heard 2 of ~5 sentences," so the model knows the
  scale of what was missed, not just the cutoff point.
- **Undiscussed stage state** — if exhibits were shown but never talked through, name them, so the
  model doesn't reference a board Rafe never actually heard explained.
- **Whether a tool call was in flight** at interrupt time (mutate-class especially — a half-issued
  action must not be silently assumed complete).

Queue consequence: to support *resume*, the performance queue must be able to **pause/hold**
un-played items on a duck and either flush-and-drop (on commit-to-interrupt) or resume-from-hold
(on duck-release). Today `queue.interrupt()` only returns what played and drops the rest.

### 6.4 The acoustic layer (unchanged from Layer 4, restated for locality)

All of the above assumes the mic can *hear Rafe over Jarvis's own voice*. That's the
loopback-RTCPeerConnection AEC experiment (§4 Layer 4): route TTS as the far-end reference so the
browser AEC cancels it, leaving only Rafe's voice to drive the §6.2 state machine. AEC remains the
one genuinely uncertain piece (§3 timeboxes it); **headphones full-duplex and a tap/keypress
"interrupt" affordance are the shipped fallbacks** and make §6.2–6.3 usable even if AEC never
lands cleanly. Note the COOP/COEP isolation constraint in §7.

## 7. Hard interactions and residual risks (from adversarial review, 2026-07-03)

Two fresh-context reviewers verified every "current behavior" claim against source. The four
block-worthy findings are folded into §2/§4 above. The following are the cross-cutting
interactions and second-order risks to hold in view during implementation:

- **Wiki proposals are whole-file replacements, and "rebase" is re-diff, not merge**
  (`servers/wiki/src/index.ts`). An ambient draft approved *after* an intervening reactive edit to
  the same page can silently revert that edit — the base-hash check refuses+re-diffs against
  current content, it does not 3-way merge. Mitigation: when a proposal's base-hash was stale and
  it was rebased, the stage diff must say so loudly ("rebased over N changes since drafting") so
  Rafe never approves a clobber blind. The 24h TTL makes this more likely for ambient drafts,
  which are staged at session-end and may sit.
- **Transcript scope + privacy.** Widening `TranscriptEvent` to capture exhibits means full wiki
  bodies, shell output, and browser-read content become durable at `~/.jarvis/sessions` for the
  retention window (0600, fine at rest, but larger blast radius). Rule: **record `ref`, not
  `payload`, whenever a ref exists** — don't duplicate fetched page bodies into the transcript.
  And the Layer-3 inline transcript goes to the tier-2 child on **stdin, never argv**.
- **Idle backstop vs. in-flight tier-2 tasks.** Tasks carry no session association today
  (`bg${n}` counters). If Rafe dispatches a 15-min background task and walks off, the idle timer
  could draft on an incomplete story *and* `brain.reset()` out from under a pending
  `announceWhenIdle` that's still waiting to speak the result. Fix: tag background tasks with the
  session id; the idle backstop **defers** (not skips) session-end until they drain, and
  `endSession()` decides the fate of a pending idle announcement (let it finish, then close).
- **Crash-resume vs. fresh-start.** A `kill -9` leaves `~/.jarvis/sessions/current` with no
  `session.end` stamp. On construct, if the resumed session's last event is older than
  `IDLE_SESSION_END_MS`, **close it and start fresh** rather than resurrecting a dead session.
  Note `MemoryStore` is constructed once at boot and never again in-process, so `endSession()`
  mutates the live store's id/file **in place** — there is no "next construction."
- **AEC under cross-origin isolation.** The stage runs COOP/COEP (`require-corp`, for the Silero
  VAD worker) with two separate AudioContexts (mic ~48k, player 24k). Routing player output into a
  loopback peer connection whose remote track feeds the mic graph, all under COEP, is exactly where
  things fail silently. Treat the isolation context as part of the AEC timebox risk.

## 8. Open items to settle during implementation (not blockers)

- Replay transcript-tail length: full session vs last N turns (favor a bounded tail; the JSONL is
  the full record, the stage only needs recent captions).
- Whether `session.replay` should also restore `quiet` mode / orb state (probably yes — cheap).
- Ambient-draft prompt calibration: how conservative is "durably true about Rafe"? Start strict,
  loosen on observed false-proposal rate. Log every proposal (accepted/ignored) for tuning.
- Wake-word false-negative cost: Whisper mis-transcribing "jarvis" drops a turn silently. Mitigate
  with a small accepted-variant set ("jarvis", "hey jarvis", "travis"?) — measure before padding.
- Idle backstop interacting with tier-2 tasks: don't fire an ambient draft while a tier-2 task
  from the same session is still running.

---

# Part II — Observability & interactive subagents (added 2026-07-03, Rafe's direction)

## II.0 Framing

Two capabilities that share one substrate with Part I:

- **Activity** — a complete, persisted, clearly viewable log of *everything Jarvis does*: spoken
  lines, private thinking, every tool call **with its input and output**, and every subagent's
  step-by-step work. It replaces today's near-blind, fully-ephemeral activity tab.
- **Interactive subagents** — tier-2 background tasks promoted from fire-and-forget one-shots to
  **addressable, long-lived agents** that the model *and Rafe* can start, message, poll, read, and
  stop — with their full work visible in Activity.

The unifying insight, stated up front so the implementation doesn't grow two parallel systems:

- **Activity is Layer 1's durable log, widened.** One JSONL per session becomes the single record,
  and the stage renders **three projections** of it — the clean *conversation*, the full
  *activity*, and the *replay* snapshot (Layer 2). No second store.
- **Interactive subagents are the tier-2 substrate Layer 3 already uses, made first-class.** Because
  jarvisd owns each subagent's `stream-json` child, Activity gets its work *for free* (it's the same
  parse tier-1 gets), and ambient drafting (Layer 3) + the idle backstop (§7) inherit real
  status/lifecycle instead of the `bg${n}` black boxes they currently complain about.

**Decision recorded (Rafe, 2026-07-03): only tier-2 subagents; never the tier-1 in-turn Agent
tool.** A tier-1 and a tier-2 subagent are the same idea — delegate to another agent — so we build
one, well, and make it good enough that the conversation brain never needs an in-turn fan-out.
Rationale in II.7.

## II.1 The two gaps (current behavior, read from source 2026-07-03)

Both gaps have the *same shape*: jarvisd already sees the full stream and discards it.

**Gap A — Activity is nearly blind and fully ephemeral.**
- The tab exists (`apps/stage/src/ui/activity.ts`) but shows only turn dividers, one evolving
  *thought* line per turn, `act`-item markers, and warnings.
- On the **default CLI path**, real tool calls are **not** structured events: `cli-brain.ts`
  surfaces only `onToolCall(name)` (name — no input, no result), and `session.ts` mashes it into the
  dim thought line as `› toolname`. Tool **inputs and outputs are never captured** — `cli-brain.ts`
  runs its incremental JSON extractor on the *say* tool's text only.
- **Nothing is persisted.** `MemoryStore.append` writes only `user/assistant/interrupt/system` text
  lines; thoughts, tool calls, and exhibits never hit disk. A stage refresh paints the activity tab
  blank (Layer 2 replays exhibits + captions, not activity).

**Gap B — subagents are black boxes.**
- `dispatch_background(task)` → `CliBackground` (`bg-cli.ts`) spawns a **detached one-shot**
  `claude -p`, 15-min hard timeout, and **discards everything except staged proposal ids + the final
  result string**. Every intermediate tool call and every line of thinking is parsed off the stream
  (the loop already reads `stream-json`) and thrown away.
- Tasks carry **no identity beyond `bg${n}`**, no status query, no way to be messaged, and no
  lifecycle other than run-to-completion-or-timeout. Part I §7 already lists this as a hazard.

## II.2 Data model — one event, one log, three projections

Define a single rich **`ActivityEvent`** (Zod, `packages/protocol`) that is *both* the on-disk
record and the wire payload. It **supersedes and absorbs** the ad-hoc `TranscriptEvent` widening
proposed in Part I Layer 1 — do that widening *as* `ActivityEvent`, once.

```
ActivityEvent = {
  id: string        // monotonic within a session — the ORDERING KEY (not wall-clock `at`,
                    // which collides across the main child and subagent children)
  at: string        // ISO-8601, for display
  session: string   // stable session id (Layer 1)
  agent: string     // "main" | subagent id (e.g. "sub_3")  — WHO did it; the nesting axis
  turn?: string     // owning tier-1 turnId  <session>-<n>  (Layer 1 fix)
  parent?: string   // for a subagent event: the tier-1 turn that spawned the subagent
} & (
  | { kind:"turn",     phase:"begin"|"end", source:"voice"|"text" }
  | { kind:"heard",    text }
  | { kind:"say",      text }
  | { kind:"think",    text }                        // periodic TAIL snapshot, not deltas
  | { kind:"exhibit",  op:"show"|"update"|"dismiss", exhibitId, type?, title?, ref? }
  | { kind:"tool",     callId, name, input?, status:"running"|"ok"|"error",
                       output?, durationMs? }        // ONE event, resolves in place
  | { kind:"subagent", op:"start"|"instruct"|"status"|"done"|"error"|"closed",
                       subId, label?, model?, instruction?, summary? }
  | { kind:"note",     level:"info"|"warn"|"error", text }
)
```

Modeling choices that carry weight:

- **A tool is one event that resolves in place**, not a call-event plus a result-event. jarvisd
  holds the open `tool` event keyed by `callId` (the `tool_use` block id), fills
  `output`/`status`/`durationMs` when the matching `tool_result` arrives, and re-emits. The stage
  **upserts by `callId`**. That is what lets a single row animate `running… → ok · 40ms` instead of
  spawning a second line.
- **`agent` is the entire subagent-visibility mechanism.** `"main"` events form the tier-1 timeline;
  a subagent's events carry `agent:"sub_3"` + `parent:` the spawning turn, so the stage renders them
  *inside that turn's subagent card*. No separate stream, no second socket — just a tag.
- **`think` is a debounced tail snapshot** (last ~600 chars), matching `session.ts`'s existing
  250 ms-debounced thought push; the wire already sends cumulative tail text, so persisting raw
  deltas would staircase.
- Persist **`ref`, not `payload`** for exhibits (Part I §7 privacy rule). Tool `output` is the new,
  *larger* blast radius — see II.8.

**One JSONL per session** (`~/.jarvis/sessions/<id>.jsonl`, 0600) is the single durable record.
`MemoryStore` becomes its one appender. Three projections read it: **conversation** (`heard`+`say`
+`exhibit`), **activity** (everything), **replay** (Layer 2's live-exhibit registry + caption tail).

## II.3 Capturing it in jarvisd

**Tier-1 (`cli-brain.ts` + `session.ts`).** Widen `BrainCallbacks`:
- `onToolCall(callId, name, input)` — accumulate `input_json_delta` for **every** non-`say`
  `tool_use` block (keyed content-block index → id), JSON-parse at `content_block_stop`, emit a
  `running` tool event. *(Confirmed 2026-07-03: tool inputs are **not** present on
  `content_block_start`; they arrive only as `input_json_delta` fragments and are complete at
  `content_block_stop`. The extractor `cli-brain.ts` already runs on the say tool generalizes to a
  buffer-per-block.)*
- `onToolResult(callId, name, output, isError, durationMs)` — correlate the `tool_result` (id→name
  is already tracked in `toolNames`) and resolve the open event.

`session.ts` forwards these to the sink as `ActivityEvent`s and **stops mashing tool names into the
thought line** — thoughts and tools become distinct, typed rows.

**Redaction reused.** Captured tool outputs pass the same **secret-shape redaction**
(`mcp/context.ts`) already applied to the utterance bundle before egress — so `cat .env` in captured
Bash output is caught by the same net at the same honest caveat (accident net, not guarantee).

## II.4 The UI (redesign — "really clear")

An interactive mock was built and reviewed 2026-07-03; it reuses the stage palette verbatim so it
translates straight to CSS. Shape:

```
┌ conversation · [activity] · wiki ································· ⤢ ┐
│ [All 14] [Tools 7] [Thinking 3] [Subagents 1] [Errors 1]   ▾session ● live │
├───────────────────────────────────────────────────────────────────┤
│ ▾ 🎙voice  "what do I know about agentd?"          14:22  4.2s  ● │  ← turn card
│   │ ▎ Here's your agentd page.                             +0.0s   │  (collapsible)
│   │ 📖 wiki_read  projects/agentd.md            [ok · 40ms] +0.3s   │  ← click row →
│   │      ⤷ input {…}   result 2.1 kB  ┄┄ (expands in place)         │    input+output
│   │ ◇ deciding whether to surface the squad link… keep it tight     │  ← thinking (dim)
│   │ ▎ It's your always-warm agent daemon…                  +1.1s   │
│ ▾ ⌨text   "reorganize the wiki's project pages"    14:31  running ◔ │
│   │ ▎ I'll hand it to the background worker…                +0.0s   │
│   │ ⤴ dispatch_background  reorganize…              [sub_3] +0.6s   │
│   │ ┌ ⤳ background · reorganize project pages ······ 4/6 ▰▰▰▰▱▱ ┐  │  ← SUBAGENT card
│   │ │   sub_3 · opus-4.8 · thinking xhigh · 1m47s              │  │    (violet rail;
│   │ │   📖 wiki_list projects/         [ok · 12 pages]  0:04   │  │     nested timeline
│   │ │   ◇ bucketing pages by status before the index…  0:09   │  │     of ITS tools)
│   │ │   📝 wiki_propose_edit projects/index.md  [p7a2]  1:12   │  │
│   │ │   📝 wiki_propose_edit …lobs-voice.md   [running…] 1:47   │  │
│   │ │   ◷ 2 edits staged so far — you'll approve each diff      │  │
│   │ └──────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
```

Principles (a UI that's *scanned and operated*, not read):
- **Turn-grouped, collapsible timeline.** Each turn is a card: time · voice/text chip · Rafe's
  words · duration · status dot (running/ok/error). Everything Jarvis did in that turn nests under it
  on a single vertical rail.
- **Typed rows, state encoded in form.** `▎` spoken (ink) · `◇` thinking (dim italic, one line,
  click to expand) · tool rows (icon by class — `⌘` shell, `📖` wiki read, `🌐` web, `🖥` browser,
  `📝` wiki edit, `⤴` dispatch — + name + one-line input summary + a status **chip**
  `running…`/`ok · 40ms`/`exit 1`). Click a tool row to expand its **full input and output** inline.
- **A subagent is a nested card, not a line.** Its own header (label · model · thinking · elapsed ·
  a `k/n tools` progress bar), its own indented timeline of *its* tool calls and thinking, in a
  distinct **violet** rail — the one deliberate new palette hue, because a subagent is *another
  mind* and the stage palette had no color for it. This is the literal answer to "see what the
  subagents are doing," at full step-by-step fidelity.
- **Persisted & reloaded.** On connect the panel backfills from the session's `ActivityEvent` tail
  (II.8) so a refresh never blanks it; a **session picker** opens older sessions read-only; a **live**
  indicator + auto-tail (with "jump to live" when scrolled up).
- **Filter chips** (All / Tools / Thinking / Subagents / Errors) and an **expand-to-full-width**
  affordance — the side panel is narrow; a dense nested timeline earns width on demand.
- **Semantic color is separate from the accent.** running = sky, ok = teal-dim, error = err(red);
  the teal accent and violet subagent hue are structure, not status.

## II.5 Interactive subagents (tier-2 as addressable agents)

**The core change:** a tier-2 subagent stops being a one-shot `claude -p` and becomes a **persistent
`stream-json` child** — the same process shape as `CliBrain`'s warm tier-1 child
(`--input-format stream-json --output-format stream-json --include-partial-messages`), but
background (no voice budget) and with the tier-2 toolset. jarvisd holds it open, writes follow-up
user messages to its stdin, and parses its full event stream into `ActivityEvent`s tagged
`agent:"sub_N"`.

**Refactor, don't fork.** `CliBrain`'s child-spawn + `stream-json` parse guts (`ensureChild`,
`onStdout`/`onEvent`, the interrupt control-request, the input-json extractor) are extracted into a
shared **`PersistentClaude`** primitive. Tier-1 is one instance (say tool + voice wiring); each
subagent is one instance (no say tool, reduced toolset, output-as-report). A new **`SubagentManager`**
(jarvisd) owns the pool, ids, lifecycle, and the activity fan-out. `bg-cli.ts` and the SDK
`BackgroundRunner` collapse into this.

**Model-facing API** — extend the `tasks` MCP server → a jarvisd `/subagents` HTTP control endpoint
(the same thin-proxy pattern `settings` and `tasks` already use; jarvisd stays the single owner).
Mirrors this harness's own Agent + SendMessage:

| tool | effect |
|---|---|
| `subagent_start(task, label?)` → `{id}` | spawn a subagent. **Supersedes `dispatch_background`; keep that name as an alias** so existing prompt text keeps working. |
| `subagent_send(id, message)` | send a follow-up question/instruction to a live subagent. **Async** — returns "sent"; the answer surfaces via the idle channel + Activity, not inline. |
| `subagent_status(id?)` | one subagent, or the whole pool: state, current instruction, elapsed, tool count, last line. |
| `subagent_result(id)` | the latest report/answer text. |
| `subagent_stop(id)` | terminate. |

**Notification, never interruption.** A subagent finishing an instruction (or answering a `send`)
**never grabs the voice mid-performance** — it enqueues through the existing `announceWhenIdle`
idle-channel drain (original design §Tier-2 voice arbitration), and the tier-1 model is told on its
*next* turn via a synthetic system line ("sub_3 finished: …"), the same mechanism barge-in already
uses to reconcile the model. Activity is the always-live, non-intrusive channel; voice is
best-effort-when-idle.

**Lifecycle & bounds.**
- States: `starting → working → idle(alive, awaiting) → closed | failed | timed-out`. **"idle"
  (instruction done, process warm, ready for a follow-up) is distinct from "closed" (process gone)**
  — that distinction *is* the interactivity, and it's what the current one-shot cannot express.
- The 15-min hard timeout becomes an **idle-TTL** (reap after N min warm with no pending
  instruction) + a hard max lifetime + explicit `subagent_stop`.
- A **concurrency cap** (default ~3 live subagents) bounds resource use; `start` past the cap queues
  or refuses with a clear message (and Activity says so — no silent drop).
- Subagents are **session-scoped** and tagged with the session id — which directly fixes Part I §7's
  "tasks carry no session association," so `endSession()` / the idle backstop can *query and defer*
  against real state instead of guessing.

**Human-facing controls.** The Activity subagent card exposes the same verbs to Rafe: a message box
(→ `subagent_send`), a **Stop** button (→ `subagent_stop`), and live status — so Rafe can steer or
kill a background agent by hand, not only through the model.

## II.6 Toolset & the security line ("same functionality" — read carefully)

Rafe's ask: tier-2 subagents should have "the same functionality as Claude's tier-1 subagents."
Precisely — the same **interaction model** (start / message / poll / read / stop / watch, II.5), **not
necessarily the same tool grants.** The original design §Security deliberately gives tier-2 no
actuators: *"an injected instruction that survives into a background task finds no actuator and no
unreviewed write path."* That guarantee is load-bearing and stays.

But the *useful* power of a tier-1 Agent-tool subagent is mostly **parallel reading, searching, and
running the shell**, and today's tier-2 can't even read a file (`bg-cli.ts`: `wiki_*` + web only; no
`Read`, no `Bash`) — which cripples research. So widen tier-2 to **read and run broadly; gate only
the reviewed writers**:

- **Grant:** `Bash`, `Read`, `Grep`, `Glob`, `WebSearch`, `WebFetch`, `wiki_search`/`read`/`list`,
  `wiki_propose_edit` (stage only).
- **Withhold (unchanged):** `wiki_commit`, all browser *hands*, `Edit`/`Write`/`NotebookEdit`. World
  mutation still routes *only* through the propose → confirm → commit gate jarvisd owns.
- **`Bash` is on by default (Rafe's call, 2026-07-03).** A background agent that can't run the shell
  is crippled for exactly the research it exists to do; tier-1 already runs Bash unconfined
  (`bypassPermissions` — "ask before destructive" is a *prompt norm*, not a gate), and the same
  posture now extends to tier-2. The honest cost, recorded plainly: tier-2 is **unattended** *and*
  the agent an injected web page survives into, so a successful injection could run a destructive or
  exfiltrating command with no human watching — a real extension of the injection-to-action surface
  the original §Security had narrowed. What makes it acceptable rather than reckless is that **the
  Activity feature is itself the mitigation**: every background command and its output now streams
  into a watchable, persisted timeline, and `subagent_stop` is one click — background shell stops
  being invisible. An opt-**out** flag (`SUBAGENT_BASH=off`) exists for a session where that surface
  isn't wanted.

Guardrail, restated honestly now that Bash is in: the line held is **no unattended path to a
*reviewed* writer** — `wiki_commit` and browser *hands* never enter the tier-2 grant, so every
world-write still lands as a diff or an act Rafe confirms. Bash is accepted as
unconfined-but-**observable** (Activity + `subagent_stop`), matching tier-1's standing posture — it
is not laundered as "safe."

## II.7 Alternatives (extends §3)

| Alternative | Why rejected |
|---|---|
| **Enable the tier-1 in-turn Agent tool** (Claude Code's `Agent`/`Task` for the conversation brain) | Rejected (Rafe, 2026-07-03). (1) **Not observable** — verified against the Agent-SDK docs 2026-07-03: Claude Code forwards a subagent's *launch and final result* to the parent stream but **not its intermediate tool calls or token deltas** ("stream events are emitted for the main session only"). Activity could show "launched Agent → result" but never the step-by-step work that is the whole point; a jarvisd-owned tier-2 child gives full fidelity. (2) **Redundant** — tier-1 and tier-2 subagents are the same idea; two of them doubles the surface for no gain. Make tier-2 good enough. (Original design also deferred a "subagent forest in v0.") |
| **Keep tier-2 one-shot; add only status/result polling** | Rejected. "Message a running task" is what makes a background agent feel like a colleague instead of a form submission, and it *requires* a persistent, addressable child. Polling a corpse yields a status string, not a conversation. |
| **A separate activity store / second JSONL** | Rejected. Activity, conversation, and replay are three views of one event history; two stores would drift and double the privacy blast radius. One log, three projections (II.2). |
| **Blocking `subagent_send` (return the answer inline)** | Rejected as the default. Simple for the model, but it stalls the tier-1 turn on background-length work — the exact dead air the two-tier split exists to avoid. Async + idle-channel notification keeps the voice responsive; a short bounded `wait` remains available for genuinely quick asks. |

## II.8 Hard interactions & residual risks (extends §7)

- **Unattended Bash is a real, accepted surface (II.6).** With `Bash` in the tier-2 grant, an
  injected instruction that survives into a background agent can run a destructive or exfiltrating
  shell command with no human in the loop — the original §Security explicitly avoided this for
  tier-2. Rafe accepts it (2026-07-03) on the strength of three things, none of which is "injection
  won't happen": world-*writes* stay gated (no `wiki_commit`/browser hands — the only mutations that
  land do so as confirmed diffs/acts); captured output runs the secret-shape redaction; and **Activity
  makes background shell observable** rather than invisible, with `subagent_stop` always live. This is
  the single biggest security delta from the original design and is called out here so it is a
  *decision*, not a drift. `SUBAGENT_BASH=off` reverts to the read-only posture per session.
- **Privacy blast radius grows again.** Activity persists **tool outputs** — shell stdout, wiki
  bodies, web fetches — a larger durable surface than Part I's exhibit-payload concern. Same 0600 +
  retention prune, same secret-shape redaction as egress, same honest caveat (accident net). Bound
  it: above a size cap, record **length + hash + a truncated head**, not the full body; consider a
  per-session "don't record tool outputs" toggle for sensitive work.
- **Persistent subagents vs. "settings apply live."** `model_tier2`/`thinking_tier2` apply live
  *today* only because each task is a fresh child (`main.ts`). With persistent children, a running
  subagent keeps its spawn-time model until it closes — settings bind the *next* `subagent_start`.
  State it so the settings UI's "applies live" note stays honest (true for new subagents; running
  ones are frozen, exactly like tier-1's deferred restart).
- **`endSession()` / idle backstop now have real state to honor.** Part I §7 feared the idle timer
  could `brain.reset()` out from under an in-flight `bg${n}`. With session-scoped subagents exposing
  status, `endSession()` **defers** until the pool drains (or stops them explicitly and records it) —
  the hazard becomes a query, not a guess.
- **Multi-tab upsert.** The `/ws` broadcast bus means N tabs each render the stream; a resolving tool
  event (running→ok) must **upsert by `callId`** in every tab, and a tab connecting mid-tool must get
  the open event in its backfill or never see the resolution. Backfill = the session's recent
  `ActivityEvent` tail (bounded), same clean-cut-at-turn-boundary rule as Layer 2 replay.
- **Cross-agent ordering.** Interleaved main + subagent events sort by the monotonic `id`, **not**
  wall-clock `at` (which collides across processes); each subagent card orders its own children
  independently of the main timeline.

## II.9 Detailed implementation (files, matching §4 style)

- **`packages/protocol/src/activity.ts` (new).** `ActivityEvent` Zod union (II.2); re-export from
  `index.ts`. **`wire.ts` (change):** add server→stage `{type:"activity", event: ActivityEvent}`
  (live) and fold Layer 1's `TranscriptEvent` widening into `ActivityEvent`. `subagent`-card control
  from the stage rides existing message shapes where possible.
- **`apps/jarvisd/src/memory/store.ts` (change).** Become the single `ActivityEvent` appender (this
  **is** Layer 1's store change — do it once). Stable session id, `close()`/`rotate()`, prune by
  session-end mtime — all as Layer 1 specifies.
- **`apps/jarvisd/src/brain/cli-brain.ts` (change).** Capture non-`say` tool inputs (buffer
  `input_json_delta` per block, parse at stop) + correlate results; widen `BrainCallbacks`
  (`port.ts`) to `onToolCall(callId,name,input)` / `onToolResult(callId,name,output,isError,ms)`.
- **`apps/jarvisd/src/brain/persistent-claude.ts` (new).** Extracted child-spawn + `stream-json`
  parse primitive shared by `CliBrain` and subagents.
- **`apps/jarvisd/src/subagents/manager.ts` (new).** `SubagentManager`: pool, ids/labels, states,
  idle-TTL + max-life + concurrency cap, activity fan-out (`agent:"sub_N"`), `announceWhenIdle`
  integration, session tagging. **Replaces `bg-cli.ts` + `tasks.ts`'s `BackgroundRunner`.**
- **`apps/jarvisd/src/main.ts` (change).** `/subagents` HTTP control endpoint (start/send/status/
  result/stop); wire `SubagentManager` in place of `CliBackground`/`BackgroundRunner`; keep
  `/tasks` as an alias to `start`.
- **`servers/tasks/src/index.ts` (change).** Add `subagent_send`/`subagent_status`/`subagent_result`/
  `subagent_stop` tools alongside `subagent_start` (thin proxies to `/subagents`); `dispatch_background`
  aliases `subagent_start`. Add these to `CLI_ALLOWED`.
- **`apps/jarvisd/src/session.ts` (change).** Emit `ActivityEvent`s at each sink send; live-exhibit
  registry (Layer 1); stop folding tools into `thought`.
- **`apps/stage/src/ui/activity.ts` (rewrite).** Turn-grouped collapsible timeline; typed rows;
  tool-row expand (input/output); nested subagent cards with their own timelines + message/stop
  controls; filter chips; session picker; live-tail; upsert-by-`callId`. **`styles.css` (change):**
  `--agent` violet hue; the row/card/chip styles.
- **`apps/stage/src/main.ts` + `wire.ts` (change).** Consume `activity` events; backfill on connect;
  render subagent controls. **jarvisd `GET /sessions` + `GET /activity?session=<id>&limit=` (new).**

## II.10 Open items (extends §8)

- `subagent_send` reply routing: pure idle-announcement vs. also a short bounded inline `wait` for
  quick asks — pick on feel once one subagent conversation exists.
- Subagent naming: model-minted `label` vs. `sub_N` — labels read better in Activity; validate and
  uniquify them.
- Concurrency-cap value, and whether `start` past the cap queues or refuses.
- Activity retention vs. transcript retention — same window, or shorter for the heavier
  tool-output log?
- Whether the **conversation** view should also migrate to consume `ActivityEvent`s (dedupe the say
  path) or keep today's `item`/`heard` messages (less churn) — the mock keeps both; revisit after
  the activity view lands.
- Build order: **Activity capture+persist+UI first** (it makes the subagent work *visible* while you
  build it), then the persistent-child/`SubagentManager` refactor, then the interactive tools. Each
  step ends in a demo, per the doc's milestone discipline.
