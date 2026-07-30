import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

test("lms_tenant migration is idempotent, constrained, indexed and rollback-safe", async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS public;
    CREATE TABLE public.courses (
      id uuid PRIMARY KEY,
      slug text UNIQUE NOT NULL,
      active boolean DEFAULT true,
      is_published boolean DEFAULT false,
      learning_course_slug text
    );
    CREATE TABLE public.orders (
      id uuid PRIMARY KEY,
      status text,
      learning_course_slug text
    );
    INSERT INTO public.courses (id, slug) VALUES
      ('00000000-0000-0000-0000-000000000001', 'legacy');
  `);
  const migration = fs.readFileSync(new URL("../migrations/20260730_dual_lms_tenant.sql", import.meta.url), "utf8");
  const rollback = fs.readFileSync(new URL("../migrations/20260730_dual_lms_tenant_rollback.sql", import.meta.url), "utf8");
  await db.exec(migration);
  await db.exec(migration);

  const legacy = await db.query("SELECT lms_tenant FROM public.courses WHERE slug='legacy'");
  assert.equal(legacy.rows[0].lms_tenant, null);
  await db.exec("UPDATE public.courses SET lms_tenant='yeubep' WHERE slug='legacy'");
  await assert.rejects(
    db.exec("UPDATE public.courses SET lms_tenant='attacker' WHERE slug='legacy'"),
    /courses_lms_tenant_check/
  );
  await assert.rejects(
    db.exec("INSERT INTO public.courses (id,slug) VALUES ('00000000-0000-0000-0000-000000000002','legacy')"),
    /unique/
  );
  const indexes = await db.query(`
    SELECT indexname FROM pg_indexes
    WHERE schemaname='public' AND indexname LIKE 'idx_courses_%tenant%'
  `);
  assert.equal(indexes.rows.length, 3);
  const orderIndexes = await db.query(`
    SELECT indexname FROM pg_indexes
    WHERE schemaname='public' AND indexname LIKE 'idx_orders_%tenant%'
  `);
  assert.equal(orderIndexes.rows.length, 2);

  await db.exec(rollback);
  const columns = await db.query(`
    SELECT count(*)::int AS n FROM information_schema.columns
    WHERE table_schema='public' AND table_name='courses' AND column_name='lms_tenant'
  `);
  assert.equal(columns.rows[0].n, 0);
  const orderColumns = await db.query(`
    SELECT count(*)::int AS n FROM information_schema.columns
    WHERE table_schema='public' AND table_name='orders' AND column_name='lms_tenant'
  `);
  assert.equal(orderColumns.rows[0].n, 0);
  const preserved = await db.query("SELECT count(*)::int AS n FROM public.courses");
  assert.equal(preserved.rows[0].n, 1);
  await db.close();
});

