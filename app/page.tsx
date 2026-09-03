'use client';

// The whole app, as one client component.
//
// A CLIENT COMPONENT RATHER THAN A SERVER ONE READING `searchParams`, and the
// reason is the harness rather than taste: `bench/run.mjs` opens this page N
// times with different query strings and then polls `window.__bench`, so the
// query has to be readable on the same tick the connection is built and the
// connection has to live in the browser. Routing the parameters through a
// server component would put a render boundary between the URL the harness
// chose and the socket it is measuring, for no benefit at all.

import { useEffect, useRef, useState } from 'react';

import { startPong } from '@/game/pong';
import { BASE } from '@/lib/rooms';

/**
 * Field aspect, fixed. The canvas is 200x120 units in `sim/pong.ts` and the
 * backing store is a whole multiple of that so the render never resamples: the
 * marker's rendered position is what the analysis reads, and a fractional scale
 * would put a rounding step of its own into it.
 */
const CANVAS_W = 800;
const CANVAS_H = 480;

export default function Page() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /**
   * READ ONCE, IN AN EFFECT, and held in state so the first server-rendered
   * pass and the first client pass agree. Reading `location.search` during
   * render is a hydration mismatch: the server has no `location`, so the two
   * passes would disagree on every one of these values.
   */
  const [params, setParams] = useState<{ room: string; name: string; bot: boolean } | null>(null);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    setParams({
      room: q.get('room') ?? BASE,
      name: q.get('name') ?? 'anon',
      bot: q.get('bot') === '1',
    });
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !params) return;
    // The teardown is returned by `startPong` and run by React on unmount. A
    // connection that outlives its canvas keeps a socket open, keeps the room's
    // player count wrong, and on a metered deployment keeps billing.
    return startPong(canvas, params);
  }, [params]);

  return (
    <main>
      <h1>tickroom bench</h1>
      <p>
        room <code>{params?.room ?? '...'}</code>
        {params?.bot ? ' | bot' : ' | keys: w/s or up/down'} | measurement surface on{' '}
        <code>window.__bench</code>
      </p>
      <canvas ref={canvasRef} width={CANVAS_W} height={CANVAS_H} />
      <div className="banner" id="stall">
        stalled: no snapshots. This usually self-heals; the room may be changing hands.
      </div>
      <div className="banner" id="terminal" />
    </main>
  );
}
