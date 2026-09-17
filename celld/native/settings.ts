import { moderationEnabled, type ModerationEnv } from "./moderation";
import { HTTPError } from "./protocol";

export interface SettingsEnv extends ModerationEnv { ENCRYPTION_ENABLED?: string }
export type Settings = { protocol: 2; encryption: boolean; moderation: boolean; postingAllowed: boolean };

export function settings(env: SettingsEnv, channelEncryption?: boolean): Settings {
  const flag = env.ENCRYPTION_ENABLED ?? "0";
  if (flag !== "0" && flag !== "1") throw new HTTPError(503, "ENCRYPTION_ENABLED must be 0 or 1", "configuration_error");
  const encryption = flag === "1";
  // Encryption takes precedence, including over missing Jev credentials or an
  // invalid Jev setting. Never call the provider for an encrypted deployment.
  let moderation = false;
  if (!encryption) {
    try { moderation = moderationEnabled(env); }
    catch { throw new HTTPError(503, "JEV_ENABLED must be 0 or 1", "configuration_error"); }
  }
  return { protocol: 2, encryption: channelEncryption ?? encryption,
    moderation: moderation && channelEncryption !== true,
    postingAllowed: channelEncryption === undefined || channelEncryption === encryption };
}

export function privacyText(config: Settings): string {
  const text = config.encryption
    ? "Messages are end-to-end encrypted. Jev screening is off."
    : config.moderation
    ? "Messages are readable by this server and screened by TypeSafe Jev before delivery."
    : "Messages are readable by this server. Jev screening is off.";
  return text + (config.postingAllowed ? "" : " The server's encryption setting changed. Create a new channel to send messages.");
}
