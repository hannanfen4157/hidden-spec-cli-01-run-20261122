# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/hannanfen4157/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/hannanfen4157/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line patch tool for every AI edit format. It applies unified diffs (even with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and JSON text-editor tool calls to a tree of text files, finds the lines each edit names at the first of three matching tiers (exact, trailing whitespace, then indentation), and writes every change or none.

## Run it

```sh
node main.ts [options] [PATCH]
```

`node main.ts --format=unified patch.diff`, or pipe the patch on stdin with `node main.ts -`. `--check` reports what would change without writing anything; `--strict` matches lines exactly. See `SPEC.md` for the whole contract.

## Files

- `main.ts`: the CLI, Node 22 and its standard library alone. No install step, no network, no randomness: the same check gives the same exit code, stdout and files every run.
- `runner.ts`: the kit's trial runner, kept as it is.
- `check.ts`: runs `main.ts` on the kit's public practice set.
- `SPEC.md`: the specification this tool implements.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
