#!/usr/bin/env node
/**
 * migrate-transport-schema.mjs — idempotent, additive-only schema migration
 * for the TRANSPORTATION business module:
 *
 *   • 7 new tables   (transport_vehicles / transport_trips / transport_bookings /
 *                     transport_fuel_logs / transport_maintenance /
 *                     transport_vehicle_checklists / transport_geofences /
 *                     transport_tracker_violations)
 *   • new columns on existing tables (assets) via ALTER TABLE … IF NOT EXISTS
 *   • supporting indexes (CREATE INDEX IF NOT EXISTS)
 **/
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

const { Client } = pg;

const here = new URL(".", import.meta.url).pathname;
const rootDir = resolve(here, "..");

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const f of [".env.local", ".env"]) {
    try {
      const txt = readFileSync(resolve(rootDir, f), "utf8");
      const m = txt.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/m);
      if (m) return m[1].replace(/^["']|["']$/g, "");
    } catch {}
  }
  throw new Error("DATABASE_URL not found in env or .env.local");
}

/* ── statements ─────────────────────────────────────────────────────────── */

const STATEMENTS = [
  `create table if not exists public.transport_vehicles (
    id serial primary key,
    business_id integer not null,
    branch_code text,
    owner_id integer,
    name text not null,
    vehicle_type text not null default 'TRUCK',
    license_plate text not null,
    make text, model text, year integer, color text,
    fuel_type text default 'DIESEL',
    odometer_unit text not null default 'KM',
    odometer_km double precision not null default 0,
    load_capacity double precision, seats integer,
    status text not null default 'ACTIVE',
    assigned_employee_id integer,
    default_driver_name text,
    insurance_company text, insurance_expiry text, license_expiry text,
    fitness_expiry text, roadworthy_expiry text,
    tags text, notes text,
    asset_id integer, photo text,
    purchase_cost_ghs double precision default 0, purchase_date text,
    gps_device_imei text, gps_device_secret text, gps_provider_key text,
    gps_enabled boolean not null default false,
    gps_health text default 'UNKNOWN',
    gps_last_lat double precision, gps_last_lng double precision, gps_last_speed_kmh double precision,
    gps_last_seen_ts timestamp,
    gps_mileage_today_km double precision not null default 0,
    gps_breadcrumbs jsonb default '[]'::jsonb,
    created_by_user_id integer, created_by_name text, created_by_role text,
    created_at timestamp default now(), updated_at timestamp default now()
  )`,
  `create unique index if not exists transport_vehicles_plate_uniq on public.transport_vehicles (business_id, license_plate)`,
  `create index if not exists transport_vehicles_biz_status_idx on public.transport_vehicles (business_id, status)`,
  `create index if not exists transport_vehicles_gps_seen_idx on public.transport_vehicles (gps_enabled, gps_last_seen_ts)`,
  `create table if not exists public.transport_trips (
    id serial primary key,
    business_id integer not null,
    branch_code text,
    owner_id integer,
    vehicle_id integer,
    driver_employee_id integer,
    driver_name text,
    status text not null default 'PLANNED',
    purpose text, source text, destination text,
    start_ts timestamp, end_ts timestamp,
    start_odometer_km double precision, end_odometer_km double precision,
    expected_km double precision, actual_km double precision,
    cargo text, notes text,
    customer_id integer, booking_id integer,
    fare_ghs double precision default 0,
    route_points jsonb default '[]'::jsonb,
    gps_started boolean default false,
    gps_completed_ts timestamp,
    gps_route jsonb default '[]'::jsonb,
    gps_distance_km double precision default 0,
    created_at timestamp default now(),
    created_by_user_id integer, created_by_name text, created_by_role text,
    completed_at timestamp
  )`,
  `create index if not exists transport_trips_biz_status_idx on public.transport_trips (business_id, status)`,
  `create index if not exists transport_trips_vehicle_idx on public.transport_trips (vehicle_id, status)`,
  `create table if not exists public.transport_bookings (
    id serial primary key,
    business_id integer not null,
    branch_code text,
    owner_id integer,
    customer_name text not null, customer_phone text, customer_id integer,
    status text not null default 'PENDING',
    cargo text, passengers integer default 0,
    origin text, destination text,
    scheduled_for timestamp, completed_at timestamp,
    fare_ghs double precision not null default 0,
    deposit_ghs double precision default 0,
    notes text,
    vehicle_id integer, trip_id integer,
    created_at timestamp default now(),
    created_by_user_id integer, created_by_name text, created_by_role text,
    cancelled_reason text
  )`,
  `create index if not exists transport_bookings_biz_status_idx on public.transport_bookings (business_id, status)`,
  `create table if not exists public.transport_fuel_logs (
    id serial primary key,
    business_id integer not null,
    branch_code text,
    owner_id integer,
    vehicle_id integer,
    driver_employee_id integer,
    odometer_km double precision not null,
    quantity_liters double precision not null,
    price_per_liter_ghs double precision not null,
    total_ghs double precision not null,
    fuel_type text not null default 'DIESEL',
    station text, notes text, receipt_photo text,
    logged_date text not null,
    logged_at timestamp default now(),
    created_by_name text, created_by_role text,
    created_at timestamp default now()
  )`,
  `create index if not exists transport_fuel_logs_vehicle_idx on public.transport_fuel_logs (vehicle_id, logged_date desc)`,
  `create table if not exists public.transport_maintenance (
    id serial primary key,
    business_id integer not null,
    branch_code text,
    owner_id integer,
    vehicle_id integer,
    category text not null default 'PREVENTIVE',
    status text not null default 'DUE',
    title text not null, description text,
    assigned_to_employee_id integer,
    vendor_name text,
    odometer_km double precision,
    estimated_cost_ghs double precision default 0,
    actual_cost_ghs double precision default 0,
    due_date text, done_date text,
    next_due_odometer_km double precision, next_due_date text,
    notes text,
    created_at timestamp default now(),
    created_by_name text, created_by_role text
  )`,
  `create index if not exists transport_maintenance_vehicle_idx on public.transport_maintenance (vehicle_id, status)`,
  `create table if not exists public.transport_vehicle_checklists (
    id serial primary key,
    business_id integer not null,
    branch_code text,
    owner_id integer,
    vehicle_id integer, trip_id integer,
    shift_date text not null,
    odometer_km double precision not null,
    fuel_level_pct integer,
    lights_ok boolean not null default false,
    brakes_ok boolean not null default false,
    tyres_ok boolean not null default false,
    oil_ok boolean not null default false,
    coolant_ok boolean not null default false,
    belts_ok boolean not null default false,
    mirrors_ok boolean not null default false,
    horn_ok boolean not null default false,
    fire_extinguisher_ok boolean not null default false,
    first_aid_ok boolean not null default false,
    documentation_ok boolean not null default false,
    cleaning_ok boolean not null default false,
    notes text, photo text,
    completed_at timestamp default now(),
    user_name text, user_role text,
    employee_id integer,
    created_at timestamp default now()
  )`,
  `create index if not exists transport_checklists_vehicle_idx on public.transport_vehicle_checklists (vehicle_id, shift_date desc)`,
  `create table if not exists public.transport_geofences (
    id serial primary key,
    business_id integer not null,
    branch_code text,
    owner_id integer,
    name text not null,
    kind text not null default 'CIRCLE',
    lat double precision, lng double precision, radius_m integer,
    polygon jsonb,
    notify_on_enter boolean not null default true,
    notify_on_exit boolean not null default true,
    active boolean not null default true,
    created_at timestamp default now(),
    created_by_name text, created_by_role text
  )`,
  `create index if not exists transport_geofences_biz_idx on public.transport_geofences (business_id, active)`,
  `create table if not exists public.transport_tracker_violations (
    id serial primary key,
    business_id integer not null,
    branch_code text,
    owner_id integer,
    vehicle_id integer, trip_id integer,
    kind text not null,
    severity text not null default 'CRITICAL',
    detail text, remedy_hint text,
    lat double precision, lng double precision,
    vehicle_plate text, trip_label text,
    status text not null default 'UNRESOLVED',
    resolved_at timestamp, resolved_by_name text, resolution_note text,
    created_at timestamp default now(),
    notified_manager_user_ids jsonb default '[]'::jsonb,
    created_by_name text, created_by_role text
  )`,
  `create index if not exists transport_tracker_violations_biz_idx on public.transport_tracker_violations (business_id, status, kind)`,
  `create index if not exists transport_tracker_violations_vehicle_idx on public.transport_tracker_violations (vehicle_id, created_at desc)`,
  `alter table public.assets add column if not exists transport_vehicle_id integer`,
  // Trackers hub (Phase: dedicated Link/Add GPS Tracker section) — additive.
  `alter table public.transport_vehicles add column if not exists gps_device_label text`,
  `alter table public.transport_vehicles add column if not exists gps_sim_number text`
];

const PRETTY = process.argv.includes("--dry");

async function main() {
  const url = loadDatabaseUrl();
  const client = new Client({ connectionString: url });
  await client.connect();
  console.log(`[migrate-transport] connected · ${STATEMENTS.length} statements`);
  let ok = 0, skipped = 0;
  for (const [i, sql] of STATEMENTS.entries()) {
    const tag = sql.replace(/\s+/g, " ").slice(0, 72);
    if (PRETTY) { console.log(`  [dry ${i + 1}] ${tag}…`); continue; }
    try { await client.query(sql); ok++; console.log(`  ✓ ${i + 1}/${STATEMENTS.length} ${tag}…`); }
    catch (e) {
      if (e.code === "42P07" || e.code === "42701") { skipped++; console.log(`  · exists — ${tag}…`); }
      else { console.error(`  ✗ FAILED: ${tag}…\n    ${e.message}`); process.exitCode = 1; }
    }
  }
  await client.end();
  console.log(`[migrate-transport] done — ${ok} applied, ${skipped} already present, ${STATEMENTS.length - ok - skipped} attempted`);
}

main().catch((e) => { console.error("[migrate-transport] fatal:", e); process.exit(1); });
