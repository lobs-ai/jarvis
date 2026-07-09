# Observability: giving Jarvis a live view of Rafe's world

Goal: make the *co-working* feel like Jarvis — me being a step ahead on real work.
That requires shared gaze: I see your terminals and your real browser as you work.
Two surfaces only, by decision: **tmux** and **Chrome**. Screen pixels and app-title
are explicitly out of scope for now.

## The extension point we already have

`apps/jarvisd/src/mcp/manager.ts` auto-discovers any MCP tool named `*_context`
(`collectContext()`), fans them out every turn, and wraps the results as untrusted
observed world-state. So **any richer `_context` tool automatically joins the per-turn
bundle** — no new plumbing to be seen live. This is the whole reason the plan is cheap.

Today:
- `terminal_context` — tmux `capture-pane -p -S -80`, **active pane only** (falls back to
  iTerm/Terminal.app AppleScript).
- `browser_context` — AppleScript on the real Chrome: **front window's active tab only**
  (url/title/selection, innerText ≤4000 chars). Hands stay on the Jarvis-owned :9222 profile.

## Phase 1 — widen the terminal (≈½ day)

Enumerate every pane instead of just the focused one:
- `tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} #{pane_current_command} #{pane_current_path} #{?pane_active,ACTIVE,}'`
- `capture-pane -p -t <id> -S -N` per pane; label each block with session:window.pane + cmd + cwd.
- Bound cost: cap per-pane lines (~40) and total (~600) so a wall of panes can't blow the bundle.
- Active pane gets the full tail; background panes get a shorter tail.

Deliverable: `terminal_context` shows all my panes, labeled. Same tool, richer body.

## Phase 2 — widen Chrome, zero-install (≈½ day)

AppleScript can already enumerate `every tab of every window` for url+title cheaply.
- List all tabs (url/title, mark the active one) + keep full content for the active tab.
- No install, no new trust. Immediate step up from "front tab only" and buys time for Phase 3.

Deliverable: I see your whole tab set, not just the front one.

## Phase 3 — Chrome extension, the real thing (≈2–3 days)

The useful version Rafe wants: full page **content** across his real browsing, event-driven.
- Unpacked extension in his everyday profile. Background service worker subscribes to
  `tabs.onActivated` / `tabs.onUpdated`; content script extracts readable text (Readability).
- Extension POSTs tab state → a localhost receiver in the browser server. `browser_context`
  reads the cached store (AppleScript fallback if the extension is disconnected).
- Same store later feeds the heartbeat journal — build the pipe once, both clocks drink from it.

Deliverable: live, full-content view of the real browser, pushed not polled.

## Phase 4 — continuous streams for the heartbeat (later)

Only when we build the second clock:
- tmux `pipe-pane` → rolling per-pane logs on disk.
- extension push → rolling world-state journal.
Not needed for the live "step ahead" experiment; this is the substrate for background work.

## Decisions Rafe owns

1. **Chrome privacy scope.** The extension sees everything. Origin allowlist (github/docs/dev
   yes) vs denylist (banking/email/DMs no), plus a visible on/off toggle. Pick the model.
2. **Terminal budget.** Confirm per-pane (~40) and total (~600) line caps.
3. **Security posture.** Keep hands-on-:9222 vs eyes-on-real-Chrome split intact; the extension
   is read-only reporting, never a control channel.

## Sequencing

Phases 1→2 land shared gaze this week for the co-working experiment. Phase 3 is the real
investment. Phase 4 waits for the heartbeat. Nothing here rebuilds the heartbeat you already
have in lobs — it's purely the eyes that feed it.
