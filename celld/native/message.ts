import { HTTPError, limits, messages, stringFields, unb64 } from "./protocol";
import type { ModerationMessage } from "./moderation";

export type IncomingMessage = { nonce: Uint8Array; ct: Uint8Array; message: ModerationMessage | null; bytes: number };
const validString = (value: unknown): value is string => typeof value === "string" && !/\p{Cs}/u.test(value);
export function incomingMessage(body: string, encrypted: boolean): IncomingMessage {
  if (encrypted) {
    const fields = stringFields(body, ["nonce", "ct"], messages.blob);
    const nonce = unb64(fields.nonce), ct = unb64(fields.ct);
    if (nonce?.length !== 12 || !ct || ct.length < 16) throw new HTTPError(400, messages.blob);
    if (ct.length > limits.blob) throw new HTTPError(413, messages.big);
    return { nonce, ct, message: null, bytes: ct.length };
  }
  try {
    const input = JSON.parse(body);
    // Accept exactly the data that will be screened and delivered. In
    // particular a ciphertext envelope cannot bypass screening in this mode.
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).some(key => !["nonce", "from", "text"].includes(key))) throw new Error();
    const { from, text, nonce: encodedNonce } = input;
    if (!validString(from) || !from || /^\p{White_Space}|\p{White_Space}$/u.test(from) || /\p{Cc}/u.test(from) ||
        !validString(text) || !/[^\p{White_Space}\x1c-\x1f]/u.test(text) || typeof encodedNonce !== "string") throw new Error();
    const nonce = unb64(encodedNonce);
    if (nonce?.length !== 12) throw new Error();
    const message = { from, text };
    const bytes = new TextEncoder().encode(JSON.stringify(message)).length;
    if (bytes > limits.blob) throw new HTTPError(413, "message too large (limit: 524288 UTF-8 JSON bytes)", "invalid_message");
    return { nonce, ct: new Uint8Array(), message, bytes };
  } catch (error) {
    if (error instanceof HTTPError) throw error;
    throw new HTTPError(400, 'Plaintext mode requires JSON {"nonce":"<base64url 12 bytes>","from":"name","text":"message"}. Use the clients served by this server.', "invalid_message");
  }
}
