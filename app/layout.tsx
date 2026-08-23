import type { Metadata, Viewport } from "next";
import { cache } from "react";
import { Baloo_2, Nunito } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import { NavTabs } from "./nav-tabs";
import { LevelBadge } from "./level-badge";
import { Froggy } from "./components/froggy";
import { ThemeToggle } from "./theme-toggle";
import { WhatsAppAccountControl } from "./whatsapp-account-control";
import { LogoutButton } from "./logout-button";
import { getTenantSession } from "@/lib/tenant-context";
import { getSettings } from "@/lib/db";
import { ServiceWorkerRegistration } from "./service-worker-registration";

const themeBootstrap = `(function(){try{var t=localStorage.getItem('daily-cart-theme');if(t!=='light'&&t!=='dark')t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme='light'}})()`;

const baloo = Baloo_2({
  variable: "--font-baloo",
  subsets: ["latin"],
});

const nunito = Nunito({
  variable: "--font-nunito",
  subsets: ["latin"],
});

const tenantBrand = cache(async () => {
  const session = await getTenantSession();
  const settings = session ? await getSettings().catch(() => null) : null;
  return {
    session,
    businessName: settings?.business_name?.trim() || "WhatsApp Command Center",
  };
});

export async function generateMetadata(): Promise<Metadata> {
  const { businessName } = await tenantBrand();
  return {
    title: `${businessName} — Command Center`,
    description: "A WhatsApp COD command center",
    manifest: "/manifest.webmanifest",
    appleWebApp: {
      capable: true,
      title: businessName,
      statusBarStyle: "default",
    },
    icons: {
      icon: [
        { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
        { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
      ],
      apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
    },
    formatDetection: { telephone: false },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbf7ef" },
    { media: "(prefers-color-scheme: dark)", color: "#12171b" },
  ],
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { session, businessName } = await tenantBrand();

  return (
    <html lang="en" suppressHydrationWarning className={`${baloo.variable} ${nunito.variable} h-full antialiased`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body className="flex h-dvh min-w-0 flex-col overflow-hidden">
        <ServiceWorkerRegistration />
        <header className="z-20 flex min-h-[3.75rem] min-w-0 shrink-0 items-center justify-between gap-2 border-b-2 border-cardline bg-surface/95 px-3 pb-2 pt-[calc(.5rem+env(safe-area-inset-top))] sm:px-4">
          {/* Left: Brand Identity & Level Badge */}
          <div className="flex min-w-0 shrink-0 items-center gap-2.5">
            <Link
              href="/"
              className="flex items-center gap-2 rounded-xl transition hover:opacity-90 focus-visible:outline-2 focus-visible:outline-frog"
            >
              <Froggy mood="happy" size={36} bob={false} />
              <span className="hidden max-w-[8.5rem] truncate font-display text-base font-extrabold tracking-tight text-frog-dark min-[360px]:block sm:max-w-none sm:text-lg">
                {businessName}
              </span>
            </Link>
            <div className="hidden xl:block ml-1">
              <LevelBadge />
            </div>
          </div>

          {/* Navigation Links */}
          <NavTabs />

          {/* Right Utility Cluster */}
          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            <div className="hidden md:block xl:hidden">
              <LevelBadge />
            </div>
            <div className="hidden min-[360px]:block">
              <WhatsAppAccountControl />
            </div>
            <ThemeToggle />
            {session && (
              <div className="hidden sm:block">
                <LogoutButton />
              </div>
            )}
          </div>
        </header>
        <main className="app-content min-h-0 min-w-0 flex-1 overflow-auto">{children}</main>
      </body>
    </html>
  );
}
