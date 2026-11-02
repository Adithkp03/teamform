# Pre-publication history cleanup, 2 November 2026

Before making this repository public, local benchmark bearer tokens were replaced with `REDACTED_LOCAL_BENCHMARK_TOKEN` throughout Git history. Only token strings in 11 benchmark JSON files changed. Application code, benchmark metrics, test code and original commit messages were preserved. A private pre-rewrite backup is retained outside this public repository.

`commit-map-20261102.txt` maps original source commit IDs to their rewritten equivalents. Earlier reports, CI run records and the walkthrough cite original IDs because those are the versions actually tested. Those historical results are not new measurements of the rewritten IDs. Rewriting an ancestor changes descendant IDs even when their application code is identical.

The deployment and historical run links may continue to identify the original SHA until a new deployment or test run completes. Consult the map rather than interpreting an old source ID as a missing test or as a new run.
