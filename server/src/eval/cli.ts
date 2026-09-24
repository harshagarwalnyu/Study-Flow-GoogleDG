import { main } from "./run";

// `bun run eval` entry point; all logic lives in run.ts so it can be tested.
await main(process.argv.slice(2)).catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
