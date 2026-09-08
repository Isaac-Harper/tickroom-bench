import type { ClientInput } from 'tickroom/core';

/**
 * The relay's frame decoder. The page sends one JSON array of `ClientInput` per
 * message: the last `INPUT_WINDOW` stamped records, oldest first, re-sent whole
 * on every packet, which is the shape `examples/pong/client.ts` documents and
 * the reason a single lost packet is not a starved tick.
 *
 * THE PARAMETER IS `unknown` RATHER THAN `ArrayBuffer`, and that is not
 * defensive typing. The real transport behind the relay route is the `ws`
 * package, which hands over a `Buffer`. A FRAGMENTED message (an array of
 * buffers, chosen by the peer or by a proxy) used to reach this decoder as an
 * array and had to be joined here; tickroom 0.3.0's relay joins fragments
 * itself before `decodeInput` is ever called, so this decoder sees only what
 * `attachRelay` now promises: a single `Buffer`.
 *
 * IT IS ALSO WHY THIS FILE STILL EXISTS AT 1.0.0. The relay's default decoder
 * is `decodeInputAuto` now, which reads both wires (the binary input window and
 * this JSON frame, sniffed on the first byte) and answers anything malformed
 * with `[]` rather than throwing. That is the right default and it is the wrong
 * one HERE: `onBadInput` in `app/api/ws/route.ts` counts throws, and a counter
 * wired behind a decoder that never throws reads zero forever, which on a bench
 * is a broken decoder reported as a healthy one. So this app keeps its own
 * throwing decoder, and the page keeps `predict.wire: 'json'` so that what
 * arrives is what this parses.
 *
 * THIS IS A TRUST BOUNDARY. Everything it returns was chosen by a client, so it
 * validates the SHAPE here (an object at all, a finite `seq`, a finite
 * `targetTick`) and leaves the VALUES to the simulation's own clamping, which
 * is where they belong: the simulation is the last place that can refuse a
 * paddle direction of 1e9, and it is the layer a second client (the bench's own
 * bot, a different renderer) also has to pass through. Throwing rejects the
 * frame silently, which is the contract `attachRelay` documents, and the relay
 * route counts those throws through `onBadInput` rather than logging one per
 * frame.
 */
export function decodeJsonInput(data: unknown): ClientInput[] {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(data as Buffer));
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const out: ClientInput[] = [];
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue;
    const rec = item as { seq?: unknown; targetTick?: unknown; data?: unknown };
    const seq = typeof rec.seq === 'number' && Number.isFinite(rec.seq) ? rec.seq : 0;
    // STAMPED, unlike the older demo's two games: this room predicts its own
    // paddle locally, so the record has to name the tick it applies on or the
    // prediction is wrong by construction and every snapshot arrives as a
    // correction. A non-finite stamp becomes 0, which means apply-on-arrival
    // rather than a tick the room may never reach.
    const targetTick =
      typeof rec.targetTick === 'number' && Number.isFinite(rec.targetTick) ? rec.targetTick : 0;
    out.push({ seq, targetTick, data: rec.data });
  }
  return out;
}
