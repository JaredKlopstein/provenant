#!/usr/bin/env node
/**
 * The Provenant Cloud CLI: the same command surface as the open-source
 * `provenant`, plus the paid capabilities.
 *
 * Importing the cloud entrypoint registers its actions and anchor backends into
 * core's registry, so `bundle export` and `anchor now --backend tsa` simply
 * appear alongside everything else -- same conventions, same --json, same
 * --help, one manifest.
 */
import '../dist/register.js';
import { runCli } from '@provenant/core';
process.exit(await runCli(process.argv.slice(2)));
