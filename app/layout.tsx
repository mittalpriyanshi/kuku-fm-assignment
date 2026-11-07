import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Promo Finder",
  description: "Finds 20-60 s promos in microdrama screenplays: hook in 3 s, ends on a cliffhanger, makes sense to a stranger.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
