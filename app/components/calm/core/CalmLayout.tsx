"use client";

export default function CalmLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex min-h-[100dvh] w-full flex-col overflow-x-hidden bg-[#080c14] text-white">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_10%,rgba(50,91,140,0.13),transparent_34%),radial-gradient(circle_at_85%_85%,rgba(28,63,105,0.1),transparent_34%)]" />
      <div className="pointer-events-none absolute inset-0 opacity-[0.035] [background-image:linear-gradient(rgba(255,255,255,0.25)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.25)_1px,transparent_1px)] [background-size:64px_64px]" />
      {children}
    </div>
  );
}
