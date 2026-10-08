/** Screen D's URL. Filter and page state live in the URL so a view is linkable (handoff). */
export function archiveHref(
  guildId: string,
  query: { channel?: string; before?: string; after?: string },
): string {
  const params = new URLSearchParams();
  for (const key of ['channel', 'before', 'after'] as const) {
    const value = query[key];
    if (value !== undefined) {
      params.set(key, value);
    }
  }
  const search = params.toString();
  return `/admin/${guildId}/archive${search ? `?${search}` : ''}`;
}
