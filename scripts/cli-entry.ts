/** Bundle entry: the same contract as bin/plugnz.mjs without the Bun shim. */
import { main } from '../src/cli';

process.exitCode = await main(process.argv.slice(2));
