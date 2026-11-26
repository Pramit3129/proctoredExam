import type { Metadata, Viewport } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Exams", template: "%s · Exams" },
  description: "Proctored online exams.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  colorScheme: "light",
  themeColor: "#f5f5f7",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full">
      <body className="flex min-h-full flex-col">
        {/* The app's own root; the proctor treats anything else added directly to <body> as injected. */}
        <div data-app-root className="contents">
          {children}
        </div>
      </body>
    </html>
  );
}
