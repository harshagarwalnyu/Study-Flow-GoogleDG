import { main } from "./reembed";

// `bun run reembed` entry point; all logic lives in reembed.ts so it can be tested.
await main(process.argv.slice(2)).catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
