import { seedDatabase } from "@/db/seed";
(async () => {
  await seedDatabase();
  console.log("seed done");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
