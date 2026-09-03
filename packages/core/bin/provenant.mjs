#!/usr/bin/env node
import { runCli } from '../dist/adapters/cli.js';
process.exit(runCli(process.argv.slice(2)));
