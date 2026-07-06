/**
 * Resolve a valid users.id for automated jobs (Plaid sync, webhooks, etc.).
 * PostgreSQL enforces journal_entries.created_by → users(id); SQLite may not.
 */

export async function resolveAutomationUserId(db) {
  const admin = await db.get(
    "SELECT id FROM users WHERE role = 'ADMIN' AND is_active = 1 LIMIT 1"
  );
  if (admin?.id) return admin.id;

  const adminEmail = (process.env.ADMIN_EMAIL || 'jerry@ljcfinancial.com').trim().toLowerCase();
  const byEmail = await db.get(
    'SELECT id FROM users WHERE email = ? AND is_active = 1',
    [adminEmail]
  );
  if (byEmail?.id) return byEmail.id;

  const fallback = await db.get('SELECT id FROM users WHERE id = ?', ['usr-admin']);
  if (fallback?.id) return fallback.id;

  throw new Error('No system user found for automated journal entries');
}
