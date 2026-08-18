export interface RpcResponse<T = unknown> {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: T;
  error?: string;
}

export interface RpcEvent {
  type: string;
  [key: string]: unknown;
}

export interface PiSessionState {
  sessionFile: string | null;
  sessionId: string;
  sessionName?: string;
  isStreaming: boolean;
  isCompacting: boolean;
  messageCount: number;
  pendingMessageCount: number;
}

export interface SwitchSessionResult {
  cancelled: boolean;
}

export interface LastAssistantTextResult {
  text: string | null;
}

export interface PromptCommand {
  type: "prompt";
  message: string;
}

export type RpcCommand =
  | PromptCommand
  | { type: "get_state" }
  | { type: "switch_session"; sessionPath: string }
  | { type: "get_last_assistant_text" }
  | { type: "abort" };

export function isRpcResponse(value: unknown): value is RpcResponse {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.type === "response" && typeof record.command === "string" && typeof record.success === "boolean";
}
