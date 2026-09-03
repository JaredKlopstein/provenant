#!/usr/bin/env node
import { runVerify } from '../dist/cli.js';
process.exit(runVerify(process.argv.slice(2)));
