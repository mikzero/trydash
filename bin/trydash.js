#!/usr/bin/env bun
// The `trydash` command when run from source: `bun link` in the repository puts it on the PATH.
import { main } from '../server.js';

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
