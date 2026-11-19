declare const registeredGitHubClientId: string | null;

/** Only the OAuth app's public client ID is bundled, never an account token. */
export const bundledGitHubClientId =
  typeof registeredGitHubClientId === "undefined"
    ? ""
    : (registeredGitHubClientId ?? "");

export function githubClientId(settings: {
  useCustomClient: boolean;
  clientId: string;
}) {
  return settings.useCustomClient
    ? settings.clientId.trim()
    : bundledGitHubClientId;
}
