import pg from 'pg';

const { Pool } = pg;

const dbUrl = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/teamform';
// Managed Postgres (Neon) requires TLS; local/Docker Postgres does not serve it.
const useSsl = /neon\.tech|sslmode=require/.test(dbUrl);

export const pool = new Pool({
  connectionString: dbUrl,
  ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  // Small pool per serverless instance; Postgres stays the contention point by design.
  max: Number(process.env.PG_POOL_MAX || 5),
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
});

export type TxClient = pg.PoolClient;

/** Run fn inside a transaction. Any throw rolls back; nothing is half-written. */
export async function withTx<T>(fn: (client: TxClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
