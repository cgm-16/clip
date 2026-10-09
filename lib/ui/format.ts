// 'sv-SE' formats as YYYY-MM-DD HH:mm. The zone is fixed to Asia/Seoul: the
// product, its copy and its admins are Korean, and the handoff shows times
// without a zone.
const timestamp = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
const date = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function formatTimestamp(iso: string): string {
  return timestamp.format(new Date(iso));
}

export function formatDate(iso: string): string {
  return date.format(new Date(iso));
}
