import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover", // respect notches / safe areas on modern phones
};

export const metadata: Metadata = {
  title: "GoMina 360 | All-In-One Enterprise Command Center",
  description:
    "Enterprise management and decision-support operating system for a Ghana-based business owner. Securely manage Poultry, Block Factory, Aquaculture, Livestock, Restaurant, Electronic Shop, Car Wash, and Hardware Store units from one centralized HQ.",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icons/icon-192.png", apple: "/icons/icon-192.png" },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="bg-slate-950 text-slate-100 antialiased min-h-screen selection:bg-emerald-500 selection:text-white">
        {children}
      </body>
    </html>
  );
}
