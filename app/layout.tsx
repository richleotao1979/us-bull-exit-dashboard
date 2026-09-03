import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "美股牛市逃顶仪表盘",
  description: "基于九大维度与多因子交叉验证的美股牛市末期风险监测系统。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
