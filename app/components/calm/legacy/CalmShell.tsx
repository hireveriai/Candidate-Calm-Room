// app/interview/[token]/CalmShell.tsx
export default function CalmShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="
      min-h-screen w-full
      bg-gradient-to-br from-[#070b14] via-[#0b1325] to-[#05070f]
      flex flex-col items-center justify-center
      text-white overflow-hidden
      relative
    ">
      {children}
    </div>
  )
}
