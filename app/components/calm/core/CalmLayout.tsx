"use client";

export default function CalmLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="h-screen w-screen bg-[#0B0F1A] text-white flex flex-col items-center justify-center overflow-hidden">
      {children}
    </div>
  );
}