#!/usr/bin/env node
// The session-control helper: the host operations the engine's `$.fs` lacks, in one Node.js process per call (Node 22
// or newer, standard library only). Run as `node host.mjs <op>` with one JSON request on stdin; it prints one JSON
// object, `{"ok":true,...}` or `{"ok":false,"code":"<CODE>"}`, and exits 0 or 1. The codes are fixed (protocol.mjs):
// no error message, path or file content is ever part of an answer.
//
//   probe         {args}                              -> {out}       Linux only: the lines of PROBE_SCRIPT
//   writeAtomic   {path, text, expected?}             -> {written}
//   renameOver    {from, to}                          -> {}
//   removeFile    {path, regularOnly?}                -> {removed}   regularOnly: a symbolic link is refused (IS_LINK), so is
//                                                                    a non-file (NOT_FILE)
//   append        {path, text}                        -> {bytes}
//   tail          {path, lines, width, maxBytes?}     -> {text, dropped}
//   rotate        {path, adding, maxBytes, moves}     -> {rotated}
//   filesNewerThan {dir, since, max}                  -> {files: [{path, mtimeMs}], total}   read-only
//   hashTree      {root, dirs, files}                 -> {files: [{path, sha256}], total}    read-only, links not followed
//   processTree   {pid, start}                        -> {out}       Linux only: the lines of TREE_SCRIPT (read-only)
//   stopProcesses {wait, targets: ['<pid>:<start>']}  -> {out}       Linux only: the lines of STOP_SCRIPT (signals sent)
//   probeUsage    {configDir, isInherited?}           -> {five, seven}  `claude -p /usage` for that config directory: each
//                                                                    window {percent, resets} or null; codes NO_CLAUDE,
//                                                                    TIMEOUT, NOT_LOGGED_IN, PARSE, FAILED (usage.mjs)
//   batch         {ops: [{op, ...request}, ...]}      -> {results}   file operations in order, in this one process;
//                                                                    the first failure stops it: {ok:false, code, at}

import { answer } from './ops.mjs'
import { failure, parseRequest, readStdin } from './protocol.mjs'

async function main() {
  const op = process.argv[2] ?? ''
  let reply
  try {
    reply = answer(op, parseRequest(await readStdin()))
  } catch (err) {
    reply = failure(err)
  }
  process.stdout.write(`${JSON.stringify(reply)}\n`)
  process.exitCode = reply.ok === true ? 0 : 1
}

await main()
