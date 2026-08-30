#!/usr/bin/env node
import { main } from '../planner/cli.js';

process.exitCode = await main();
