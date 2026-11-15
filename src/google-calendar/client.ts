export interface GoogleAppConfig {
  clientId: string;
  clientSecret: string;
}

declare const registeredGoogleAppConfig: GoogleAppConfig | null;

/** Desktop app registration is supplied at build time; account tokens stay private. */
export const bundledGoogleApp =
  typeof registeredGoogleAppConfig === "undefined"
    ? null
    : registeredGoogleAppConfig;

export function googleClientId(
  settings: { clientId: string; useCustomClient: boolean },
  bundled = bundledGoogleApp,
) {
  return settings.useCustomClient
    ? settings.clientId.trim()
    : (bundled?.clientId ?? settings.clientId.trim());
}
