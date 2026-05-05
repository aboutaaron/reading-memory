import type { Database } from './connection.js';
import type { SessionData, SessionStore } from '@flue/sdk/client';

export class SqliteSessionStore implements SessionStore {
  constructor(private readonly db: Database) {}

  async save(id: string, data: SessionData): Promise<void> {
    this.db.prepare(`
      INSERT INTO sessions (id, data, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `).run(id, JSON.stringify(data), new Date().toISOString());
  }

  async load(id: string): Promise<SessionData | null> {
    const row = this.db.prepare('SELECT data FROM sessions WHERE id = ?').get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as SessionData : null;
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }
}
