// Real Drizzle (node-postgres) connection for the aggregate engine + eval.
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

export type DrizzleDb = ReturnType<typeof drizzle>;

export function makeDb(connectionString: string): { db: DrizzleDb; close: () => Promise<void> } {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool);
  return { db, close: () => pool.end() };
}
