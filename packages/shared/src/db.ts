import pg from "pg";

const { Pool } = pg;

export type Db = pg.Pool | pg.PoolClient;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      host: process.env.POSTGRES_HOST ?? "localhost",
      port: Number(process.env.POSTGRES_PORT ?? process.env.DB_PORT ?? 5432),
      user: process.env.POSTGRES_USER ?? "recon",
      password: process.env.POSTGRES_PASSWORD ?? "recon",
      database: process.env.POSTGRES_DB ?? "recon",
    });
  }
  return pool;
}

export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export function accountantName(): string {
  return process.env.ACCOUNTANT_NAME ?? "accountant";
}

export function managerName(): string {
  return process.env.MANAGER_NAME ?? "manager";
}
