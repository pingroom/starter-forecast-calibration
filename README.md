# PingRoom forecast calibration

Collect a named teammate's probability estimates for future operational events, then score them against outcome receipts recorded later. Each event asks for **10%, 30%, 70%, or 90%** through a PingRoom Question. A local report shows binary Brier scores and the observed fraction in each probability bucket.

## Try it offline

Requires Node.js 22 or newer on macOS or Linux, with persistent private storage. Choose **Use this template**, clone your repository, then:

```sh
npm ci
npm run demo
npm test
```

The demo uses the real pinned SDK with an in-memory HTTP transport, a synthetic October 2026 clock, and temporary files. It needs no credentials and sends nothing. Its two scored events produce a mean Brier score of `0.09`.

## Connect and run

1. Copy `examples/forecast.json` to `forecast.json`. Replace the sample dates with future UTC dates and write 1–12 binary event statements with an objective observation rule. `forecastBefore` is the exclusive answer cutoff; `observeAfter` is when outcome receipts may first be imported. Each statement is 1–200 printable ASCII characters. Neither the manifest nor the request contains known outcomes.
2. Install or open [PingRoom](https://pingroom.io/i). Run `npm run connect`, open the printed private pairing link, and select a **standard private room** containing the intended participant. Grant room read, Question read, and Question ask access. Pairing creates `.pingroom/credentials.json`; rerunning an unfinished pairing reuses its saved link while valid.
3. Run `npm run inspect`. Copy `config.example.json` to `config.json` and fill in the intended person's member UUID and a local label. Inspect prints bounded member names as lookup aids; verify the exact person in the app. A display name alone does not establish identity.
4. Run `npm start -- build-duration` before that event's cutoff. Answer in PingRoom, then run the same command to read the result. Use each event's ID from your manifest. `npm start` without an ID chooses the earliest unasked event, then the least recently checked pending event.

Each invocation creates or reads at most one Question. There is no background scheduling. **Start within your actual response window:** a Question lives for at most 24 hours, even if the event cutoff is days away. This starter sends only one Question per event and never reissues an expired, cancelled, invalid, or answered Question. An event first reached at or after its cutoff is marked missed without sending; fewer than 30 seconds remaining is also missed. Unasked events that pass their cutoff are closed on the next run.

For an existing registration or CI, set **both** `PINGROOM_TOKEN` and `PINGROOM_ROOM`. A complete external environment pair overrides saved credentials and `.env`; any partial or blank pair is rejected. Otherwise, `.env` is parsed locally, followed by saved credentials if neither variable is set. Room codes are normalized to uppercase. Keep the original credential: Question reads are scoped to the asking registration, and this study also binds its journal to the exact credential hash. A fresh pairing cannot recover another registration's Questions.

## Import outcomes and report

After `observeAfter`, create a receipt in an ignored `outcomes/` directory. Copy `examples/outcome.json`, substitute the `manifestHash` shown by `npm run status`, and set the event ID, UTC observation timestamp, outcome, and a short evidence reference:

```json
{
  "version": 1,
  "manifestHash": "COPY_FROM_STATUS",
  "eventId": "build-duration",
  "observedAt": "2026-10-25T00:05:00.000Z",
  "outcome": true,
  "sourceReference": "CI job 1042: build duration 12m18s"
}
```

```sh
npm run outcome -- build-duration outcomes/build-duration.json
npm run report
```

The outcome command checks the event's observation date **before reading the receipt file**. `observedAt` must be at or after that date and no later than import time. Use `true` or `false` for resolved events; `null` permanently records an unresolved event. The source reference is stored as text; the starter neither fetches it nor verifies whether the event occurred. Keep outcome files unavailable to this workflow until observation time; the clock gate cannot establish when an operator learned an outcome.

Receipts are immutable after import, including unresolved receipts. Reimporting the same normalized receipt is a no-op; changing its result, evidence, or timestamp fails. Preserve the original manifest and config. Use a separate checkout and study for future events; do not reset a journal to change an existing result.

`npm run status` reads saved state. `npm run report` also writes `.forecast/report.json`. Both are offline and need no credential. The report contains statements, participant UUID/label, Question IDs, probabilities, outcome references, and scores; keep it private.

## Interpreting scores

For a scored event, the [binary Brier score](https://scikit-learn.org/stable/modules/generated/sklearn.metrics.brier_score_loss.html) is `(p - y)²`, where `p` is the chosen probability and `y` is 1 for true or 0 for false. Scores range from 0 to 1; lower is better. The mean weights each scored event equally. Each bucket reports the number of scored events at that probability and their true-outcome fraction; an empty bucket has a null fraction.

An event is scored only when its Question was created strictly before `forecastBefore`, the named participant answered strictly before that cutoff, and a `true`/`false` outcome has been imported. Equality at the cutoff is late. Pending, missed, late, expired, cancelled, invalid, unknown-creation, and unresolved-outcome events remain unscored; their scores are null, never zero. The scored subset can be selective. A small bucket does not establish calibration, and this is not a complete performance or SLA measure.

Server creation/answer timestamps establish the recorded timing. They do not establish phone delivery, reading time, or independence from prior knowledge. Synchronize the machine clock. The CLI uses wall-clock UTC; only the demo injects a synthetic clock. The local journal detects malformed or inconsistent records, not deliberate coordinated edits by someone with filesystem access.

## Recover an uncertain create

The journal saves the exact request and unique event intent before sending. A lost response or failed local save leaves `create_unknown`. **No POST is automatically retried**, even though the request carries an idempotency key. Other events can still proceed.

```sh
npm run find-id -- build-duration
npm run recover -- build-duration EXACT_QUESTION_UUID
```

Find searches a bounded recent list from the same registration and prints matching candidates; an empty list does not prove the Question was never created. Recovery performs an exact GET and checks the saved prompt, options, event data, room, participant, correlation ID, asking registration evidence, and timestamps. It never sends. If no verified ID can be recovered, keep that event unknown and unscored. Do not delete its journal or reconnect to force a resend. A terminal Question is never reopened. If another client cancels it, the next read records cancellation.

Pairing uncertainty is separate: if registration creation lost its response, inspect Connected Agents and resolve that registration manually before removing its local pairing record. An expired or rejected saved pairing also requires deliberate cleanup; it is not silently replaced.

## Adapt and operate

Replace the sample manifest with release-duration, backlog, or other objectively observable binary events. Integrate `step()` from `src/forecast.js` into a scheduler that selects an event before its response window closes; it performs no deployment or operational action. Feed receipts from your own reviewed observation process through `recordOutcome()` after observation time. Keep the manifest fixed for the study.

The transport permits only room/Question reads and Question creation, plus pairing in the connect command. Requests include body reads in a 5-second deadline, refuse redirects, and cap responses at 512 KiB. Runtime networking has a 30-second overall deadline. Local inputs are bounded to 16 KiB and state/report files to 1 MiB. The SDK is pinned to `@pingroom/sdk` 0.6.0; `.npmrc` retains the 14-day minimum release age policy.

Private files use mode `0600`, directories `0700` on POSIX. Writes sync a temporary file, rename it, and sync the directory. Keep `.pingroom/` and `.forecast/` on a trusted local filesystem with a single writer; the lock is not a distributed coordination system. If a lock remains after a crash, stop every process using this study before removing `.forecast/.lock` (or `.pingroom/.lock` for pairing). Restore damaged state from a trusted backup; malformed JSON and JSON `null` are errors, not a fresh start.

Exit codes: `0` for a completed command, `3` when unasked/pending forecasts remain, `4` when any creation is uncertain, `1` for an error, and `130` on interruption. Unscored terminal events are reported without turning them into successful forecasts. Permission or network failures preserve prior evidence. Raw API errors are suppressed so responses cannot leak credentials into logs.

Related templates: [preference ranking](https://github.com/pingroom/starter-preference-ranking), [response metrics](https://github.com/pingroom/starter-response-metrics), and [label agreement](https://github.com/pingroom/starter-label-agreement).

[Official SDK](https://github.com/pingroom/sdk) · [MIT license](LICENSE)
