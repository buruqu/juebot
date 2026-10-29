# 0.3.0-dev.2 independent candidate

Not installed. Retains the complete 0.2 setup/storage payload; only the setup console is active in the patch. New agent and legacy storage hosts default disabled. No database initialization by default.

One native client loader registers agent panel `juebot` and legacy setup panel `juebot-setup`. Agent Host entry binds the application factory, but real connector, model, permissions and account ports remain explicitly unconfigured.

Rebuild with `tools/build_agent_candidate.py`; inspect `build-receipt.json` and `artifacts/bundle-manifest.json` for exact inputs, payload hashes and protected baselines. No installation or deployment command is invoked. VM panel verification is not real DSH/browser acceptance.
