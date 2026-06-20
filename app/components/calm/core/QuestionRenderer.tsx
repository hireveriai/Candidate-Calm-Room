"use client";

type Props = {
  question: string;
  questionType?: string | null;
};

export default function QuestionRenderer({ question }: Props) {
  return (
    <section className="w-full">
      <p className="mb-3 text-[10px] font-medium uppercase tracking-[0.2em] text-sky-300/70">
        Interview question
      </p>
      <p className="text-[17px] font-medium leading-7 tracking-[-0.01em] text-slate-50 sm:text-[19px] sm:leading-8">
        {question}
      </p>
    </section>
  );
}
