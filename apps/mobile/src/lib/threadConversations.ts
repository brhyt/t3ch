export function mobileSupportsThreadConversations(
  capabilities: { readonly threadConversations?: boolean } | null | undefined,
): boolean {
  return capabilities?.threadConversations === true;
}
