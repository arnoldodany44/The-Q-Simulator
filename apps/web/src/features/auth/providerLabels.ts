/**
 * How each provider's Supabase key is spelled when a person reads it.
 *
 * `github` is the identifier, `GitHub` is the brand, and the two differ in
 * more than case for several of them — `workos` is `WorkOS`, `linkedin_oidc`
 * is still `LinkedIn`. Getting this wrong is not a crash; it is a sign-in
 * screen that looks like nobody proof-read it.
 *
 * These names are deliberately not in an i18n catalog. D2 keeps proper nouns
 * identical in all three languages, exactly as it does for gate names: the
 * sentence *around* the name is translated and the name is interpolated into
 * it, so the catalog holds "Continue with {{provider}}" and this file holds
 * the rest.
 *
 * A provider absent from the table still renders, title-cased. That matters:
 * the whole point of discovering providers rather than listing them is that
 * one enabled after this bundle shipped must work, and a missing label is not
 * a reason to hide a working button.
 *
 * In its own module rather than beside the component because
 * `react-refresh/only-export-components` is right — a file exporting both a
 * component and a helper loses fast refresh for the component.
 */

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  bitbucket: 'Bitbucket',
  discord: 'Discord',
  figma: 'Figma',
  github: 'GitHub',
  gitlab: 'GitLab',
  google: 'Google',
  keycloak: 'Keycloak',
  linkedin: 'LinkedIn',
  linkedin_oidc: 'LinkedIn',
  notion: 'Notion',
  slack: 'Slack',
  slack_oidc: 'Slack',
  spotify: 'Spotify',
  twitch: 'Twitch',
  workos: 'WorkOS',
  zoom: 'Zoom',
}

/** `some_new_idp` → `Some New Idp`. Readable, and never wrong twice. */
function titleCase(name: string): string {
  return name
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function providerLabel(name: string): string {
  return PROVIDER_LABELS[name] ?? titleCase(name)
}
