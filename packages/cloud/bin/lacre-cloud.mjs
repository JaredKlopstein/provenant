#!/usr/bin/env node
/**
 * The Lacre Cloud CLI: the same command surface as the open-source
 * `lacre`, plus the paid capabilities.
 *
 * Importing the cloud entrypoint registers its actions and anchor backends into
 * core's registry, so `bundle export` and `anchor now --backend tsa` simply
 * appear alongside everything else -- same conventions, same --json, same
 * --help, one manifest.
 */
import '../dist/register.js';
import { runCli } from '@lacre/core';
process.exit(await runCli(process.argv.slice(2)));
