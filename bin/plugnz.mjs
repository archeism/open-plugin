#!/usr/bin/env bun
// plugnz CLI shim — runs the TypeScript entrypoint directly under Bun.
import { main } from '../src/cli.ts';

process.exitCode = await main(process.argv.slice(2));
