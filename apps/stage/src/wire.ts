import { ServerMessage, type ClientMessage, decodeBinaryFrame } from "@jarvis/protocol";

export interface WireEvents {
  onMessage: (msg: ServerMessage) => void;
  onAudio: (streamId: number, seq: number, pcm: Uint8Array) => void;
  onOpen: () => void;
  onClose: () => void;
}

export class Wire {
  private ws: WebSocket | null = null;
  private retryMs = 500;

  constructor(private readonly events: WireEvents) {}

  connect(): void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.retryMs = 500;
      this.events.onOpen();
    };
    ws.onclose = () => {
      this.events.onClose();
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 8000);
    };
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        const { streamId, seq, pcm } = decodeBinaryFrame(ev.data);
        this.events.onAudio(streamId, seq, pcm);
        return;
      }
      const parsed = ServerMessage.safeParse(JSON.parse(ev.data as string));
      if (parsed.success) this.events.onMessage(parsed.data);
    };
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  sendBinary(frame: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(frame);
  }
}
