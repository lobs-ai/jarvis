import type { Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  ClientMessage,
  encodeBinaryFrame,
  decodeBinaryFrame,
  type ActivityEvent,
  type ServerMessage,
  type PerformanceItem,
  type SettingsPatch,
  type SettingsSnapshot,
} from "@jarvis/protocol";
import type { Session, SessionSink } from "./session.js";

type Orb = Parameters<SessionSink["sendState"]>[0];

// Broadcast bus: every open /ws connection is a live stage. All SessionSink
// sends fan out to every open socket; input is accepted from any of them.
//
// (This replaced an "audience of one" design where each new connection closed
// the previous — an open browser tab would steal the socket from a test client,
// and two tabs thrashed by replacing each other on reconnect.) Consequence: a
// text turn typed in one tab shows up in all of them, and say/audio output
// plays through the speakers of EVERY open tab.
export class StageSocket implements SessionSink {
  private sockets = new Set<WebSocket>();
  private session: Session | null = null;
  private audioStreamCounter = 0;
  private lastOrb: Orb | null = null;
  // played acks are deduped per turn: with N tabs, every say item is acked N
  // times (once per tab that played it). Keyed turnId:seq; cleared at each
  // turn.begin (seqs restart per turn), so session.ack fires exactly once.
  private ackedThisTurn = new Set<string>();

  attach(server: HttpServer): void {
    const wss = new WebSocketServer({ server, path: "/ws" });
    wss.on("connection", (ws) => {
      // Do NOT close existing connections — this tab joins the audience.
      this.sockets.add(ws);
      ws.binaryType = "arraybuffer";
      ws.on("message", (data, isBinary) => this.onMessage(data as ArrayBuffer | string, isBinary));
      const drop = (): void => {
        this.sockets.delete(ws);
      };
      ws.on("close", drop);
      ws.on("error", drop);
      // Per-socket welcome: the new tab must learn the current orb state even
      // when it equals lastOrb (which the broadcast dedupe would swallow), so
      // this goes straight to the new socket and bypasses sendState's dedupe.
      this.sendTo(ws, { type: "state", orb: this.lastOrb ?? "idle" });
      // Layer 2 replay-on-connect: repaint the conversation-so-far (live
      // exhibits + activity tail) on the NEW socket only — the broadcast bus
      // already keeps everyone else current, and replay never carries audio.
      if (this.session) this.sendTo(ws, this.session.replaySnapshot());
      this.onConnect?.(); // main pushes a settings snapshot; broadcasting it is fine
    });
  }

  bind(session: Session): void {
    this.session = session;
  }

  private onMessage(data: ArrayBuffer | string, isBinary: boolean): void {
    const session = this.session;
    if (!session) return;
    if (isBinary) {
      // Mic frames are accepted from any socket. In practice only one tab has
      // its mic on, so no arbitration is needed; two live mics would interleave
      // their PCM into one utterance buffer — a documented limitation, not a
      // supported mode.
      const { pcm } = decodeBinaryFrame(data as ArrayBuffer);
      session.micFrame(pcm);
      return;
    }
    let msg: ClientMessage;
    try {
      msg = ClientMessage.parse(JSON.parse(String(data)));
    } catch {
      this.sendWarning("unparseable client message");
      return;
    }
    switch (msg.type) {
      case "hello":
        session.setQuiet(msg.quiet);
        break;
      case "text.input":
        session.handleTextInput(msg.text);
        break;
      case "mic.begin":
        session.micBegin();
        break;
      case "mic.end":
        void session.micEnd();
        break;
      case "mic.cancel":
        session.micCancel();
        break;
      case "quiet.set":
        session.setQuiet(msg.quiet);
        break;
      case "interrupt":
        session.interrupt();
        break;
      case "played": {
        // Drop duplicate acks: with multiple tabs the same say item is reported
        // played once per tab. Only the first reaches the queue's pacing.
        const key = `${msg.turnId}:${msg.seq}`;
        if (this.ackedThisTurn.has(key)) break;
        this.ackedThisTurn.add(key);
        session.ack(msg.seq);
        break;
      }
      case "confirm":
        this.onConfirm?.(msg.confirmId, msg.approve);
        break;
      case "session.new":
        this.onSessionNew?.();
        break;
      case "settings.get":
        this.onSettingsGet?.();
        break;
      case "settings.set":
        this.onSettingsSet?.(msg.patch);
        break;
      case "subagent.send":
        this.onSubagentSend?.(msg.id, msg.message);
        break;
      case "subagent.stop":
        this.onSubagentStop?.(msg.id);
        break;
      case "stage.fault":
        session.reportStageFault(msg.kind, msg.detail, msg.turnId);
        break;
    }
  }

