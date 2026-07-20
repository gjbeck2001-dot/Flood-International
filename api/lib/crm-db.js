/**
 * Shared Postgres client for the Flood CRM (Railway).
 * Phase 6 cutover (2026-07-19): this is the sole source of truth — the
 * parallel Notion write path is gone.
 * See: 03 OPERATIONS/crm-db/schema.sql (Second Brain Starter vault) for the schema.
 */
import pg from 'pg';

const { Pool } = pg;

let pool;
function getPool() {
  if (!pool) {
    pool = new Pool({ connectionString: process.env.CRM_DATABASE_URL, max: 3 });
  }
  return pool;
}

export async function insertLead({ name, email, phone, company, source = 'Website', notes, websiteSocial }) {
  const p = getPool();
  await p.query(
    `INSERT INTO crm_contacts (name, email, phone, company, source, contact_type, status, notes, website_social)
     VALUES ($1, $2, $3, $4, $5, 'Lead', 'New', $6, $7)`,
    [
      name,
      email,
      phone || null,
      company && company !== 'N/A' ? company : null,
      source,
      notes || null,
      websiteSocial || null,
    ]
  );
}

export async function hasCompleteIntake(email) {
  const p = getPool();
  const r = await p.query(
    `SELECT 1 FROM crm_contacts WHERE email = $1 AND notes LIKE '%Full 49-question intake completed%' LIMIT 1`,
    [email]
  );
  return r.rowCount > 0;
}
