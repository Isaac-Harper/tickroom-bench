import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The Node runtime and the 300s duration cap are static exports of the route
  // files themselves, which is the only place Next reads them from, and there
  // is no `vercel.json` for the same reason. So the only thing here is the one
  // generator this repo does not want.
  //
  // `next dev` otherwise writes an AGENTS.md and a CLAUDE.md of its own on
  // first run, describing Next. This repo's own README is the document that
  // explains it, and a generated file that reappears on every dev run is a file
  // that will be committed by accident and then read as authoritative.
  agentRules: false,
};

export default nextConfig;