  // wired by the confirmation broker (M2+ wiki commits, M4 mutate acts)
  onConfirm: ((confirmId: string, approve: boolean) => void) | null = null;
  // wired by main: settings + conversation lifecycle (jarvisd owns both)
  onConnect: (() => void) | null = null;
  onSessionNew: (() => void) | null = null;
  onSettingsGet: (() => void) | null = null;
  onSettingsSet: ((patch: SettingsPatch) => void) | null = null;
  // human-facing subagent controls from the activity panel (§II.5)
  onSubagentSend: ((id: string, message: string) => void) | null = null;
  onSubagentStop: ((id: string) => void) | null = null;

  private broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.sockets) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  private broadcastBinary(frame: Uint8Array): void {
    for (const ws of this.sockets) {
      if (ws.readyState === WebSocket.OPEN) ws.send(frame);
    }
  }

  private sendTo(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  // ── SessionSink ──────────────────────────────────────────────
  sendItem(item: PerformanceItem): void {
    this.broadcast({ type: "item", item });
  }

  sendAudio(turnId: string, seq: number, pcm: Uint8Array): void {
    const streamId = ++this.audioStreamCounter;
    // Announce then send the frame. Per socket these keep their order (each
    // connection's send queue is FIFO), so the stage's audioMeta[streamId] is
    // always set by the audio.segment before its binary frame arrives — the
    // ordering assumption holds even though both messages are broadcast.
    this.broadcast({
      type: "audio.segment",
      turnId,
      seq,
      streamId,
      sampleRate: 24000,
      bytes: pcm.byteLength,
    });
    this.broadcastBinary(encodeBinaryFrame(streamId, seq, pcm));
  }

  sendWarning(message: string): void {
    this.broadcast({ type: "error", message });
  }

  sendState(orb: Orb): void {
    if (orb === this.lastOrb) return; // dedupe: state is re-asserted on every token
    this.lastOrb = orb;
    this.broadcast({ type: "state", orb });
  }

  sendBarge(verdict: "cut" | "resume"): void {
    this.broadcast({ type: "barge", verdict });
  }

  sendTurnBegin(turnId: string, source: "voice" | "text"): void {
    this.ackedThisTurn.clear(); // new turn: seqs restart, so drop last turn's ack keys
    this.broadcast({ type: "turn.begin", turnId, source });
  }

  sendTurnEnd(turnId: string): void {
    this.broadcast({ type: "turn.end", turnId });
  }

  sendHeard(turnId: string, text: string): void {
    this.broadcast({ type: "heard", turnId, text });
  }

  sendThought(turnId: string, text: string): void {
    this.broadcast({ type: "thought", turnId, text });
  }

  sendActivity(event: ActivityEvent): void {
    this.broadcast({ type: "activity", event });
  }

  hasAudience(): boolean {
    for (const ws of this.sockets) {
      if (ws.readyState === WebSocket.OPEN) return true;
    }
    return false;
  }

  sendConfirmRequest(
    confirmId: string,
    summary: string,
    detail: string | undefined,
    phrases: string[],
  ): void {
    this.broadcast({ type: "confirm.request", confirmId, summary, detail, phrases });
  }

  sendConfirmResolved(confirmId: string, approved: boolean): void {
    this.broadcast({ type: "confirm.resolved", confirmId, approved });
  }

  sendSessionReset(): void {
    this.broadcast({ type: "session.reset" });
  }

  sendSettings(settings: SettingsSnapshot, note?: string): void {
    this.broadcast({ type: "settings", settings, note });
  }
}
