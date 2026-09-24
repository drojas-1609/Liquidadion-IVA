import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tax Liquidator",
  description: "Professional Tax Liquidation App",
};

/**
 * Layout raíz: solo el documento. NO incluye la barra lateral ni lee la
 * sesión; el shell autenticado vive en `app/(app)/layout.tsx`, así las
 * páginas públicas de auth nunca lo heredan (ni tras el logout).
 */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
