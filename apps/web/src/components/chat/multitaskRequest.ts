import { CommandId, MessageId } from "@t3tools/contracts";
import { randomUUID } from "~/lib/utils";
import * as Schema from "effect/Schema";

const Request = Schema.Struct({
  signature: Schema.String,
  commandId: CommandId,
  messageId: MessageId,
});
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Request));
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

export function multitaskRequest(storage: Storage, key: string, signature: string) {
  const raw = storage.getItem(key);
  if (raw) {
    try {
      const existing = decode(raw);
      if (existing.signature === signature) return existing;
    } catch {}
  }
  const request = {
    signature,
    commandId: CommandId.make(randomUUID()),
    messageId: MessageId.make(randomUUID()),
  };
  storage.setItem(key, JSON.stringify(request));
  return request;
}

export function acknowledgeMultitaskRequest(storage: Storage, key: string, commandId: CommandId) {
  const raw = storage.getItem(key);
  if (!raw) return;
  try {
    if (decode(raw).commandId === commandId) storage.removeItem(key);
  } catch {
    storage.removeItem(key);
  }
}
