# SubView

SubView is a privacy-first Manifest V3 browser extension that detects likely trial/subscription checkouts before completion, then helps users set local reminders and find cancel/manage paths.

## Why SubView

- Detects trial/subscription checkout signals in-page before commitment.
- Adds a just-in-time, non-blocking warning overlay.
- Lets users schedule local reminders and export `.ics` events.
- Keeps detection and storage local to the browser.

## Privacy First

- Detection runs locally in the browser.
- No bank/email access.
- No page content is uploaded.
- No remote API calls for heuristic detection in MVP.
- Stored data is limited to extension settings and reminder metadata.

## Features

- Heuristic trial/subscription detection with confidence scoring.
- SPA-aware rescans after in-app navigation and DOM mutations.
- Interception flow with replay-safe continue behavior for modern SPAs.
- Reminder scheduling via `chrome.alarms` and `chrome.notifications`.
- ICS export for reminder events.
- Local dark-pattern hints (`difficulty`, `method`, `steps`, `manageUrl`).
- Local user reports for cancellation difficulty.
- Optional debug HUD (`debugOverlay`) for tuning.

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Build extension:

```bash
npm run build
```

3. Load unpacked extension from `dist/` in Chrome/Edge.

## Build Modes

- `npm run build` uses `manifest.json` (public mode).
- `npm run build:dev` uses `manifest.dev.json` (dev mode with broader host model).
- Both output to `dist/`.

## Development Commands

```bash
npm run watch       # dev rebuild on file changes
npm run typecheck   # TypeScript checks
npm run test        # Vitest unit tests
npm run test:watch  # Vitest watch mode
```

## Permissions Model

- Uses `optional_host_permissions` for `<all_urls>`.
- On onboarding, users can explicitly grant all-sites access.
- If not granted, popup/options still work while detection stays inactive on pages.

## Stored Data

- `tg_schema_version`
- `tg_settings`
- `tg_reminders`
- `tg_detections_recent` (ring buffer, max 50)
- `tg_darkpatterns_base`
- `tg_darkpatterns_user`
- `tg_user_reports`
- `tg_notification_map` (TTL routing for notification actions)
- `tg_pending_detection_by_tab` (session-only pending interception state)

## Testing

- Unit tests run with Vitest + JSDOM.
- Current suites focus on:
  - Interceptor replay resilience in SPA-like DOM teardown cases.
  - Detector lazy context evaluation and trial parsing behavior.

## CI

GitHub Actions workflow: `.github/workflows/ci.yml`

Pipeline steps:

1. Install dependencies
2. `npm run typecheck`
3. `npm run test`
4. `npm run build`

Triggers:

- Push to `main` or `master`
- Pull requests to `main` or `master`
- Manual dispatch

## Branch and PR Practices

- Create feature branches from `main` (e.g. `feat/my-feature`, `fix/my-fix`).
- Open a pull request against `main`; CI must pass before merging.
- Keep pull requests focused; avoid mixing unrelated changes.
- Squash or rebase before merging to keep history clean.

## Project Structure

```
src/
  background/   # service worker, storage, reminders, ICS
  content/      # observer, heuristics, detector, interceptor, overlay
  options/      # options UI
  popup/        # popup UI
  shared/       # shared types, messaging, domain/time/utils
```

## Manual Acceptance Checklist

1. Trial text is detected on a checkout-like page.
2. Interceptor overlay appears before commit action.
3. Continue resumes correctly (including SPA fallback cases).
4. Dismiss does not force checkout continuation.
5. Reminder is saved and alarm is scheduled.
6. Notification opens site/manage destination.
7. ICS file downloads with valid event fields.
8. Disabled domain suppresses interception.
9. Export/import round trip restores data safely.

## Known MVP Limitations

- `domainKey` parsing is best-effort and not full public-suffix coverage.
- Google Calendar OAuth integration is intentionally not implemented in MVP.

