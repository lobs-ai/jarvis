// Single source of truth for the model/thinking option lists, shared by the
// settings drawer (which builds its <select>s from these) and the status strip
// (which labels the live model). Thinking levels mirror the protocol enum.
export interface Option {
  value: string;
  label: string;
}

export const MODEL_OPTIONS: Option[] = [
  { value: "claude-opus-4-8", label: "Opus 4.8" },
  { value: "claude-sonnet-5", label: "Sonnet 5" },
  { value: "claude-fable-5", label: "Fable 5" },
  { value: "claude-haiku-4-5", label: "Haiku 4.5" },
];

// Keep in sync with @jarvis/protocol ThinkingLevel. "off" is jarvis's own
// voice-latency mode (MAX_THINKING_TOKENS=0); the rest are the CLI --effort levels.
export const THINKING_OPTIONS: Option[] = [
  { value: "off", label: "Off" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
  { value: "max", label: "Max" },
];

export function modelLabel(id: string): string {
  return MODEL_OPTIONS.find((m) => m.value === id)?.label ?? id;
}
