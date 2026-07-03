import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BUNDLE_TOKEN_BUDGET, PER_SERVER_TIMEOUT_MS, type ContextEntry, type RiskClass } from "@jarvis/protocol";
import type { ToolDef } from "../brain/loop.js";

export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

// Risk classes per tool (design §Security model). MCP annotations could carry
// this eventually; an explicit registry is simpler and auditable.
const RISK_REGISTRY: Array<[RegExp, RiskClass]> = [
  [/^wiki_commit$/, "mutate"],
  [/^browser_(click|type|submit)/, "mutate"],
  [/^browser_(navigate|open)/, "navigate"],
  // Rafe's call: the shell runs unconfirmed (parity with the CLI path's Bash).
  // "navigate" still drains speech first, so the pre-command line plays before
  // the command fires; destructive-action asking is a prompt norm, not a gate.
  [/^terminal_run$/, "navigate"],
  // self-reconfiguration is reversible and announced; drain speech, no gate
  [/^settings_set$/, "navigate"],
];

export function riskOf(tool: string): RiskClass {
  for (const [re, risk] of RISK_REGISTRY) if (re.test(tool)) return risk;
  return "read";
}

interface Connected {
  spec: McpServerSpec;
  client: Client;
  tools: ToolDef[];
  contextTool: string | null;
}

// MCP client pool with supervision: crash → in-flight calls fail (the model
// sees the error, Failure UX speaks) → reconnect with backoff → tools re-aggregate.
export class McpManager {
  private servers = new Map<string, Connected>();
  private backoff = new Map<string, number>();
  onToolsChanged: (() => void) | null = null;

  async connectAll(specs: McpServerSpec[]): Promise<void> {
    await Promise.all(specs.map((s) => this.connect(s)));
  }

  private async connect(spec: McpServerSpec): Promise<void> {
    try {
      const transport = new StdioClientTransport({
        command: spec.command,
        args: spec.args,
        env: { ...process.env as Record<string, string>, ...spec.env },
        stderr: "ignore",
      });
      const client = new Client({ name: "jarvisd", version: "0.1.0" });
      transport.onclose = () => this.scheduleReconnect(spec);
      await client.connect(transport);
      const listed = await client.listTools();
      const tools: ToolDef[] = listed.tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        input_schema: t.inputSchema as Record<string, unknown>,
      }));
      const contextTool = tools.find((t) => t.name.endsWith("_context"))?.name ?? null;
      this.servers.set(spec.name, { spec, client, tools, contextTool });
      this.backoff.set(spec.name, 2000);
      console.log(`mcp: ${spec.name} connected (${tools.map((t) => t.name).join(", ")})`);
      this.onToolsChanged?.();
    } catch (err) {
      console.error(`mcp: ${spec.name} failed to connect: ${String(err)}`);
      this.scheduleReconnect(spec);
    }
  }

  private scheduleReconnect(spec: McpServerSpec): void {
    this.servers.delete(spec.name);
    this.onToolsChanged?.();
    const wait = this.backoff.get(spec.name) ?? 2000;
    this.backoff.set(spec.name, Math.min(wait * 2, 30_000));
    console.error(`mcp: ${spec.name} down, reconnecting in ${wait}ms`);
    setTimeout(() => void this.connect(spec), wait);
  }

  // Aggregated tool list for the brain — context tools excluded (the bundle
  // assembler calls those; the model shouldn't re-fetch ambient context).
  tools(): ToolDef[] {
    return [...this.servers.values()]
      .flatMap((s) => s.tools)
      .filter((t) => !t.name.endsWith("_context"));
  }

  async execute(name: string, input: Record<string, unknown>): Promise<string> {
    const server = [...this.servers.values()].find((s) => s.tools.some((t) => t.name === name));
    if (!server) return `tool unavailable (its server may be down): ${name}`;
    const result = await server.client.callTool({ name, arguments: input });
    const blocks = (result.content ?? []) as Array<{ type: string; text?: string }>;
    const text = blocks.map((b) => (b.type === "text" ? b.text ?? "" : `[${b.type}]`)).join("\n");
    return result.isError ? `tool error: ${text}` : text;
  }

  // Utterance-bundle assembly: parallel *_context calls, per-server timeout,
  // best-effort, hard token budget (design §Eyes).
  async collectContext(): Promise<ContextEntry[]> {
    const perServerChars = Math.floor((BUNDLE_TOKEN_BUDGET * 4) / Math.max(1, this.servers.size));
    const jobs = [...this.servers.values()]
      .filter((s) => s.contextTool)
      .map(async (s): Promise<ContextEntry | null> => {
        try {
          const result = await Promise.race([
            s.client.callTool({ name: s.contextTool!, arguments: {} }),
            new Promise<never>((_, rej) =>
              setTimeout(() => rej(new Error("context timeout")), PER_SERVER_TIMEOUT_MS),
            ),
          ]);
          const blocks = (result.content ?? []) as Array<{ type: string; text?: string }>;
          let text = blocks.map((b) => b.text ?? "").join("\n");
          text = redactSecrets(text);
          if (text.length > perServerChars) text = text.slice(0, perServerChars) + "\n[truncated]";
          return { server: s.spec.name, content: text };
        } catch {
          return null; // absent from the bundle — context is best-effort
        }
      });
    return (await Promise.all(jobs)).filter((e): e is ContextEntry => e !== null);
  }
}

// Accident net, not a guarantee (design §Security model).
function redactSecrets(text: string): string {
  return text
    .replace(/\b(sk-[a-zA-Z0-9-_]{20,})/g, "[redacted-key]")
    .replace(/\b(gh[pousr]_[a-zA-Z0-9]{20,})/g, "[redacted-token]")
    .replace(/\b(AKIA[0-9A-Z]{16})\b/g, "[redacted-aws]")
    .replace(/^([A-Z_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z_]*)=(.+)$/gm, "$1=[redacted]");
}
