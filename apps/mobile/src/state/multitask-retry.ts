import { CommandId, MessageId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { writeFileAtomically } from "../lib/atomic-file";
import { uuidv4 } from "../lib/uuid";

const Retry = Schema.Struct({ key: Schema.String, commandId: CommandId, messageId: MessageId });
const decodeRetry = Schema.decodeUnknownSync(Schema.fromJsonString(Retry));

async function retryFile(threadKey: string) {
  const { Directory, File, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.document, "multitask-retries");
  directory.create({ idempotent: true, intermediates: true });
  return new File(directory, `${encodeURIComponent(threadKey)}.json`);
}

export async function loadOrCreateMultitaskRetry(threadKey: string, key: string) {
  const file = await retryFile(threadKey);
  if (file.exists) {
    const existing = decodeRetry(await file.text());
    if (existing.key === key) return existing;
  }
  const retry = { key, commandId: CommandId.make(uuidv4()), messageId: MessageId.make(uuidv4()) };
  await writeFileAtomically(file, JSON.stringify(retry));
  return retry;
}

export async function clearMultitaskRetry(threadKey: string) {
  const file = await retryFile(threadKey);
  if (file.exists) file.delete();
}
