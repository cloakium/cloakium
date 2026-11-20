# Targeted native analysis

Use this only after a measured gap needs a cause. Analysis is not a substitute
for a behavioural probe, and presence of code is not execution.

## Preconditions

1. One engine owner: a single resolved binary path with a known digest.
2. A known checkpoint: record the analysis settings, triple, selected symbols
   and tool version before the first query, so a later run can be compared.
3. A stated question that a symbol, callback or configuration value can answer.
4. A wall-clock deadline and a memory budget for the whole analysis.

## Scope discipline

- Start with analysis disabled and enable only what the question needs. A
  whole-binary pass is a different, much more expensive operation.
- Use the correct triple for the binary, and confirm it from the file rather than
  from the target name.
- Select callbacks by ELF relocation records plus control-flow integrity, then
  inspect only those functions. Do not treat a relocation record as a struct.
- Prefer a selected call graph from the callback of interest over a whole-binary
  no-return index. A global index answers a different question and is expensive.
- Decode at true instruction boundaries. Byte-pattern scanning produces
  plausible-looking instructions that were never executed.

## Completeness labels

Label coverage explicitly: which functions were inspected, which were skipped,
and why. "Complete" means the stated question was answered for the named
functions, not that the binary was fully decompiled. An incomplete run that
claims completeness is worse than a narrow run that is honest.

## Full analysis

Permitted only with an explicit reason, a time and memory budget, and a bounded
deadline. Keep the original job identity from the start. On timeout, inspect
liveness once: the job may still be running. Do not relaunch it, and do not
start a second overlapping analysis. Export values you still need before any
restart.

## Bounded negative probes

Before recording a conclusion, test the alternative explanations:

| Claim | Negative probe |
| --- | --- |
| A symbol name was recovered | search literal and qualified-name starts, including UTF-16 forms |
| A C++ structure exists | check whether the match is only a relocation record or a type-name string |
| Type metadata exists | distinguish a CFI stub or hash from live heap type metadata |
| A behaviour exists | check whether the matching code is only an emitter, not a path reached at runtime |

A bounded probe set is enough: each probe must have a defined bound (input size,
string length, number of candidates) and must stop when the bound is reached.
Record a negative result as evidence, not as an absence proof for the whole
binary.

## Privacy

Raw code and decompiled output are private. Keep them in the private evidence
root. A follow-up implementation agent receives the specification, public
documentation and original tests, never the raw export and never vendor source.
Anyone implementing a change from this analysis must be able to work from a
clean-room description alone.
