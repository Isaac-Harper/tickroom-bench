import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'tickroom bench',
  description: 'A tickroom room on a real Vercel deployment, instrumented for measurement.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
