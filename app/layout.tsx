import './globals.css';

import type { ReactNode } from 'react';
import { Geist } from "next/font/google";
import { cn } from "@/lib/utils";
import { AppShell } from '../components/app-shell';

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

export const metadata = {
  title: 'OpenMetadata',
  description: 'Filename to media identity lookup',
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en" className={cn("font-sans", geist.variable)}>
      <body><AppShell>{children}</AppShell></body>
    </html>
  );
}
