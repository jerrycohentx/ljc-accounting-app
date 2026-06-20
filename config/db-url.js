export function isPostgresUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return url.startsWith('postgresql://') || url.startsWith('postgres://');
}
