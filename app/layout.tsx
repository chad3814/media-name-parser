import type { ReactNode } from 'react';

export const metadata = {
  title: 'media-name-parser',
  description: 'Filename to media identity lookup',
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
