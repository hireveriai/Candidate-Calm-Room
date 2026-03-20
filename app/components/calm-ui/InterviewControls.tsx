export default function InterviewControls() {
  return (
    <div className="flex items-center justify-between">

      {/* Skip */}
      <button className="text-white/40 hover:text-white text-sm">
        Skip
      </button>

      {/* Continue */}
      <button className="px-6 py-2 bg-white text-black rounded-full text-sm font-medium hover:bg-white/90">
        Continue ▶
      </button>

    </div>
  );
}