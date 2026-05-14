"use client";

type Props = {
  question: string;
  questionType?: string | null;
};

export default function QuestionRenderer({ question }: Props) {
  return (
    <section className="mt-5 w-full px-4">
      <div className="mx-auto w-full max-w-3xl rounded-lg border border-white/10 bg-slate-950/45 px-5 py-4 shadow-[0_18px_60px_rgba(2,6,23,0.35)] backdrop-blur-md sm:px-6">
        <p className="text-center text-sm leading-6 text-slate-100 sm:text-base">
          {question}
        </p>
      </div>
    </section>
  );
}
