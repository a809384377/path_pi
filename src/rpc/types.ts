export interface RpcResponse<T = unknown> {
  id: string;
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

export interface AssistantOutcome {
  stopReason?: string;
  errorMessage?: string;
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
  if (!isRecord(value)) return false;
  return (
    value.type === "response" &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.command === "string" &&
    value.command.length > 0 &&
    typeof value.success === "boolean" &&
    (value.error === undefined || typeof value.error === "string")
  );
}

export function assistantOutcomeFromEvent(event: RpcEvent): AssistantOutcome | undefined {
  if (event.type !== "message_end" || !isRecord(event.message) || event.message.role !== "assistant") return undefined;
  const stopReason = typeof event.message.stopReason === "string" ? event.message.stopReason : undefined;
  const errorMessage = typeof event.message.errorMessage === "string" ? event.message.errorMessage : undefined;
  if (stopReason === undefined && errorMessage === undefined) return undefined;
  return {
    ...(stopReason !== undefined ? { stopReason } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
