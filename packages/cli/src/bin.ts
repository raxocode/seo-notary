#!/usr/bin/env node
import { runCli } from "./cli.js";

const code = await runCli(process.argv.slice(2), {
  out: (s) => void process.stdout.write(s),
  err: (s) => void process.stderr.write(s),
  color: process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined,
});
process.exitCode = code;
