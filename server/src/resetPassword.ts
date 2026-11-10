/**
 * Locked out? Run on the Mediarr computer:  npm run reset-password -- <username>
 * Sets a new random password, turns off two-factor, and signs out every session.
 * Only someone with access to this machine (and its data folder) can do this.
 */
import crypto from 'node:crypto';
import { hashPassword } from './auth/password.js';
import { db, defaultDbPath, initDb, now } from './db.js';

initDb(defaultDbPath());
const users = db.prepare('SELECT id, username FROM users').all() as { id: number; username: string }[];
const wanted = process.argv[2];

if (!users.length) {
  console.log('There is no account yet. Start Mediarr and use the setup code it prints to create one.');
  process.exit(0);
}
const user = wanted ? users.find((u) => u.username.toLowerCase() === wanted.toLowerCase()) : users.length === 1 ? users[0] : undefined;
if (!user) {
  console.log(`Usage: npm run reset-password -- <username>\nAccounts: ${users.map((u) => u.username).join(', ')}`);
  process.exit(1);
}

const password = crypto.randomBytes(15).toString('base64url'); // 20 characters
db.prepare('UPDATE users SET password_hash = ?, password_changed_at = ?, totp_enabled = 0, totp_secret = NULL, totp_last_counter = 0 WHERE id = ?').run(
  await hashPassword(password),
  now(),
  user.id,
);
db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
console.log(`Password for "${user.username}" reset. Two-factor is off and all sessions were signed out.`);
console.log(`New password: ${password}`);
console.log('Sign in and change it under Settings → Security.');
