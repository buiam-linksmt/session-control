// The scripts of the Linux adapter (Linux and WSL): the probe of /proc, the append to a log and the trace's rotation,
// each run through `sh -c` by the adapter below. Moved here unchanged from core.ts and trace.ts.

/**
 * The one shell probe run through `$.process.run(['sh', '-c', PROBE_SCRIPT,
 * 'session-probe', ...probeArgs(entries)])`. Prints tab-separated lines:
 *   P <pid> <comm> <elapsedSec> <cwd> <CLAUDE_CONFIG_DIR> <cmdline>
 *   A <pid> <comm> <statStart> <fileProcStart> <fileSessionId>   for each asked pid that exists
 *   T <sid> <mtimeEpochSec>       newest transcript of an asked session
 */
export const PROBE_SCRIPT = [
  'up=$(cut -d. -f1 /proc/uptime 2>/dev/null)',
  'hz=$(getconf CLK_TCK 2>/dev/null)',
  'for d in /proc/[0-9]*; do',
  '  p=${d#/proc/}',
  '  read -r c 2>/dev/null < "$d/comm" || continue',
  '  [ "$c" = claude ] || continue',
  '  cmd=$(tr "\\000\\t\\n" "   " < "$d/cmdline" 2>/dev/null)',
  '  cwd=$(readlink "$d/cwd" 2>/dev/null)',
  '  cfg=$(tr "\\000" "\\n" < "$d/environ" 2>/dev/null | sed -n "s/^CLAUDE_CONFIG_DIR=//p" | head -n 1)',
  '  stt=$(sed "s/^.*) //" "$d/stat" 2>/dev/null | cut -d" " -f20)',
  '  et=""; [ -n "$stt" ] && [ -n "$up" ] && [ -n "$hz" ] && et=$((up - stt / hz))',
  '  printf "P\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "$p" "$c" "$et" "$cwd" "$cfg" "$cmd"',
  'done',
  'for a in "$@"; do',
  '  case "$a" in',
  '    pid:*) r=${a#pid:}; p=${r%%|*}; r=${r#*|}; c=${r%%|*}; [ -d "/proc/$p" ] || continue',
  '      st=$(sed "s/^.*) //" "/proc/$p/stat" 2>/dev/null | cut -d" " -f20)',
  '      fs=$(jq -r ".procStart // empty" "$c/sessions/$p.json" 2>/dev/null)',
  '      fi=$(jq -r ".sessionId // empty" "$c/sessions/$p.json" 2>/dev/null)',
  '      printf "A\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "$p" "$(cat "/proc/$p/comm" 2>/dev/null)" "$st" "$fs" "$fi";;',
  '    t:*) r=${a#t:}; s=${r%%|*}; c=${r#*|}',
  '      f=$(ls -t "$c"/projects/*/"$s".jsonl 2>/dev/null | head -n 1)',
  '      [ -n "$f" ] && printf "T\\t%s\\t%s\\n" "$s" "$(stat -c %Y "$f")";;',
  '  esac',
  'done',
  'exit 0',
].join('\n')

/** Appends a text and a newline to a log, as CLEAR_SCRIPT appended the cleared entries: args are the text and the log path. */
export const APPEND_SCRIPT = `printf '%s\\n' "$1" >> "$2"`

/**
 * The rotation on Linux, one process: args are the trace path, the number of the oldest file kept, the size limit and
 * the bytes about to go in. The size is read here, right before the renames, so of several processes sharing the
 * trace only the first to find it too big rotates it; the others find it small or gone and leave it. Each older file
 * moves one up (the oldest is overwritten; a move another process made first is no failure), then the trace becomes
 * .1: the exit code is that move's, and a trace another process moved meanwhile is no failure either.
 */
export const ROTATE_SCRIPT = String.raw`L=$1; i=$2; max=$3; add=$4
{ size=$(wc -c < "$L"); } 2>/dev/null || exit 0
[ $((size)) -gt 0 ] && [ $((size + add)) -gt "$max" ] || exit 0
while [ "$i" -gt 1 ]; do p=$((i - 1)); [ -f "$L.$p" ] && mv -f "$L.$p" "$L.$i" 2>/dev/null; i=$p; done
mv -f "$L" "$L.1" 2>/dev/null || [ ! -e "$L" ]`
