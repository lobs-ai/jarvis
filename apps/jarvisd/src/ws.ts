import type { Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  ClientMessage,
  encodeBinaryFrame,
  decodeBinaryFrame,
  type ServerMessage,
  type PerformanceItem,
} from "@jarvis/protocol";
import type { Session, SessionSink } from "./session.js";

// Audience of one: a single stage connection; a new one replaces the old.
export class StageSocket implements SessionSink {
  private ws: WebSocket | null = null;
  private session: Session | null = null;
  private audioStreamCounter = 0;

  attach(server: HttpServer): void {
    const wss = new WebSocketServer({ server, path: "/ws" });
    wss.on("connection", (ws) => {
      this.ws?.close(4000, "replaced by a newer stage connection");
      this.ws = ws;
      ws.binaryType = "arraybuffer";
      ws.on("message", (data, isBinary) => this.onMessage(data as ArrayBuffer | string, isBinary));
      ws.on("close", () => {
        if (this.ws === ws) this.ws = null;
      });
      this.sendState("idle");
    });
  }

  bind(session: Session): void {
    this.session = session;
  }

  private onMessage(data: ArrayBuffer | string, isBinary: boolean): void {
    const session = this.session;
    if (!session) return;
    if (isBinary) {
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
      case "played":
        session.ack(msg.seq);
        break;
      case "confirm":
        this.onConfirm?.(msg.confirmId, msg.approve);
        break;
    }
  }

  // wired by the confirmation broker (M2+ wiki commits, M4 mutate acts)
  onConfirm: ((confirmId: string, approve: boolean) => void) | null = null;

  private send(msg: ServerMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  // ── SessionSink ──────────────────────────────────────────────
  sendItem(item: PerformanceItem): void {
    this.send({ type: "item", item });
  }

  sendAudio(turnId: string, seq: number, pcm: Uint8Array): void {
    const streamId = ++this.audioStreamCounter;
    this.send({
      type: "audio.segment",
      turnId,
      seq,
      streamId,
      sampleRate: 24000,
      bytes: pcm.byteLength,
    });
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(encodeBinaryFrame(streamId, seq, pcm));
    }
  }

  sendWarning(message: string): void {
    this.send({ type: "error", message });
  }

  sendState(orb: Parameters<SessionSink["sendState"]>[0]): void {
    this.send({ type: "state", orb });
  }

  sendTurnBegin(turnId: string, source: "voice" | "text"): void {
    this.send({ type: "turn.begin", turnId, source });
  }

  sendTurnEnd(turnId: string): void {
    this.send({ type: "turn.end", turnId });
  }

  sendHeard(turnId: string, text: string): void {
    this.send({ type: "heard", turnId, text });
  }

  sendConfirmRequest(
    confirmId: string,
    summary: string,
    detail: string | undefined,
    phrases: string[],
  ): void {
    this.send({ type: "confirm.request", confirmId, summary, detail, phrases });
  }

  sendConfirmResolved(confirmId: string, approved: boolean): void {
    this.send({ type: "confirm.resolved", confirmId, approved });
  }
}
