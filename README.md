# `@replay/web-sdk`

Browser session replay capture built on top of `rrweb`.

## Scope

Included:
- rrweb snapshots
- console capture
- fetch / XHR telemetry
- unhandled error capture
- navigation tracking
- viewport tracking
- batch upload to replay ingest API

## Example

```ts
import { initReplay } from "@replay/web-sdk";

const replay = initReplay({
  apiKey: "pk_live_123",
  apiHost: "https://api.example.com",
  captureConsole: true,
  captureNetwork: true,
  captureErrors: true,
  maskAllInputs: true
});
```

## Expected ingest contract

The SDK posts `ReplayBatchEnvelope` payloads to:

`POST /v1/replay/batch`

Expected headers:
- `content-type: application/json`
- `x-replay-api-key: <project api key>`

Expected JSON response:

```json
{
  "accepted": true,
  "acceptedSequence": 1,
  "sessionId": "sess_123"
}
```

## Storage expectations

The backend should:
- store the raw replay batch in object storage
- persist session and segment manifests in PostgreSQL
- enqueue projection work to BullMQ
- write console/network/error projections into ClickHouse
