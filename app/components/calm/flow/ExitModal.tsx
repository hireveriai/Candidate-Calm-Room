"use client";

export default function ExitModal({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="bg-[#111827] p-6 rounded-xl text-white max-w-sm w-full">
        <h2 className="text-lg mb-2">Exit Interview?</h2>
        <p className="text-sm text-gray-400 mb-4">
          This will end your session and cannot be resumed.
        </p>

        <div className="flex justify-end gap-3">
          <button onClick={onCancel} className="text-gray-300">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="bg-red-500 px-4 py-2 rounded"
          >
            Yes, Exit
          </button>
        </div>
      </div>
    </div>
  );
}