"use client";

type Props = {
  question: string;
  questionType?: string | null;
};

export default function QuestionRenderer({ question }: Props) {
  return (
    <section className="mt-5 w-full px-6">
      <p className="mx-auto max-w-3xl text-center text-sm leading-6 text-slate-100 [text-shadow:0_2px_18px_rgba(0,0,0,0.55)] sm:text-base">
        {question}
      </p>
    </section>
  );
}
