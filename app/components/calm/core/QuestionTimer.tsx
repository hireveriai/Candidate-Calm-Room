"use client";

type Props = {
  timeLeft: number;
};

export default function QuestionTimer({ timeLeft }: Props) {
  return (
    <div className="absolute top-4 left-4 text-xs text-gray-400 tracking-wide">
      {timeLeft}s
    </div>
  );
}