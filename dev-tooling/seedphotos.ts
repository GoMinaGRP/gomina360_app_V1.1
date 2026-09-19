import { sql } from "drizzle-orm";
import * as fs from "fs";

/** One-off demo helper: attaches generated data-URL photos to the three demo
 *  showcase products (trays / blocks / drill) so the storefront gallery is
 *  exercisable end-to-end. Safe to re-run — only touches photo columns. */
const photos = JSON.parse(fs.readFileSync("/tmp/demophotos.json", "utf8"));

(async () => {
  const { db } = await import("@/db/index");
  const res: any = await db.execute(
    sql`SELECT id, business_id, name, unit FROM inventory_items
        WHERE lower(name) LIKE '%tray%' OR lower(name) LIKE '%concrete%' OR lower(name) LIKE '%drill%'
        ORDER BY id`,
  );
  const rows: any[] = res.rows ?? res;
  console.log("found", rows.length);
  for (const r of rows.slice(0, 3)) {
    const key = r.name.includes("Tray") ? "trays" : r.name.includes("Concrete") ? "blocks" : "drill";
    const primary = photos[key];
    const extraList =
      key === "trays"
        ? [photos.trays_side, photos.trays_box]
        : key === "blocks"
          ? [photos.blocks_stack]
          : [photos.drill_bits];
    await db.execute(sql`UPDATE inventory_items SET photo=${primary}, photos=${JSON.stringify(extraList)} WHERE id=${r.id}`);
    console.log("patched", r.id, r.name, r.business_id);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
