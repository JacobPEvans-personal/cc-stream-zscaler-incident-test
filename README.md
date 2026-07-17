# cc-stream-zscaler-incident-test

Evidence-grade reproduction harness for a Cribl Stream route-cloning incident:
a non-final DEV route cloning events into a dev copy of the Zscaler pack
(which overwrites `index`/`sourcetype` at pipeline end) coincided with a >50%
drop in production event counts the moment dev sampling was disabled.

Each scenario spins up a **real Cribl Stream container**, installs replica
packs via the management API, pushes 1000 known events through a scenario
route table, and counts exactly what lands at each destination, broken down
by `index/sourcetype` and de-duplicated by sequence number.

## Installation

```bash
# Requires Docker and Node >= 22.6 (uses --experimental-strip-types)
git clone https://github.com/JacobPEvans-personal/cc-stream-zscaler-incident-test.git
cd cc-stream-zscaler-incident-test
```

## Usage

```bash
# Run every scenario (~2 min each, sequential; writes results/*.json + REPORT.md)
node --experimental-strip-types e2e/run.ts scenarios/*

# Run one scenario
node --experimental-strip-types e2e/run.ts scenarios/s2-incident-unguarded
```

In GitHub Actions: run the **Incident Matrix** workflow (`workflow_dispatch`).
It writes the per-scenario table to the run's Step Summary, uploads
`results/` as an artifact, and commits the refreshed `REPORT.md`.

## Scenarios

| Scenario | Question it answers |
| --- | --- |
| `s1-baseline` | Control: prod route alone passes 1000/1000 untouched |
| `s2-incident-unguarded` | The incident config: does an unguarded dev overwrite bleed into prod? |
| `s3a-guard-eval` | Support's fix: `clone==true` guard on the overwrite eval |
| `s3b-guard-route-filter` | Mis-scoped guard: `clone==true` in the WG route filter matches nothing |
| `s4-sampled-unguarded` | Pre-incident steady state: sampling 1:10, unguarded |
| `s5-guard-pack-routes` | Guard on the pack's internal route filters instead of the eval |
| `s6-empty-clone-spec` | UI "Add clone" left empty (`clones: [{}]`) semantics |
| `s7-dual-dest` | Prod dual-destination shape (Splunk + S3) via two same-filter routes |

## Layout

- `common/` — shared input (tcpjson :10070), filesystem destinations, passthrough pipeline
- `packs/` — prod replica + four dev variants of the Zscaler pack (differ only in sampling/guard placement)
- `scenarios/<id>/` — `route.yml`, `expect.json`, `packs/` symlinks (fully diffable)
- `e2e/run.ts` — the entire runner: container lifecycle, pack install, sender, counter, reporter
- `REPORT.md`, `results/` — latest committed evidence

See [REPORT.md](REPORT.md) for current findings.

## Contributing

Open a PR. The matrix runs automatically on PRs touching scenarios, packs, or the runner.

## License

MIT

---

Part of the [JacobPEvans](https://docs.jacobpevans.com) ecosystem.
