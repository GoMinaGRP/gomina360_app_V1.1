/** Dev-only: invoke the idempotent seeder (seed.ts exports, never self-runs). */
import { seedDatabase } from "../src/db/seed";
await seedDatabase();
console.log("seed invoked");
