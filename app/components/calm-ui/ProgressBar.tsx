export default function ProgressBar() {
  return (
    <div className="w-full h-[4px] bg-white/10 rounded-full overflow-hidden">
      <div className="h-full w-[30%] bg-white rounded-full transition-all" />
    </div>
  );
}