#!/usr/bin/env node
// The in-function probe, driven from outside it.
//
// `run.mjs` measures snapshot arrival gaps from a real browser: the marker's
// interpolated pose, some number of hops away from whatever actually caused a
// gap. README's "What the runs do not prove" names the hole this closes:
// arrival gaps of 250 to 433ms a few times an hour per client, with nothing in
// the library's own events near most of them, and no way to say whether the
// tail belongs to the function-to-Redis leg, Redis itself, the relay, or the
// browser's own socket. `/api/probe` runs the identical PING and
// PUBLISH/SUBSCRIBE round trips FROM INSIDE a Vercel function, with the
// browser, the relay and half the network removed from the path. This script
// is the client for that one route: one HTTP call, a wait of about
// `--seconds` seconds while the function samples, one JSON answer at the end.
//
//   node bench/probe.mjs --url <base-url> --key <SESSION_SECRET> [--seconds 60]
//
// READING IT AGAINST A `run.mjs` RUN: a tail that shows up HERE is the Redis
// path, measured with the browser and the relay both out of the way. A tail
// `run.mjs` sees that this route never reproduces the same night is the relay
// or the client's own socket instead, not Redis.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const USAGE = `
tickroom-bench: call the in-function Redis latency probe and report what it measured.

  node bench/probe.mjs --url <base-url> --key <SESSION_SECRET> [options]

Options:
  --url <url>      Base URL of the deployment. Required. Example: https://tickroom-bench.vercel.app
  --key <secret>   The deployment's SESSION_SECRET. Required: the route answers 401 without it,
                    on purpose, because it burns function time and must not be public.
  --seconds <n>    How long the probe samples for. Default 60. The route itself bounds this
                    5 to 240, so an out-of-range value here is silently clamped there, not here.
  --out <dir>      Where the JSON result goes. Default bench/out.
  --help           This.
`.trim();

function parseArgs(argv) {
  const out = { seconds: 60, out: join(HERE, 'out') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    else if (a === '--url') out.url = argv[++i];
    else if (a === '--key') out.key = argv[++i];
    else if (a === '--seconds') out.seconds = Number(argv[++i]);
    else if (a === '--out') out.out = resolve(argv[++i]);
    else return { error: `unknown argument: ${a}` };
  }
  if (!out.url) return { error: 'missing --url' };
  if (!out.key) return { error: 'missing --key' };
  if (!Number.isFinite(out.seconds) || out.seconds <= 0) return { error: '--seconds must be a positive number' };
  return out;
}

function fmtMs(ms) {
  return ms === null || ms === undefined ? '?' : `${ms}ms`;
}

function renderMarkdown(result, file) {
  const lines = [];
  lines.push(`# tickroom probe, ${new Date().toISOString()}`);
  lines.push('');
  lines.push(
    `${result.seconds}s sampled, region \`${result.region ?? 'unknown'}\`, redis \`${result.redisHost}\`. ` +
      `Raw JSON: \`${file}\`.`
  );
  lines.push('');
  lines.push('| series | count | p50 | p90 | p99 | max |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const name of ['ping', 'pubsub']) {
    const s = result[name];
    lines.push(`| ${name} | ${s.count} | ${fmtMs(s.p50)} | ${fmtMs(s.p90)} | ${fmtMs(s.p99)} | ${fmtMs(s.max)} |`);
  }
  lines.push('');
  if (result.over150.length) {
    lines.push(`Samples over 150ms: ${result.over150.length}.`);
    for (const s of result.over150) {
      lines.push(`- at ${(s.atMs / 1000).toFixed(1)}s, ${s.series}, ${s.ms}ms`);
    }
  } else {
    lines.push('No sample over 150ms: this run puts no part of the tail in the Redis path.');
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.error) {
    console.error(`${args.error}\n\n${USAGE}`);
    return 2;
  }

  const target = new URL('/api/probe', args.url);
  target.searchParams.set('seconds', String(args.seconds));
  target.searchParams.set('key', args.key);

  console.error(`[probe] ${target.origin}/api/probe, about ${args.seconds}s`);
  const startedAt = new Date();
  const res = await fetch(target.toString());
  const bodyText = await res.text();
  if (!res.ok) {
    console.error(`[probe] ${res.status}: ${bodyText}`);
    return 1;
  }
  const result = JSON.parse(bodyText);

  await mkdir(args.out, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const file = join(args.out, `probe-${stamp}.json`);
  await writeFile(file, JSON.stringify(result, null, 2));

  console.log(renderMarkdown(result, file));
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
