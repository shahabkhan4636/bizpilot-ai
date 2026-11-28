"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { sendLeadHunterMessage } from "@/app/chat/[slug]/actions";

type Message = { role: "user" | "assistant"; content: string };

const OPENER = "Hey! Quick question — are you looking to get more clients this month?";

/**
 * The public chat widget. Everything sensitive stays on the server: this component
 * only ever sees the visible reply, never the score or the lead JSON.
 */
export function LeadHunterChat({ slug, businessName }: { slug: string; businessName: string }) {
  const [messages, setMessages] = useState<Message[]>([{ role: "assistant", content: OPENER }]);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();
  const scroller = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [messages, pending, error]);

  function send() {
    const text = input.trim();
    if (!text || pending || done) return;
    const next: Message[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setInput("");
    setError(null);
    startTransition(async () => {
      const result = await sendLeadHunterMessage(slug, next);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMessages((current) => [...current, { role: "assistant", content: result.reply }]);
      if (result.done) setDone(true);
    });
  }

  return (
    <div className="flex h-[min(78vh,640px)] flex-col overflow-hidden rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--surface))] shadow-sm">
      <div className="flex items-center gap-2 border-b border-[hsl(var(--border))] px-4 py-3">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-600 text-sm font-bold text-white">B</span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{businessName}</p>
          <p className="text-xs text-[hsl(var(--fg-muted))]">AI assistant · replies in seconds</p>
        </div>
      </div>

      <div ref={scroller} className="flex-1 space-y-3 overflow-y-auto p-4" aria-live="polite">
        {messages.map((message, index) => (
          <div key={index} className={message.role === "user" ? "flex justify-end" : "flex justify-start"}>
            <p
              className={
                message.role === "user"
                  ? "max-w-[85%] rounded-2xl rounded-be-md bg-brand-600 px-3.5 py-2 text-sm text-white"
                  : "max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bs-md bg-[hsl(var(--muted))] px-3.5 py-2 text-sm"
              }
            >
              {message.content}
            </p>
          </div>
        ))}
        {pending ? (
          <div className="flex justify-start">
            <p className="rounded-2xl bg-[hsl(var(--muted))] px-3.5 py-2 text-sm text-[hsl(var(--fg-muted))]">typing…</p>
          </div>
        ) : null}
        {error ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </div>
        ) : null}
      </div>

      <form
        className="flex items-center gap-2 border-t border-[hsl(var(--border))] p-3"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          maxLength={800}
          disabled={pending || done}
          placeholder={done ? "Chat finished — the team will follow up." : "Type your answer…"}
          aria-label="Your message"
          className="flex h-11 w-full min-w-0 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--surface))] px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={pending || done || input.trim().length === 0}
          className="inline-flex h-11 shrink-0 items-center justify-center rounded-lg bg-brand-600 px-4 text-sm font-medium text-white disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </div>
  );
}
