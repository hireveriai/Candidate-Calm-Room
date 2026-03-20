"use client";

export default function ExitModal({
  open,
  onConfirm,
  onCancel
}: {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[9999] bg-black/70 backdrop-blur-md flex items-center justify-center">

      <div className="w-[420px] rounded-2xl border border-white/10 bg-black/80 p-8 text-center">

        <div className="text-lg mb-3">
          Exit Interview?
        </div>

        <div className="text-sm text-white/50 mb-6">
          This will end your session permanently.
        </div>

        <div className="flex gap-4 justify-center">

          <button
            onClick={onCancel}
            className="
            px-6 py-2 rounded-full
            border border-white/20
            text-white/70
            hover:bg-white/10
            transition
            "
          >
            Continue
          </button>

          <button
            onClick={onConfirm}
            className="
            px-6 py-2 rounded-full
            bg-red-500/80
            text-white
            hover:bg-red-500
            transition
            "
          >
            Exit
          </button>

        </div>

      </div>
    </div>
  );
}