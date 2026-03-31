# HeartBeatz Development Guidelines

## Architecture Principles

1. **Single responsibility** — each module does one thing well
2. **Observable** — every component exposes health metrics and structured logs (pino)
3. **Configurable** — all thresholds and parameters via environment variables or config
4. **Testable** — pure functions where possible, dependency injection for I/O
5. **Documented** — JSDoc on all public functions, inline comments for non-obvious logic

## Code Style

- **Language:** JavaScript (ES Modules, `"type": "module"` in package.json)
- **Runtime:** Node.js >= 18 (use native test runner, fetch, etc.)
- **Naming:** camelCase for variables/functions, UPPER_SNAKE for constants, PascalCase for classes
- **Error handling:** Always catch and log with context. Never swallow errors silently.
- **Logging:** Use pino logger. Levels: `error` (broken), `warn` (degraded), `info` (lifecycle), `debug` (detail)

## File Organization

```
server/
├── src/
│   ├── index.js              # Entry point, server bootstrap
│   ├── config.js             # Configuration loading
│   ├── csi-bridge.js         # CSI processing pipeline (core)
│   ├── features/             # NEW: Feature extraction modules
│   │   ├── index.js          # Feature pipeline orchestrator
│   │   ├── amplitude.js      # Amplitude statistics
│   │   ├── phase.js          # Phase difference extraction
│   │   ├── doppler.js        # Short-time FFT / Doppler
│   │   ├── correlation.js    # Subcarrier correlation
│   │   └── quality.js        # Frame quality scoring
│   ├── calibration/          # NEW: Baseline and calibration
│   │   ├── multi-timescale.js
│   │   ├── cusum.js
│   │   └── persistence.js
│   ├── ground-truth/         # NEW: Data collection & evaluation
│   │   ├── label-api.js
│   │   ├── storage.js
│   │   └── evaluator.js
│   ├── routes/
│   ├── middleware/
│   └── shared/               # NEW: Shared types and constants
│       ├── constants.js
│       └── types.js
├── public/
│   ├── dev-heatmap.html
│   └── ground-truth.html     # NEW: Label collection UI
├── data/                     # SQLite databases, persisted state
└── test/                     # Integration tests
```

## Branching Strategy

- `main` — stable, reviewed code only
- `feat/<description>` — feature branches, one per task
- Workers commit to feature branches
- Reviewer merges approved branches to main

## Commit Messages

Format: `<type>(<scope>): <description>`

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`
Scopes: `csi`, `features`, `calibration`, `ground-truth`, `ui`, `infra`

Example: `feat(features): add subcarrier grouping with 8 logical bands`

## Testing

- Use Node.js native test runner (`node --test`)
- Test files: `*.test.js` alongside source
- Minimum: unit tests for all pure functions
- Integration tests for API endpoints
- Ground truth evaluation for accuracy claims

## API Conventions

- REST endpoints under `/api/v1/`
- SSE streams under `/api/v1/stream/`
- Response format: `{ ok: true, data: {...} }` or `{ ok: false, error: "message" }`
- All timestamps in ISO 8601 UTC

## Performance Targets (MeLE N100)

- CSI processing: < 40% CPU at 20 frames/sec from 2 nodes
- API response: < 50ms for all REST endpoints
- SSE latency: < 100ms from frame receipt to client delivery
- Memory: < 512MB RSS for full server process
