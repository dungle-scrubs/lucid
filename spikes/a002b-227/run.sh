#!/bin/zsh
# A-002 (2.1.227) coordinator. Proves three contracts:
#   1. mid-turn boundary injection via hook stdout
#   2. --setting-sources project CO-RUNS two distinct project PostToolUse hooks
#   3. transcript flush behavior during a tool-free reasoning window
# Reads evidence from FILES only (never pane scrollback). Every log is
# freshly truncated at start; RUN_TOKEN stamps the run for belt-and-suspenders.
set -u
cd "$(dirname "$0")"
nowms() { perl -MTime::HiRes=time -e 'printf "%d", time*1000'; }
RUN_TOKEN="a002b-$(nowms)"

chmod +x .claude/hooks/*.sh drive.exp
rm -f announce.log hooks-fired.log co-run.log delivery.log queue.txt \
      pty.log driver-events.log processes.log samples.log sampler.stop verdict.txt
rm -rf work; mkdir -p work; touch queue.txt
print -r -- "RUN_TOKEN=$RUN_TOKEN started_at=$(nowms)" >> processes.log

# --- transcript sampler (contract 3): poll size+mtime after announce ---
(
  until [ -s announce.log ]; do sleep 0.1; [ -f sampler.stop ] && exit 0; done
  TP=$(jq -r '.transcript_path' announce.log 2>/dev/null | head -1)
  print -r -- "SAMPLER transcript_path=$TP" >> processes.log
  while [ ! -f sampler.stop ]; do
    if [ -f "$TP" ]; then
      sz=$(stat -f%z "$TP" 2>/dev/null); mt=$(stat -f%m "$TP" 2>/dev/null)
      print -r -- "$(nowms) $sz $mt" >> samples.log
    fi
    sleep 0.2
  done
) &
sampler=$!
print -r -- "SPAWN sampler pid=$sampler" >> processes.log

# --- injection dropper (contract 1): queue after the first PostToolUse ---
(
  while ! grep -q '"hook":"PostToolUse"' hooks-fired.log 2>/dev/null; do
    sleep 0.2; [ -f sampler.stop ] && exit 0
  done
  print -r -- "Also create work/four.txt containing exactly extra. Then say exactly: FEEDBACK-ONE-APPLIED." > queue.txt
  print -r -- "$(nowms) QUEUE_ONE_WRITTEN" >> driver-events.log
) &
dropper=$!
print -r -- "SPAWN dropper pid=$dropper" >> processes.log

expect drive.exp
rc=$?
touch sampler.stop
wait "$sampler" 2>/dev/null
wait "$dropper" 2>/dev/null
print -r -- "EXIT runner rc=$rc" >> processes.log

# ---------------- analysis ----------------
win() { grep -m1 " $1\$" driver-events.log 2>/dev/null | awk '{print $1}'; }
T2_START=$(win TURN2_SUBMITTED); T2_END=$(win TURN2_DONE)

# Contract 1
c1_deliv=$(grep -c '"delivered_by": "PostToolUse"' delivery.log 2>/dev/null || echo 0)
c1_seen=$(grep -c 'FEEDBACK_ONE_VISIBLE' driver-events.log 2>/dev/null || echo 0)
if [ "$c1_deliv" -ge 1 ] && [ "$c1_seen" -ge 1 ]; then C1=PASS; else C1=FAIL; fi

# Contract 2: both hooks fired on PostToolUse
c2_lucid=$(grep -c '"by":"lucid-inject"' hooks-fired.log 2>/dev/null || echo 0)
c2_other=$(grep -c '"by":"other-project"' co-run.log 2>/dev/null || echo 0)
if [ "$c2_lucid" -ge 1 ] && [ "$c2_other" -ge 1 ]; then C2=PASS; else C2=FAIL; fi

# Contract 3: longest transcript-idle gap during the tool-free reasoning window
C3_GAP=$(perl - "$T2_START" "$T2_END" <<'PERL'
my ($ws,$we)=@ARGV;
open(my $fh,'<','samples.log') or do { print "NA"; exit };
my ($prev_t,$prev_sz,$maxgap,$firstgrow,$base_sz);
while(<$fh>){
  my ($t,$sz,$mt)=split;
  next unless defined $sz;
  next if $ws && $t < $ws;
  last if $we && $t > $we;
  $base_sz //= $sz;
  if(defined $prev_sz){
    if($sz == $prev_sz){
      # still idle; extend running gap from prev change
    } else {
      $firstgrow //= $t;
      my $g = $t - $prev_t; # not used for idle; recompute below
    }
  }
  $prev_t=$t; $prev_sz=$sz;
}
# second pass: longest run where size constant
open($fh,'<','samples.log');
my (@rows);
while(<$fh>){ my($t,$sz,$mt)=split; next unless defined $sz;
  next if $ws && $t<$ws; last if $we && $t>$we; push @rows,[$t,$sz]; }
$maxgap=0; my $runstart=@rows?$rows[0][0]:0; my $cur=@rows?$rows[0][1]:0;
for my $i (1..$#rows){
  if($rows[$i][1]!=$cur){ my $g=$rows[$i][0]-$runstart; $maxgap=$g if $g>$maxgap; $runstart=$rows[$i][0]; $cur=$rows[$i][1]; }
}
if(@rows){ my $g=$rows[-1][0]-$runstart; $maxgap=$g if $g>$maxgap; }
printf "%d", $maxgap;
PERL
)

{
  print -r -- "RUN_TOKEN=$RUN_TOKEN"
  print -r -- "rc=$rc"
  print -r -- "C1_injection=$C1 (deliveries=$c1_deliv, feedback_seen=$c1_seen)"
  print -r -- "C2_corun=$C2 (lucid_fires=$c2_lucid, other_fires=$c2_other)"
  print -r -- "C3_reasoning_window_ms=[$T2_START,$T2_END] longest_transcript_idle_ms=$C3_GAP"
  print -r -- "hook_counts:"; [ -f hooks-fired.log ] && jq -r '.hook + " " + (.by // "-")' hooks-fired.log | sort | uniq -c
  print -r -- "corun_counts:"; [ -f co-run.log ] && jq -r '.by' co-run.log | sort | uniq -c
  print -r -- "work_files:"; find work -maxdepth 1 -type f | sort
} | tee verdict.txt

exit "$rc"
